import type { ExtensionAPI, ExtensionContext, ToolDefinition, Theme } from "@earendil-works/pi-coding-agent";
import { keyText, loadSkills } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOLS, SPAWNING_TOOLS, THINKING_LEVELS, validateLoadout } from "./loadout.ts";
import { Type, type Static, type TSchema } from "typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  getMuxBackend,
  createSurface,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
  createSurfaceRenameContext,
  TERMINAL_RENAME_CONTEXT_ENV,
  surfaceState,
  type SurfaceState,
} from "@kevinhao/pi-terminal-mux";

import { SubagentRuns, normalizeSubagentName, projectRun, writerExited, readCheckpoint, readControl, type SubagentRun } from "./runs.ts";
import { SubagentInbox } from "./inbox.ts";
import { SubagentNotifications } from "./notifications.ts";
import {
  getSessionId,
  readSubagentLoadout,
  seedSubagentSessionFile,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import { readSubagentOutcomes, writeSubagentOutcome, processExitFile, type SubagentOutcome } from "./outcome.ts";
import {
  getSubagentActivityFile,
  readSubagentLiveness,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

interface ParentRuntime {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  abort: AbortController;
  notifications: SubagentNotifications;
  observed: Set<string>;
  restoring: Set<string>;
  leaving: boolean;
}
let runtime: ParentRuntime | null = null;
function assertRuntime(owner: ParentRuntime | null): asserts owner is ParentRuntime {
  if (!owner || runtime !== owner || owner.abort.signal.aborted) throw new Error("Parent runtime detached; no further subagent mutation accepted");
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Readable name within this parent session (1–64 characters). Defaults to the role name; normalized and suffixed on collision. " +
        "The acknowledgement returns the actual assigned name and stable id.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. The child's validated
   * loadout pins this policy; environment variables cannot expand it.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noContextFiles?: boolean;
  configurationError?: string;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
  sourcePath: string;
  sourceRoot: string;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it. Mirrors the legacy
// `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which simply won't be granted).
 */
function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // The four spawning tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  const registered = EXTRA_TOOL_EXTENSIONS.get(tool);
  if (registered) return registered;
  // Resolve declared runtime resources from this installation, never from an
  // author's personal extension directory. Both tools belong to one extension.
  if (tool === "web_search" || tool === "web_fetch") {
    return fileURLToPath(import.meta.resolve("@kevinhao/pi-web-search"));
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  const builtin = Object.hasOwn(map, tool) ? map[tool] : undefined;
  return builtin && existsSync(builtin) ? builtin : undefined;
}

/** Managed callers derive authority from their validated snapshot, never ambient grants. */
function callerLoadout(): SubagentLoadout | null {
  const session = process.env.PI_SUBAGENT_SESSION;
  if (!session) return null;
  const loadout = readSubagentLoadout(session);
  if (!loadout) throw new Error("Cannot verify the calling subagent's loadout; delegate a fresh named role");
  return loadout;
}

function delegationError(agent: string | undefined): string | null {
  if (!agent) return "A named agent role is required";
  const caller = callerLoadout();
  if (!caller) return null;
  if (agent === caller.agent) return `Self-delegation to "${agent}" is blocked`;
  if (!caller.spawnable.includes(agent)) return `Agent "${agent}" is not in your pinned delegation allowlist`;
  return null;
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:[\\t ]*([^\\r\\n]*)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");
  const invalid = ["auto-exit", "interactive", "disable-model-invocation", "no-skills", "no-prompt-templates", "no-context-files"].find((key) => {
    const value = getFrontmatterValue(frontmatter, key);
    return value !== undefined && value !== "true" && value !== "false";
  });
  const invalidMode = (systemPromptMode !== undefined && !["append", "replace"].includes(systemPromptMode)) ||
    (getFrontmatterValue(frontmatter, "session-mode") !== undefined && !parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")));

  return {
    configurationError: invalid ? `Invalid boolean: ${invalid}` : invalidMode ? "Invalid role prompt/session mode" : undefined,
    noSkills: parseOptionalBoolean(getFrontmatterValue(frontmatter, "no-skills")),
    noPromptTemplates: parseOptionalBoolean(getFrontmatterValue(frontmatter, "no-prompt-templates")),
    noContextFiles: parseOptionalBoolean(getFrontmatterValue(frontmatter, "no-context-files")),
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(cwd = process.cwd()): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(cwd, ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, {
        ...parsed, source, sourcePath: resolve(dir, file),
        sourceRoot: source === "project" ? resolve(cwd) : source === "global" ? resolve(getAgentConfigDir()) : resolve(SUBAGENTS_DIR, "../.."),
      });
    }
  }

  const caller = callerLoadout();
  const all = [...agents.values()];
  return caller ? all.filter((a) => a.name !== caller.agent && caller.spawnable.includes(a.name)) : all;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: ListedAgentDefinition,
  parentCwd: string,
): { effectiveCwd: string; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs.cwd;
  const base = params.cwd !== undefined ? parentCwd : agentDefs.sourceRoot;
  const effectiveCwd = realpathSync(rawCwd !== undefined ? resolve(base, rawCwd) : resolve(parentCwd));
  const localAgentDir = join(effectiveCwd, ".pi", "agent");
  const effectiveAgentDir = existsSync(localAgentDir) ? localAgentDir : resolve(getAgentConfigDir());
  mkdirSync(effectiveAgentDir, { recursive: true });
  return { effectiveCwd, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? true);
}

function loadAgentDefaults(agentName: string, cwd = process.cwd()): ListedAgentDefinition | null {
  return discoverAgentDefinitions(cwd).find((agent) => agent.name === agentName) ?? null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx (capacity unknown)`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** Render with the host theme on every pass; never retain a fixed ANSI palette. */
function widgetIcon(kind: StatusSnapshot["kind"], theme?: Pick<Theme, "fg">): string {
  const active = kind === "active" || kind === "running" || kind === "stalled";
  const icon = active ? "⟳" : "○";
  return theme?.fg(kind === "stalled" ? "error" : active ? "warning" : "dim", icon) ?? icon;
}

/** Prepare the entire launch before asking mux to create an owned surface. */
function createSubagentSurface(name: string, command: string, scriptPath: string, sessionFile: string, executionId: string): string {
  mkdirSync(dirname(scriptPath), { recursive: true });
  const renameContext = JSON.stringify(createSurfaceRenameContext(""));
  writeFileSync(scriptPath, [
    "#!/bin/bash",
    // Native creation sets the child's own terminal identity. Never inherit the
    // parent's surface or rename authority, including on nested launch/resume.
    'export PI_SUBAGENT_SURFACE="${TMUX_PANE:-${ORCA_TERMINAL_HANDLE:-}}"',
    `export ${TERMINAL_RENAME_CONTEXT_ENV}=${shellEscape(renameContext)}`,
    command,
    "",
  ].join("\n"), { mode: 0o700 });
  try {
    return createSurface(name, { command: `bash ${shellEscape(scriptPath)}` });
  } catch (cause) {
    const diagnostic = cause instanceof Error ? cause.message : String(cause);
    // An errored/ambiguous backend receipt has no usable handle. Never submit
    // the startup command twice or pretend an unidentified surface was closed.
    const file = `${sessionFile}.terminal-${executionId}.json`;
    writeFileSync(file, JSON.stringify({ executionId, name, sessionFile, launchScriptFile: scriptPath,
      phase: "create-failed", inventory: "unknown", closure: "unconfirmed", diagnostic }), "utf8");
    throw Object.assign(new Error(`${diagnostic.slice(0, 2000)}\nNative creation was not retried; inspect ${file}.`), {
      details: { launchScriptFile: scriptPath, sessionFile, terminalRecordFile: file, closure: "unconfirmed" },
    });
  }
}

function hasSupportedParentTerminal(): boolean {
  const backend = getMuxBackend();
  return backend === "tmux" ? !!process.env.TMUX_PANE : backend === "orca" ? !!process.env.ORCA_TERMINAL_HANDLE : false;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Subagents require a parent terminal inside tmux or Orca; headless delegation is not supported by this extension.",
      },
    ],
    isError: true,
    details: { error: "unsupported terminal environment" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

// Supported Pi marks every resolved execute() as successful, regardless of a
// returned isError flag. Keep refusal handling at the native management boundary
// so launch, resume and delivery errors all use Pi's actual exception contract.
function registerManagementTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  tool: ToolDefinition<TParams, TDetails>,
): void {
  pi.registerTool<TParams, TDetails>({
    ...tool,
    async execute(...args) {
      if ((tool.name === "subagent" || tool.name === "subagent_message" || tool.name === "subagent_stop") && runtime && runtime.pi !== pi) {
        throw new Error("Stale parent tool runtime; no mutation accepted");
      }
      const result = await tool.execute(...args);
      if ("isError" in result && result.isError === true) {
        throw new Error(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
      }
      return result;
    },
    renderResult: tool.renderResult && ((result, options, theme, context) => {
      // Pi's exception result contains content but no original details. In
      // particular, listing errors must not become "No definitions found".
      if (context?.isError) {
        const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
        return new Text(theme.fg("error", text), 0, 0);
      }
      return tool.renderResult!(result, options, theme, context);
    }),
  });
}

function runsFor(ctx: Pick<ExtensionContext, "sessionManager">): SubagentRuns {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("No persistent parent session; subagent ownership cannot be established");
  return new SubagentRuns(ctx.sessionManager.getSessionId(), file, ctx.sessionManager.getSessionDir());
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage" | "outcome" | "resultFile" | "source"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
  const fullRef = result.resultFile ? `\n\nFull result: ${result.resultFile}` : "";
  const preview = result.summary.length > 6500
    ? `${result.summary.slice(0, 6500)}\n[Output preview truncated; read the full result.]`
    : result.summary;
  const diagnostic = result.errorMessage ? `Error: ${result.errorMessage.slice(0, 1000)}\n\n` : "";
  const label = result.outcome === "aborted" ? "aborted"
    : result.outcome === "truncated" ? "truncated"
    : result.outcome === "no-output" ? "settled without new output"
    : result.source?.kind === "surface_absent" ? "interrupted (surface disappeared)"
    : result.source?.kind === "process_exit" ? "failed before settlement"
    : result.exitCode !== 0 || result.errorMessage ? "failed after final settlement" : "completed";
  return `Sub-agent "${name}" ${label} (${formatElapsed(result.elapsed)}).\n\n${diagnostic}${preview}${fullRef}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Diagnostic from the final settled outcome, never a transient run end. */
  errorMessage?: string;
  outcome?: SubagentOutcome["outcome"];
  resultFile?: string;
  source?: SubagentOutcome["source"];
  sequence?: number;
  keepAlive?: boolean;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  usage?: SubagentOutcome["usage"];
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  owner?: ParentRuntime;
  observing?: boolean;
  backend?: string;
  id: string;
  subagentId?: string;
  generation?: number;
  runs?: SubagentRuns;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Settled resident surfaces are live, but have no outstanding delegated work. */
  settled?: boolean;
  lifecycle?: SubagentRun["state"] | "paused-uncertain";
  lastResultSequence?: number;
  terminalState?: SurfaceState;
  lastInventoryAt?: number;
  closure?: "confirmed" | "unconfirmed";
  closing?: boolean;
  launchError?: string;
  uncertaintyNotified?: string;
}

const READY_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fencedCommand(command: string, run: SubagentRun): string {
  return [process.execPath, join(SUBAGENTS_DIR, "writer.mjs"), run.sessionFile, run.executionId, run.writerToken, command].map(shellEscape).join(" ");
}
function isCurrent(running: RunningSubagent): boolean {
  return (!running.owner || (runtime === running.owner && !running.owner.abort.signal.aborted && (!running.observing || running.owner.notifications.owns()))) &&
    (!running.runs || (running.runs.current(running.subagentId!, running.generation!) &&
      !running.runs.resolve({ id: running.subagentId }).control));
}
function forgetRunning(running: RunningSubagent): void {
  if (runningSubagents.get(running.id) === running) runningSubagents.delete(running.id);
}

function terminalRecordFile(running: RunningSubagent): string {
  return `${running.sessionFile}.terminal-${running.id}.json`;
}

/** Small retained terminal diagnostic, not a second lifecycle/run store. */
function recordTerminal(running: RunningSubagent, phase: string, diagnostic?: string): void {
  if (!isCurrent(running)) return;
  running.runs?.update(running.subagentId!, running.generation!, {
    ...(running.closure ? { closure: running.closure } : {}), ...(diagnostic ? { diagnostic } : {}),
  });
  const file = terminalRecordFile(running);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify({
    executionId: running.id, name: running.name, surface: running.surface,
    sessionFile: running.sessionFile, launchScriptFile: running.launchScriptFile,
    phase, inventory: running.terminalState ?? "unknown", closure: running.closure,
    diagnostic, observedAt: Date.now(),
  }), "utf8");
  renameSync(temporary, file);
}

async function closeOwnedSurface(running: RunningSubagent): Promise<void> {
  if (!isCurrent(running) || running.closure === "confirmed") return;
  running.closing = true;
  // Settlement is not process exit: trusted extensions may still be doing
  // asynchronous shutdown work. Never kill the writer's exit witness to clean
  // up its surface. A bounded unknown remains retained and can be reconciled.
  if (running.settled) {
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (!existsSync(processExitFile(running.sessionFile, running.id)) && Date.now() < deadline) {
      await delay(25);
      if (!isCurrent(running)) return;
    }
    if (!existsSync(processExitFile(running.sessionFile, running.id))) {
      running.closure = "unconfirmed";
      recordTerminal(running, "closure-unconfirmed", "Writer exit not yet witnessed; shutdown surface and wrapper retained, no forced close or ownership reclaim");
      return;
    }
  }
  if (!isCurrent(running) || (running.backend && running.backend !== getMuxBackend())) return;
  let diagnostic: string | undefined;
  running.terminalState = surfaceState(running.surface);
  if (running.terminalState === "unknown") {
    running.closure = "unconfirmed";
    recordTerminal(running, "closure-unconfirmed", "Terminal inventory unknown; no close attempted");
    return;
  }
  if (running.terminalState === "present") {
    try { closeSurface(running.surface); }
    catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
  }
  const deadline = Date.now() + CLOSE_TIMEOUT_MS;
  for (;;) {
    if (!isCurrent(running)) return;
    running.terminalState = surfaceState(running.surface);
    if (running.terminalState === "absent") {
      running.closure = "confirmed";
      recordTerminal(running, "closed");
      return;
    }
    if (Date.now() >= deadline) break;
    await delay(250);
  }
  running.closure = "unconfirmed";
  recordTerminal(running, "closure-unconfirmed", diagnostic ?? `Closure deadline exceeded; inventory=${running.terminalState}`);
}

/** Creation acceptance is not child readiness, and neither is task completion. */
async function confirmSubagentReady(running: RunningSubagent): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  try {
    recordTerminal(running, "starting");
    for (;;) {
      if (!isCurrent(running)) throw new Error("Parent observer detached during startup; child and ownership retained");
      running.terminalState = surfaceState(running.surface);
      const exited = existsSync(processExitFile(running.sessionFile, running.id));
      // Native inventory can outlast the entire child run. Sample readiness and
      // durable settlement after absence/exit so fast completion wins that race.
      if (readSubagentLiveness(running.sessionFile, running.id) !== null || readSubagentOutcomes(running.sessionFile, running.id, running.lastResultSequence, running.generation).length) {
        recordTerminal(running, "ready");
        return;
      }
      if (running.terminalState === "absent") throw new Error("Surface disappeared before the child-ready signal");
      if (exited) throw new Error("Child process exited before its ready signal");
      if (Date.now() >= deadline) throw new Error(`Child readiness deadline exceeded (${READY_TIMEOUT_MS}ms; inventory=${running.terminalState})`);
      await delay(250);
    }
  } catch (cause) {
    if (!isCurrent(running)) throw cause;
    running.launchError = cause instanceof Error ? cause.message : String(cause);
    await closeOwnedSurface(running);
    if (running.closure === "confirmed") forgetRunning(running);
    const error = `${running.launchError}; startup cleanup ${running.closure}. Diagnostic: ${terminalRecordFile(running)}`;
    throw Object.assign(new Error(error), { details: {
      id: running.id, name: running.name, surface: running.surface,
      sessionFile: running.sessionFile, launchScriptFile: running.launchScriptFile,
      terminalRecordFile: terminalRecordFile(running), closure: running.closure,
    } });
  }
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "│";

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `│${truncRight}${" ".repeat(rightPad)}│`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `│${truncLeft}${" ".repeat(pad)}${right}│`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `╭${content}╮`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";

  const inner = Math.max(0, width - 2);
  return `╰${"─".repeat(inner)}╯`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number, theme?: Pick<Theme, "fg">): string[] {
  const title = "Subagents";
  const info = `${agents.filter((agent) => !agent.settled).length} running`;

  const lines: string[] = [theme?.fg("accent", borderTop(title, info, width)) ?? borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind, theme);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right = agent.settled ? ` ${agent.lifecycle ?? "completed"} ` : agent.closure === "unconfirmed"
      ? " closure unconfirmed "
      : statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(theme?.fg("accent", borderBottom(width)) ?? borderBottom(width));
  return lines;
}

function widgetAgents(): RunningSubagent[] {
  if (!latestCtx?.sessionManager.getSessionFile()) return [];
  const runs = runsFor(latestCtx);
  return runs.list().map(projectRun).filter((run) => run.control || run.closure !== "confirmed" || run.state === "running" || run.state === "starting").map((run) => {
    const local = [...runningSubagents.values()].find((child) => child.subagentId === run.id && child.generation === run.generation);
    const child: RunningSubagent = local ? { ...local } : {
      id: run.executionId, subagentId: run.id, generation: run.generation, runs,
      name: run.name, task: "", agent: run.loadout?.agent, surface: run.surface ?? "",
      sessionFile: run.sessionFile, startTime: run.startTime,
      activityFile: getSubagentActivityFile(runs.directory, run.executionId),
      interactive: run.loadout?.interactive ?? false,
      statusState: createStatusState({ source: "pi", startTimeMs: run.startTime }),
      terminalState: "unknown",
    };
    child.settled = !["starting", "running"].includes(run.state);
    child.lifecycle = run.control?.kind !== "stop" && new SubagentInbox(run.sessionFile).snapshot(run).paused ? "paused-uncertain" : run.state;
    if (!local) observeRunningSubagent(child);
    return child;
  });
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;
  const agents = widgetAgents();
  if (agents.length === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, theme: Theme) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(agents, width, theme);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;

  if (effectiveTools === undefined) throw new Error("Role must explicitly declare tools (use tools: for no business tools)");

  const allow = new Set(requested);
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Apply a loadout snapshot's restrictions to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's loadout,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  validateLoadout(loadout);
  parts.push("--model", shellEscape(loadout.model), "--thinking", loadout.thinking);

  if (loadout.identity && loadout.systemPromptMode !== "task") {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  // Replay pinned references, never the current parent's extension lookup.
  parts.push("--no-extensions", "--tools", shellEscape(loadout.toolAllowlist));
  for (const path of new Set(Object.values(loadout.extensions))) parts.push("-e", shellEscape(path));
  if (loadout.isolation.skills) parts.push("--no-skills");
  if (loadout.isolation.promptTemplates) parts.push("--no-prompt-templates");
  if (loadout.isolation.contextFiles) parts.push("--no-context-files");
  for (const skill of loadout.skills) parts.push("--skill", shellEscape(skill.path));
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;
  running.statusState = {
    ...running.statusState,
    livenessAtMs: readSubagentLiveness(running.sessionFile, running.id),
    terminalState: running.terminalState,
  };

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function terminalDeliveryError(running: RunningSubagent): string | null {
  running.terminalState = surfaceState(running.surface);
  if (running.launchError || running.closing || running.terminalState !== "present") {
    return `Cannot deliver to "${running.name}": terminal state is ${running.terminalState}, ` +
      `or launch/closure remains uncertain. No replacement was started; history and ownership are retained. ` +
      `Inspect ${terminalRecordFile(running)}.`;
  }
  return null;
}

/**
 * Legacy Claude-only transport. Managed Pi instructions never use terminal keys.
 */
function legacyTerminalMessage(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via tmux: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (statusInterval || !runtime) return;
  const owner = runtime;

  statusInterval = setInterval(() => {
    if (runtime !== owner || owner.abort.signal.aborted) return;
    try {
      reconnectObservers(owner);
      owner.notifications.deliver(pi);
    } catch (error) { console.error("Subagent recovery failed:", error); }
    if (!owner.notifications.owns()) return;

    let notificationsPending = false;
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      if (!isCurrent(running) || running.settled) continue;
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive && (statusConfig.enabled || snapshot.statusLabel?.includes("uncertain") || transition === "recovered")) {
        const lines = [formatTransitionLine(running.name, snapshot, transition)];
        // The retained evidence, not a reload timestamp or batch grouping,
        // identifies this transition. A later heartbeat/activity can identify
        // another stall/recovery without replaying the unchanged old one.
        const evidence = [running.id, running.generation, transition, snapshot.kind,
          nextState.lastActivitySequence, nextState.livenessAtMs, nextState.snapshotState];
        const eventId = `subagent-status:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`;
        const capped = capStatusLines(lines, statusConfig.lineLimit);
        owner.notifications.publish({ customType: "subagent_status", content: formatStatusAggregate(lines, statusConfig.lineLimit), display: true,
          details: { eventId, id: running.subagentId, generation: running.generation, lines: capped.visibleLines, overflow: capped.overflow } });
        notificationsPending = true;
      }
      running.statusState = nextState;
    }

    if (shouldRefreshWidget) updateWidget();
    if (notificationsPending) owner.notifications.deliver(pi);
  }, 1000);

  statusInterval.unref?.();
  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export const __test__ = {
  borderLine,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  formatElapsed,
  formatTokens,
  formatUsageSegments,
  widgetIcon,
};

function startWidgetRefresh() {
  if (widgetInterval || !runtime) return;
  const owner = runtime;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    if (runtime !== owner || owner.abort.signal.aborted) return;
    updateWidget();
  }, 1000);
  widgetInterval.unref?.();
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

function resolveLoadout(
  params: Static<typeof SubagentParams>,
  role: ListedAgentDefinition,
  ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">,
  parentThinking: string,
  cwd: string,
  agentDir: string,
): SubagentLoadout {
  if (role.configurationError) throw new Error(`${role.name}: ${role.configurationError}`);
  if (role.cli !== undefined && role.cli !== "pi") throw new Error(`Unknown role CLI: ${role.cli}`);
  const toolAllowlist = buildSubagentToolAllowlist(role.tools, { grantSpawning: !!role.subagentAgents?.length });
  const extensions: Record<string, string> = {};
  for (const tool of toolAllowlist.split(",")) {
    if (BUILTIN_TOOLS.has(tool)) continue;
    const path = tool === "ask_question" ? join(SUBAGENTS_DIR, "subagent-done.ts") : getToolExtensionPath(tool);
    if (!path) throw new Error(`Unknown tool or unavailable extension: ${tool}`);
    extensions[tool] = resolve(path);
  }
  const override = params.model ?? role.model;
  const matches = override ? ctx.modelRegistry.getAll().filter((model) => model.id === override || `${model.provider}/${model.id}` === override) : [];
  const model = override ? (matches.length === 1 ? matches[0] : undefined) : ctx.model;
  if (!model) throw new Error(`Unknown or ambiguous model for role "${role.name}"; use an exact provider/model ID`);
  const thinking = role.thinking ?? parentThinking;
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new Error(`Invalid thinking level: ${thinking}`);
  const available = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
  const skills = (role.skills ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((name) => {
    const found = available.find((skill) => skill.name === name) ?? loadSkills({ cwd, agentDir, skillPaths: [resolve(role.sourceRoot, name)], includeDefaults: false }).skills[0];
    if (!found) throw new Error(`Unavailable skill: ${name}`);
    return { name: found.name, path: resolve(found.filePath) };
  });
  return validateLoadout({
    version: 1, agent: role.name, toolAllowlist, extensions,
    model: `${model.provider}/${model.id}`, thinking,
    identity: role.body ?? null, systemPromptMode: role.systemPromptMode ?? "task",
    spawnable: role.subagentAgents ?? [], autoExit: role.autoExit ?? true,
    interactive: resolveEffectiveInteractive(params, role), cwd, agentDir, skills,
    isolation: { skills: role.noSkills ?? false, promptTemplates: role.noPromptTemplates ?? false, contextFiles: role.noContextFiles ?? false },
    source: { kind: role.source, path: role.sourcePath, root: role.sourceRoot },
    sessionMode: role.sessionMode ?? "standalone",
  });
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: Static<typeof SubagentParams> & { name: string },
  ctx: Pick<ExtensionContext, "sessionManager" | "cwd" | "model" | "modelRegistry">,
  options: { definition: ListedAgentDefinition; thinking: string },
): Promise<RunningSubagent> {
  const owner = runtime;
  assertRuntime(owner);
  const startTime = Date.now();
  const id = randomUUID();

  const agentDefs = options.definition;
  const effectiveModel = params.model ?? agentDefs.model;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const effectiveAutoExit = agentDefs?.autoExit ?? true;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs, ctx.cwd);
  const targetCwdForSession = effectiveCwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const subagentSessionFile = join(sessionDir, `${timestamp}_${id}.jsonl`);

  // Validate and persist permissions before creating a runnable child.
  const loadout = agentDefs.cli === "claude" ? null : resolveLoadout(params, agentDefs, ctx, options.thinking, effectiveCwd, effectiveAgentDir);
  const runs = runsFor(ctx);
  const record = runs.reserve({ name: params.name, sessionFile: subagentSessionFile, sessionId: null,
    executionId: id, loadout, backend: getMuxBackend()!, startTime });
  params.name = record.name;
  try {
    if (loadout) writeSubagentLoadout(subagentSessionFile, loadout);

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);
    if (launchBehavior.seededSessionMode) {
      seedSubagentSessionFile({
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: sessionFile,
        childSessionFile: subagentSessionFile,
        childCwd: targetCwdForSession,
        ...(launchBehavior.seededSessionMode === "fork" ? { parentBranch: ctx.sessionManager.getBranch() } : {}),
      });
    }

    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });
    const { inheritsConversationContext } = launchBehavior;

    // Blank-session modes need wrapper instructions and artifact-backed handoff.
    const modeHint = effectiveAutoExit
      ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
      : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
    const summaryInstruction = effectiveAutoExit
      ? "Your FINAL assistant message should summarize what you accomplished."
      : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
    const identity = agentDefs.body ?? null;
    const identityInSystemPrompt = agentDefs.systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = inheritsConversationContext
      ? `${roleBlock}\n\n${params.task}`.trim()
      : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

    // Claude retains its legacy execution path, not managed-Pi writer guarantees.
    if (agentDefs.cli === "claude") {
      const sentinelFile = `/tmp/pi-claude-${id}-done`;
      const pluginDir = join(SUBAGENTS_DIR, "plugin");
      const cmdParts = [`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`, "claude", "--dangerously-skip-permissions"];
      if (existsSync(pluginDir)) cmdParts.push("--plugin-dir", shellEscape(pluginDir));
      if (effectiveModel) cmdParts.push("--model", shellEscape(effectiveModel));
      if (agentDefs.body) cmdParts.push("--append-system-prompt", shellEscape(agentDefs.body));
      cmdParts.push(shellEscape(params.task));
      const command = `cd ${shellEscape(effectiveCwd)} && ${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
      const launchScriptFile = join(artifactDir, "subagent-scripts", `${record.id}-${id}.sh`);
      const surface = createSubagentSurface(params.name, command, launchScriptFile, subagentSessionFile, id);
      const running: RunningSubagent = {
        owner, backend: record.backend,
        id, subagentId: record.id, generation: record.generation, runs,
        name: params.name, task: params.task, agent: params.agent, surface, startTime,
        sessionFile: subagentSessionFile, launchScriptFile, cli: "claude", sentinelFile,
        interactive: effectiveInteractive,
        statusState: createStatusState({ source: "claude", startTimeMs: startTime }),
      };
      runningSubagents.set(id, running);
      runs.update(record.id, record.generation, { surface, state: "running" });
      return running;
    }

    if (!loadout) throw new Error("Missing managed Pi loadout");
    const parts = ["pi", "--session", shellEscape(subagentSessionFile)];
    // Fresh and resumed writers replay the same default-deny launch policy.
    applySandboxToParts(parts, loadout, { artifactDir, name: `${record.id}-${id}` });
    const envParts = [
      `PI_CODING_AGENT_DIR=${shellEscape(loadout.agentDir)}`,
      `PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`,
      `PI_SUBAGENT_NAME=${shellEscape(params.name)}`,
      `PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`,
      `PI_SUBAGENT_AUTO_EXIT=${loadout.autoExit ? "1" : "0"}`,
      `PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`,
      `PI_SUBAGENT_ID=${shellEscape(id)}`,
      "PI_SUBAGENT_INBOX_ONLY=0",
      `PI_SUBAGENT_RUN_ID=${shellEscape(record.id)}`,
      `PI_SUBAGENT_GENERATION=${record.generation}`,
      `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`,
    ];
    let taskArg = fullTask;
    if (launchBehavior.taskDelivery === "artifact") {
      const artifactPath = join(artifactDir, "context", `${record.id}-${id}.md`);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, fullTask, "utf8");
      taskArg = `@${artifactPath}`;
    }
    for (const promptArg of buildPiPromptArgs({
      effectiveSkills: loadout.skills.map((skill) => skill.name).join(","),
      taskDelivery: launchBehavior.taskDelivery,
      taskArg,
    })) parts.push(shellEscape(promptArg));

    const piCommand = `cd ${shellEscape(effectiveCwd)} && ${envParts.join(" ")} ${parts.join(" ")}`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", `${record.id}-${id}.sh`);
    const surface = createSubagentSurface(params.name, fencedCommand(piCommand, record), launchScriptFile, subagentSessionFile, id);
    const running: RunningSubagent = {
      owner, backend: record.backend,
      id, subagentId: record.id, generation: record.generation, runs,
      name: params.name, task: params.task, agent: params.agent, surface, startTime,
      sessionFile: subagentSessionFile, launchScriptFile, activityFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
    };
    runningSubagents.set(id, running);
    runs.update(record.id, record.generation, { surface });
    await confirmSubagentReady(running);
    if (isCurrent(running)) runs.update(record.id, record.generation, { state: "running", sessionId: getSessionId(subagentSessionFile) });
    return running;
  } catch (cause) {
    if (runtime === owner && !owner.abort.signal.aborted) runs.update(record.id, record.generation, { state: "failed", diagnostic: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  }
}

/**
 * Claude-only transcript retention. Managed Pi outcomes are published by the
 * child bridge and observed independently of the terminal surface.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/** Questions share the retained inbox and stable notification outbox. */
function deliverPendingQuestion(running: RunningSubagent): void {
  if (!isCurrent(running)) return;
  for (const question of new SubagentInbox(running.sessionFile).questions()) {
    if (question.state === "answered") continue;
    const reply = { id: running.subagentId, replyTo: question.questionId, message: "…" };
    running.owner!.notifications.publish({
      customType: "subagent_question",
      content: `Sub-agent ${JSON.stringify(running.name)} asks:\n\n${question.question}\n\nQuestion ID: ${question.questionId}\nReply with subagent_message(${JSON.stringify(reply)}). Ordinary messages do not answer this question.`,
      display: true,
      details: { eventId: question.eventId, id: running.subagentId, generation: running.generation,
        name: running.name, agent: running.agent, question: question.question, questionId: question.questionId },
    });
  }
  running.owner!.notifications.deliver(running.owner!.pi);
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult | null> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const observationSignal = AbortSignal.any([signal, running.owner!.abort.signal]);
    if (running.cli !== "claude") {
      for (;;) {
        observationSignal.throwIfAborted();
        if (!isCurrent(running)) return null;
        const inbox = new SubagentInbox(sessionFile).snapshot(running.runs?.resolve({ id: running.subagentId }));
        const uncertain = inbox.uncertainty ?? inbox.messages.find((message) => message.uncertainty)?.uncertainty;
        if (uncertain && running.uncertaintyNotified !== uncertain.actionId) {
          const line = `${name}: paused for uncertain action ${uncertain.actionId}. ${uncertain.reason} Ordinary follow-up/resume cannot authorize repetition. Reconcile, or obtain explicit user authorization and call subagent_message with authorization: { actionId, decision: "retry" | "confirm-completed", reason }.`;
          running.owner!.notifications.publish({ customType: "subagent_status", content: line, display: true,
            details: { id: running.subagentId, name, eventId: `subagent-uncertain:${uncertain.actionId}`, uncertainty: uncertain, lines: [line], overflow: 0 } });
          running.owner!.notifications.deliver(running.owner!.pi);
          running.uncertaintyNotified = uncertain.actionId;
        }
        deliverPendingQuestion(running);
        const published = readSubagentOutcomes(sessionFile, running.id, running.lastResultSequence, running.generation)[0];
        if (published) {
          const { result, resultFile } = published;
          const stats = result.usage?.generation;
          return {
            name, task, summary: result.output, sessionFile,
            sessionId: result.source.sessionId,
            exitCode: result.outcome === "succeeded" ? 0 : 1,
            elapsed: Math.floor((Date.now() - startTime) / 1000),
            outcome: result.outcome, resultFile, source: result.source, sequence: result.sequence,
            keepAlive: !result.autoExit || result.outcome === "aborted",
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            ...(stats ? { stats } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
          };
        }
        const now = Date.now();
        if (running.lastInventoryAt === undefined || now - running.lastInventoryAt >= 1_000) {
          const previous = running.terminalState;
          running.terminalState = running.backend === getMuxBackend() ? surfaceState(surface) : "unknown";
          running.lastInventoryAt = now;
          if (running.terminalState === "unknown" && previous !== "unknown") {
            recordTerminal(running, "inventory-unknown", "Terminal inventory unavailable; execution is uncertain, not absent");
            const line = `${name}: terminal inventory unknown; work is retained, no automatic restart or termination.`;
            running.owner!.notifications.publish({ customType: "subagent_status", content: line, display: true,
              details: { eventId: `subagent-inventory:${running.id}:${running.generation}`, id: running.subagentId, generation: running.generation, name, surface, inventory: "unknown", lines: [line], overflow: 0, terminalRecordFile: terminalRecordFile(running) },
            });
            running.owner!.notifications.deliver(running.owner!.pi);
          }
        }
        const exited = existsSync(processExitFile(sessionFile, running.id));
        if (exited || running.terminalState === "absent") {
          // Publication can race inventory/process observation. Durable results
          // always win, even after the surface is already gone.
          if (readSubagentOutcomes(sessionFile, running.id, running.lastResultSequence, running.generation).length > 0) continue;
          if (running.settled && running.lastResultSequence !== running.runs?.resolve({ id: running.subagentId }).resultAfterSequence) return null;
          const errorMessage = exited
            ? `Child process exited (${readFileSync(processExitFile(sessionFile, running.id), "utf8")}) without a durable settled result`
            : `Terminal surface ${surface} confirmed absent before settlement; delegated work was interrupted. History is retained; no automatic restart.`;
          writeSubagentOutcome({
            version: 1, executionId: running.id,
            sequence: Math.max(running.lastResultSequence ?? 0, readSubagentOutcomes(sessionFile, running.id).at(-1)?.result.sequence ?? 0) + 1,
            outcome: "failed",
            subagentId: running.subagentId, generation: running.generation,
            output: "", errorMessage, autoExit: true,
            source: {
              kind: exited ? "process_exit" : "surface_absent", sessionFile, sessionId: getSessionId(sessionFile) ?? running.id,
              entryId: null, leafId: null, stopReason: null, outputEntryIds: [],
            },
          });
          continue;
        }
        observeRunningSubagent(running);
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    }
    const result = await pollForExit(surface, observationSignal, {
      interval: 1000,
      sentinelFile: running.sentinelFile,
      onTick() {
        observeRunningSubagent(running);
        deliverPendingQuestion(running);
      },
    });

    if (!isCurrent(running)) return null;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      closeSurface(surface);
      runningSubagents.delete(running.id);

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    throw new Error("Unsupported subagent runtime");
  } catch (err: any) {
    // A storage/observation failure is not proof that a managed child settled
    // or stopped. Preserve ownership and evidence instead of killing it.
    if (running.cli !== "claude") {
      if (signal.aborted || !isCurrent(running)) return null;
      throw err;
    }
    if (!isCurrent(running)) return null;
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

async function reconcileClosure(pi: ExtensionAPI, running: RunningSubagent): Promise<void> {
  await closeOwnedSurface(running);
  if (!isCurrent(running)) { forgetRunning(running); return; }
  if (running.closure === "confirmed") {
    forgetRunning(running);
    const owner = running.owner!;
    const runs = running.runs;
    if (runs && !owner.leaving) {
      const record = runs.resolve({ id: running.subagentId });
      const inbox = new SubagentInbox(record.sessionFile);
      // An explicit instruction can outlast the caller's bounded closing wait.
      // Once exit AND closure are proven, give retained safe input a consumer.
      if (!record.control && writerExited(record) && !inbox.snapshot(record).paused && inbox.pending().length) {
        const loadout = readSubagentLoadout(record.sessionFile);
        if (!loadout) throw new Error("Queued continuation retained: recorded loadout is unavailable");
        const queued = inbox.enqueue(record, {}, () => {
          const target = runs.messageTarget(record.id);
          return target.launch ? { run: runs.resume(target.run.id, target.run.generation, loadout), launch: true } : target;
        });
        if (queued.launch) await launchRecorded(owner, runs, queued.run, "Retained queued follow-up");
      }
    }
  } else {
    // Retry observation, not termination, at the next reconciliation checkpoint.
    running.observing = false;
    running.owner!.observed.delete(`${running.id}:${running.generation}`);
    const line = `${running.name}: surface closure unconfirmed (inventory=${running.terminalState}); history and ownership retained.`;
    running.owner!.notifications.publish({ customType: "subagent_status", content: line, display: true,
      details: { eventId: `subagent-closure:${running.id}:${running.generation}`, id: running.subagentId, generation: running.generation, name: running.name, surface: running.surface, closure: running.closure,
        terminalRecordFile: terminalRecordFile(running), lines: [line], overflow: 0 },
    });
    running.owner!.notifications.deliver(pi);
  }
  updateWidget();
}

/** One observation and notification path for both fresh and resumed work. */
function startSubagentWatch(
  pi: ExtensionAPI,
  running: RunningSubagent,
): void {
  if (!isCurrent(running) || !running.owner?.notifications.owns() || running.owner.observed.has(`${running.id}:${running.generation}`)) return;
  running.observing = true;
  running.owner.observed.add(`${running.id}:${running.generation}`);
  // The tool's signal ends with its acknowledgement, not with delegated work.
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  startWidgetRefresh();
  startStatusRefresh(pi);

  void (async () => {
    for (;;) {
      const result = await watchSubagent(running, watcherAbort.signal);
      if (watcherAbort.signal.aborted || !isCurrent(running)) return;
      if (!result) {
        await reconcileClosure(pi, running);
        return;
      }
      if (running.runs && !running.runs.update(running.subagentId!, running.generation!, {
        state: result.outcome === "succeeded" || (!result.outcome && result.exitCode === 0) ? "completed" : result.outcome === "aborted" ? "aborted" : "failed",
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.resultFile ? { latestResult: { resultFile: result.resultFile, outcome: result.outcome!, sequence: result.sequence!, generation: running.generation! } } : {}),
      })) return;
      running.owner!.notifications.publish(
        {
          customType: "subagent_result",
          content: resolveResultPresentation(result, running.name),
          display: true,
          details: {
            eventId: `subagent-result:${running.subagentId ?? running.id}:${running.generation}:${running.id}:${result.sequence ?? 0}`,
            id: running.subagentId ?? running.id, generation: running.generation,
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            outcome: result.outcome,
            resultFile: result.resultFile,
            source: result.source,
            terminalRecordFile: terminalRecordFile(running),
            sessionFile: result.sessionFile,
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            ...(result.errorMessage ? { errorMessage: result.errorMessage.slice(0, 1000) } : {}),
            ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
            ...(result.stats ? { stats: result.stats } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
          },
        },
      );
      running.owner!.notifications.deliver(pi);
      // Dispatch is not persisted incorporation; notification evidence is retained.
      running.lastResultSequence = result.sequence;
      running.settled = true;
      if (!result.keepAlive) {
        // Closure is cleanup, never evidence that can reverse a durable outcome.
        if (running.cli !== "claude") await reconcileClosure(pi, running);
        updateWidget();
        return;
      }
      updateWidget();
    }
  })().catch((err) => {
    // Keep the result artifact and ownership when notification cannot be accepted.
    const diagnostic = `Subagent "${running.name}" result delivery failed: ${err?.message ?? String(err)}`;
    if (!isCurrent(running)) return;
    running.observing = false;
    running.owner?.observed.delete(`${running.id}:${running.generation}`);
    latestCtx?.ui.notify?.(diagnostic, "error");
    console.error(diagnostic);
  });
}

async function launchRecorded(owner: ParentRuntime, runs: SubagentRuns, record: SubagentRun, task: string) {
  assertRuntime(owner);
  if (owner.leaving) throw new Error("Parent is leaving; replacement writer retained for later recovery, not started");
  const loadout = record.loadout!;
  const id = record.executionId;
  const artifactDir = runs.directory;
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const parts = ["pi", "--session", shellEscape(record.sessionFile)];
  applySandboxToParts(parts, loadout, { artifactDir, name: `${record.id}-${id}` });
  const env = {
    PI_CODING_AGENT_DIR: loadout.agentDir, PI_SUBAGENT_ALLOWED: loadout.spawnable.join(","),
    PI_SUBAGENT_AGENT: loadout.agent, PI_SUBAGENT_NAME: record.name,
    PI_SUBAGENT_SESSION: record.sessionFile, PI_SUBAGENT_ID: id, PI_SUBAGENT_INBOX_ONLY: "1",
    PI_SUBAGENT_RUN_ID: record.id, PI_SUBAGENT_GENERATION: String(record.generation),
    PI_SUBAGENT_ACTIVITY_FILE: activityFile, PI_SUBAGENT_AUTO_EXIT: loadout.autoExit ? "1" : "0",
  };
  const command = fencedCommand(`cd ${shellEscape(loadout.cwd)} && ${Object.entries(env).map(([key, value]) => `${key}=${shellEscape(value)}`).join(" ")} ${parts.join(" ")}`, record);
  const launchScriptFile = join(artifactDir, "subagent-scripts", `${record.id}-resume-${id}.sh`);
  let surface: string;
  try { surface = createSubagentSurface(record.name, command, launchScriptFile, record.sessionFile, id); }
  catch (cause) {
    runs.update(record.id, record.generation, { state: "failed", diagnostic: String(cause) });
    throw cause;
  }
  const running: RunningSubagent = {
    owner, backend: record.backend, id, subagentId: record.id, generation: record.generation, runs,
    name: record.name, task, surface, startTime: record.startTime, sessionFile: record.sessionFile,
    agent: loadout.agent, launchScriptFile, activityFile, interactive: loadout.interactive,
    statusState: createStatusState({ source: "pi", startTimeMs: record.startTime }),
  };
  runningSubagents.set(id, running);
  runs.update(record.id, record.generation, { surface });
  try { await confirmSubagentReady(running); }
  catch (cause) {
    if (runtime === owner && !owner.abort.signal.aborted) runs.update(record.id, record.generation, { state: "failed", diagnostic: String(cause) });
    throw cause;
  }
  assertRuntime(owner);
  runs.update(record.id, record.generation, { state: "running" });
  startSubagentWatch(owner.pi, running);
  return { id: record.id, generation: record.generation, name: record.name,
    sessionId: record.sessionId ?? getSessionId(record.sessionFile), sessionFile: record.sessionFile,
    launchScriptFile, terminalRecordFile: terminalRecordFile(running), surface, readiness: "ready" };
}

/** Follow persisted ownership, not an ambient list of terminals or friendly names. */
function ownedTree(runs: SubagentRuns, target?: SubagentRun): Array<{ runs: SubagentRuns; run: SubagentRun }> {
  const tree: Array<{ runs: SubagentRuns; run: SubagentRun }> = [];
  for (const run of target ? [target] : runs.list()) {
    if (!run.loadout || !run.writerToken) continue;
    tree.push({ runs, run });
    const sessionId = getSessionId(run.sessionFile);
    if (sessionId) tree.push(...ownedTree(new SubagentRuns(sessionId, run.sessionFile, dirname(run.sessionFile))));
  }
  return tree;
}

async function finishControl(owner: ParentRuntime, runs: SubagentRuns, record: SubagentRun): Promise<SubagentRun> {
  if (runs.resolve({ id: record.id }).control?.id !== record.control?.id) return runs.resolve({ id: record.id });
  if (["suspended", "stopped"].includes(record.state) && record.closure === "confirmed") return record;
  const deadline = Date.now() + CLOSE_TIMEOUT_MS;
  while (!writerExited(record) && Date.now() < deadline) {
    await delay(25);
    assertRuntime(owner);
    if (!runs.current(record.id, record.generation) || runs.resolve({ id: record.id }).control?.id !== record.control?.id) return runs.resolve({ id: record.id });
  }
  assertRuntime(owner);
  if (!writerExited(record)) {
    runs.update(record.id, record.generation, { closure: "unconfirmed", diagnostic: "Cooperative shutdown handshake timed out; writer exit is unproven. History and owner retained; inspect child, then retry subagent_stop or restore after positive exit." }, record.control?.id);
    return runs.resolve({ id: record.id });
  }
  if (runs.resolve({ id: record.id }).control?.id !== record.control?.id) return runs.resolve({ id: record.id });
  let inventory: SurfaceState = record.closure === "confirmed" ? "absent" : record.backend === getMuxBackend() && record.surface ? surfaceState(record.surface) : "unknown";
  let diagnostic = "";
  if (inventory === "present") {
    try { closeSurface(record.surface!); } catch (error) { diagnostic = String(error); }
    const closeDeadline = Date.now() + CLOSE_TIMEOUT_MS;
    while ((inventory = surfaceState(record.surface!)) === "present" && Date.now() < closeDeadline) { await delay(100); assertRuntime(owner); }
  }
  const closed = inventory === "absent";
  const projected = projectRun(runs.resolve({ id: record.id }));
  const floor = Math.max(record.resultAfterSequence, readCheckpoint(record)?.resultAfterSequence ?? 0);
  const terminal = record.control?.kind === "suspend" && !!projected.latestResult && projected.latestResult.generation === record.generation && projected.latestResult.sequence > floor;
  runs.update(record.id, record.generation, {
    state: terminal ? projected.state : record.control?.kind === "stop" ? closed ? "stopped" : "stopping" : closed ? "suspended" : "suspending",
    ...(terminal ? { control: undefined } : {}),
    closure: closed ? "confirmed" : "unconfirmed", resultAfterSequence: floor,
    diagnostic: closed ? !terminal && record.control?.kind === "suspend" && !readCheckpoint(record)
      ? "Writer exited without a verified interruption checkpoint; consumption/effects remain uncertain. Inspect retained history and subagent_status for exact-action reconciliation; no automatic continuation."
      : undefined : `${diagnostic || `Terminal inventory ${inventory}; closure not confirmed`}. Owner/history retained; retry subagent_stop or restore when closure is known.`,
    ...(projected.latestResult ? { latestResult: projected.latestResult } : {}),
  }, record.control?.id);
  return runs.resolve({ id: record.id });
}

async function controlOwnedTree(owner: ParentRuntime, kind: "suspend" | "stop", target?: SubagentRun) {
  assertRuntime(owner);
  const tree = ownedTree(runsFor(owner.ctx), target);
  // Fence every writer before awaiting any one of them. Descendants cannot
  // acquire another business action while their ancestor is shutting down.
  for (const item of tree) {
    const projected = projectRun(item.run);
    if (kind === "suspend" && (projected.state === "stopped" || (writerExited(projected) && !["suspending", "suspended"].includes(projected.state)))) continue;
    item.run = item.runs.control(item.run.id, kind);
    const local = runningSubagents.get(item.run.executionId);
    local?.abortController?.abort();
    if (local) forgetRunning(local);
  }
  const results = [];
  for (const item of tree.reverse()) {
    if (!item.run.control) { results.push(projectRun(item.run)); continue; }
    results.push(await finishControl(owner, item.runs, item.run));
  }
  return results;
}

function restoreSuspended(owner: ParentRuntime, runs: SubagentRuns, record: SubagentRun): void {
  if (record.control?.kind !== "suspend" || owner.restoring.has(record.id)) return;
  owner.restoring.add(record.id);
  void (async () => {
    const run = await finishControl(owner, runs, record);
    if (owner.leaving || !run.control || run.control.kind !== "suspend" || run.state !== "suspended") return;
    const checkpoint = readCheckpoint(run);
    const inbox = new SubagentInbox(run.sessionFile);
    const snapshot = inbox.snapshot(run);
    if (!checkpoint || snapshot.paused) {
      const uncertainty = snapshot.uncertainty ?? snapshot.messages.find((message) => message.uncertainty)?.uncertainty;
      const line = `${run.name}: suspension paused. ${uncertainty?.reason ?? "No verified interruption checkpoint."} ${uncertainty ? `Use subagent_message authorization with exact actionId ${uncertainty.actionId}; normal restore is not permission to repeat it.` : "Inspect retained diagnostic/history; no automatic writer started."}`;
      owner.notifications.publish({ customType: "subagent_status", content: line, display: true,
        details: { id: run.id, name: run.name, eventId: `subagent-suspension:${run.control.id}`, uncertainty, lines: [line], overflow: 0 } });
      owner.notifications.deliver(owner.pi);
      return;
    }
    const loadout = readSubagentLoadout(run.sessionFile);
    if (!loadout) throw new Error("Suspended loadout is unavailable/invalid; no automatic restart");
    const policyError = delegationError(loadout.agent);
    if (policyError) throw new Error(policyError);
    if (!owner.ctx.modelRegistry.getAll().some((model) => `${model.provider}/${model.id}` === loadout.model)) throw new Error(`Recorded model ${loadout.model} unavailable; no automatic restart`);
    if (!hasSupportedParentTerminal() || run.backend !== getMuxBackend()) throw new Error("Recorded terminal backend unavailable; no automatic restart");
    const childSessionId = getSessionId(run.sessionFile);
    const children = childSessionId ? new SubagentRuns(childSessionId, run.sessionFile, dirname(run.sessionFile)) : undefined;
    const arrivedResult = children && new SubagentNotifications(children).list().some((event) => event.state === "persisted" && event.message.customType === "subagent_result" &&
      children.list().some((child) => child.id === event.message.details.id && child.generation === event.message.details.generation && ["completed", "failed", "aborted"].includes(projectRun(child).state)));
    const continuation = (checkpoint.wait === "continue" || (checkpoint.wait === "descendants" && arrivedResult))
      ? `Continue the suspended delegated work from the recorded active history (interruption leaf ${checkpoint.leafId ?? "root"}). This is a new continuation, not a replay of the original task or a checkpoint of shell/network activity. Honor completed effects, pending questions and descendant results; never repeat an uncertain action without its exact authorization.${snapshot.resolution ? ` Explicit affected-action resolution: ${JSON.stringify(snapshot.resolution)}. Apply only this decision; confirm-completed means do not repeat that action.` : ""}` : undefined;
    const queued = inbox.enqueue(run, { ...(continuation ? { message: continuation, messageId: `subagent-continuation:${run.control.id}` } : {}) },
      () => ({ run: runs.resume(run.id, run.generation, loadout), launch: true }), true);
    if (queued.launch) await launchRecorded(owner, runs, queued.run, continuation ?? "Preserved wait; awaiting its correlated event");
  })().catch((error) => {
    if (runtime === owner && !owner.abort.signal.aborted) {
      runs.update(record.id, record.generation, { diagnostic: `Automatic continuation refused: ${String(error)}. History retained; inspect subagent_status.` }, record.control?.id);
      console.error("Subagent continuation failed:", error);
    }
  }).finally(() => owner.restoring.delete(record.id));
}

function reconnectObservers(owner: ParentRuntime): void {
  if (runtime !== owner || owner.leaving || owner.abort.signal.aborted || !owner.notifications.acquire()) return;
  const runs = runsFor(owner.ctx);
  for (const record of runs.list()) {
    if (record.control) { restoreSuspended(owner, runs, record); continue; }
    if (!record.loadout || !record.writerToken || !record.surface || owner.observed.has(`${record.executionId}:${record.generation}`)) continue;
    const previous = runningSubagents.get(record.executionId);
    // A local launch owns readiness until it returns; don't create a parallel
    // watcher/cleanup path in the middle of that asynchronous handshake.
    if (previous?.generation === record.generation && record.state === "starting") continue;
    previous?.abortController?.abort();
    const running: RunningSubagent = {
      owner, backend: record.backend,
      id: record.executionId, subagentId: record.id, generation: record.generation, runs,
      name: record.name, task: "", agent: record.loadout.agent, surface: record.surface,
      sessionFile: record.sessionFile, startTime: record.startTime,
      interactive: record.loadout.interactive, lastResultSequence: record.resultAfterSequence, closure: record.closure,
      settled: !["starting", "running"].includes(projectRun(record).state),
      activityFile: getSubagentActivityFile(runs.directory, record.executionId),
      statusState: createStatusState({ source: "pi", startTimeMs: record.startTime }),
    };
    runningSubagents.set(running.id, running);
    startSubagentWatch(owner.pi, running);
  }
}

function detachRuntime(owner: ParentRuntime, preserveQueued: boolean): void {
  owner.abort.abort();
  if (runtime !== owner) return;
  if (widgetInterval) clearInterval(widgetInterval);
  if (statusInterval) clearInterval(statusInterval);
  widgetInterval = statusInterval = null;
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  if (latestCtx?.hasUI) latestCtx.ui.setWidget("subagent-status", undefined);
  latestCtx = null;
  for (const agent of runningSubagents.values()) agent.abortController?.abort();
  runningSubagents.clear();
  runtime = null;
  owner.notifications.release(preserveQueued);
}

export default function subagentsExtension(pi: ExtensionAPI) {
  let boundRuntime: ParentRuntime | null = null;
  // Capture the UI context for widget updates
  pi.on("session_start", (event, ctx) => {
    if (runtime) detachRuntime(runtime, event.reason === "reload");
    latestCtx = ctx;
    const runs = runsFor(ctx);
    const abort = new AbortController();
    (globalThis as any)[POLL_ABORT_KEY] = abort;
    runtime = boundRuntime = { pi, ctx, abort, notifications: new SubagentNotifications(runs), observed: new Set(), restoring: new Set(), leaving: false };
    runningSubagents.clear();
    // Reattach observation only. Even confirmed-dead work never starts Pi here.
    reconnectObservers(runtime);
    runtime.notifications.deliver(pi);
    startWidgetRefresh();
    startStatusRefresh(pi);
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", async (event) => {
    const owner = boundRuntime;
    if (owner !== runtime || !owner) return;
    owner.leaving = true;
    try {
      if (event.reason !== "reload" && owner.notifications.acquire()) {
        const ownControl = process.env.PI_SUBAGENT_SESSION && process.env.PI_SUBAGENT_ID
          ? readControl(process.env.PI_SUBAGENT_SESSION, process.env.PI_SUBAGENT_ID) : undefined;
        await controlOwnedTree(owner, ownControl?.kind === "stop" ? "stop" : "suspend");
      }
    } catch (error) {
      // Shutdown handlers cannot veto Pi teardown. Keep the durable owner and
      // records untouched on a storage/handshake failure; never claim success.
      console.error("Owned subagent suspension incomplete; inspect retained records:", error);
    } finally { detachRuntime(owner, event.reason === "reload"); }
  });

  // Pi 0.87 has an idle preparation window before agent_start. Notifications
  // must not open a parallel custom run in the middle of that user prompt.
  pi.on("input", (_event, ctx) => { if (boundRuntime === runtime && ctx.isIdle()) boundRuntime?.notifications.prepareInput(); });
  pi.on("agent_start", () => { if (boundRuntime === runtime) boundRuntime?.notifications.agentStart(); });
  pi.on("agent_before_settle", (event, ctx) => {
    if (boundRuntime !== runtime || !boundRuntime) return;
    boundRuntime.notifications.reconcile(ctx, event.context.pendingMessages);
    boundRuntime.notifications.deliver(pi);
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  registerManagementTool(pi, {
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = callerLoadout()?.agent;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            isError: true,
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a managed subagent → only its snapshot's pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows (including explicitly addressable hidden roles).
        // Every spawn must name an agent in that set. Context mode is selected
        // by the role, not by an agentless fork override. Without this guard a
        // missing or unknown `agent` could launch an unrestricted child.
        const restricted = callerLoadout() !== null;
        const definitions = discoverAgentDefinitions(ctx.cwd);
        const permittedAgents = definitions.map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            isError: true,
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${restricted ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            isError: true,
            details: {
              error: restricted ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        const definition = definitions.find((agent) => agent.name === params.agent);
        if (!definition || definition.tools === undefined) {
          const error = `Role "${params.agent}" must explicitly declare tools (use tools: for no business tools).`;
          return { isError: true, content: [{ type: "text", text: error }], details: { error } };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!hasSupportedParentTerminal()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            isError: true,
            details: { error: "no session file" },
          };
        }

        const name = normalizeSubagentName(params.name ?? params.agent);
        let running;
        try {
          running = await launchSubagent({ ...params, name }, ctx, { definition, thinking: pi.getThinkingLevel() });
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          return { isError: true, content: [{ type: "text", text: error }], details: { error, ...(cause as any)?.details } };
        }

        // Durable identity/name reservation was committed before native launch.

        startSubagentWatch(pi, running);

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${running.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.subagentId ?? running.id,
            generation: running.generation,
            name: running.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            terminalRecordFile: terminalRecordFile(running),
            surface: running.surface,
            readiness: running.cli === "claude" ? "legacy-unverified" : "ready",
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  registerManagementTool(pi, {
    name: "subagent_status", label: "Subagent Status",
    description: "Inspect recorded collaborators owned by this parent session. Use id or unique name, or omit both to list. Does not restart or take over children; results still arrive automatically.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runs = runsFor(ctx);
      const status = (record: SubagentRun) => {
        const run = projectRun(record);
        const inventory = run.backend === getMuxBackend() && run.surface ? surfaceState(run.surface) : "unknown";
        const heartbeat = readSubagentLiveness(run.sessionFile, run.executionId);
        const inbox = new SubagentInbox(run.sessionFile).snapshot(run);
        const notifications = new SubagentNotifications(runs).list().filter((event) => event.message.details.id === run.id)
          .map((event) => ({ eventId: event.message.details.eventId, type: event.message.customType, state: event.state }));
        return { ...run, checkpoint: readCheckpoint(run), recovery: run.control?.kind === "stop" ? "Explicit stop retained; no automatic restart. Retry subagent_stop if closure is unconfirmed."
          : run.control ? "Automatic continuation requires a safe checkpoint, positive writer exit and confirmed closure; use exact-action authorization for uncertainty, or inspect the retained diagnostic."
          : undefined, ...inbox, questions: new SubagentInbox(run.sessionFile).questions(), notifications, ...(inbox.paused && run.control?.kind !== "stop" ? { state: "paused-uncertain" } : {}), liveness: { surface: inventory, writer: writerExited(run) ? "exited" : "claimed-or-unknown", heartbeatAt: heartbeat,
          responsive: heartbeat === null ? "unknown" : Date.now() - heartbeat < 20_000 ? "responsive" : "unresponsive" } };
      };
      if (params.id || params.name !== undefined) {
        const subagent = status(runs.resolve(params));
        return { content: [{ type: "text", text: JSON.stringify(subagent) }], details: { subagent } };
      }
      const subagents = runs.list().map(status);
      return { content: [{ type: "text", text: JSON.stringify(subagents) }], details: { subagents } };
    },
  });

  registerManagementTool(pi, {
    name: "subagent_stop", label: "Stop Subagent",
    description: "Explicitly stop a collaborator owned by the current parent (id or unique name), including its owned descendants. Retains transcripts, results, questions and diagnostics; no purge. Only confirmed writer exit and terminal closure report stopped. Repeat to reconcile unconfirmed closure; explicitly stopped work never automatically restarts.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const owner = runtime;
      assertRuntime(owner);
      const target = runsFor(ctx).resolve(params);
      if (!target.loadout || !target.writerToken) throw new Error("Stop requires managed Pi ownership; legacy/Claude writer state is unknown, history retained");
      const policyError = delegationError(target.loadout.agent);
      if (policyError) throw new Error(policyError);
      if (!owner.notifications.acquire()) throw new Error("Another live parent observer owns cleanup; stop there or retry after its positive exit");
      const subagents = await controlOwnedTree(owner, "stop", target);
      updateWidget();
      const confirmed = subagents.every((run) => run.state === "stopped");
      const details = { status: confirmed ? "stopped" : "stop-unconfirmed", id: target.id, name: target.name, subagents };
      if (!confirmed) throw new Error(`Stop unconfirmed; ownership/history retained. Inspect subagent_status and retry subagent_stop: ${subagents.filter((run) => run.state !== "stopped").map((run) => `${run.name}: ${run.diagnostic}`).join("; ")}`);
      return { content: [{ type: "text", text: "Owned work and descendants confirmed stopped; all history/results retained. Normal restore will not restart them." }], details };
    },
  });

  // ── subagents_list tool ──
  registerManagementTool(pi, {
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const list = discoverAgentDefinitions(ctx?.cwd).filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  registerManagementTool(pi, {
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Durably queue an exact instruction for an owned Pi subagent by id or unique name. auto/steer redirects busy work and starts a prompt when idle; followUp waits behind automatic work. " +
        "Concurrent completed-session messages share one fenced writer. messageId is an optional retry/dedup key; reusing it with different bytes/mode fails. " +
        "Queued is not child acceptance, transcript consumption, settlement, or completion; subagent_status exposes that evidence. Results arrive automatically; do not poll for completion. " +
        "Uncertain consumption/effects pause only this collaborator, including ordinary new messages. Only explicit user authorization/reconciliation of the exact actionId releases it: retry permits repeating that instruction; confirm-completed records that it must not repeat. " +
        "Answer a question only with replyTo, including when just one question remains; ordinary messages never resolve questions. " +
        "Never infer permission from generic follow-up/resume. Claude children retain legacy terminal messaging without managed-Pi delivery guarantees.",
      promptSnippet: "Queue exact subagent instructions (auto, steer, followUp). A durable queue acknowledgement is not consumption/completion. Uncertainty requires explicit affected-action authorization, never routine resume.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Stable collaborator id owned by this parent session." })),
        name: Type.Optional(Type.String({ description: "Unique assigned name. If id is also supplied, both must identify the same collaborator." })),
        message: Type.Optional(Type.String({ description: "Exact instruction bytes. Required unless explicitly resolving an uncertain action." })),
        messageId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Stable logical message id for safe caller retries." })),
        deliverAs: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("steer"), Type.Literal("followUp")])),
        replyTo: Type.Optional(Type.String({ minLength: 1, description: "Exact questionId from this child's question notification/status. Required for answers, even with one pending question; omitted means ordinary instruction." })),
        authorization: Type.Optional(Type.Object({
          actionId: Type.String({ description: "Exact uncertain actionId from status; not a collaborator or generic resume id." }),
          decision: Type.Union([Type.Literal("retry"), Type.Literal("confirm-completed")]),
          reason: Type.String({ minLength: 1, description: "Explicit user permission to repeat this action, or reliable reconciliation confirming it must not repeat." }),
        })),
      }),

      renderCall(args, theme) {
        const target = args.name ?? args.id ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "queued" || details?.status === "paused-uncertain") {
          return new Text(theme.fg("accent", "○") + " " + theme.fg("toolTitle", theme.bold(details.name)) +
            theme.fg("dim", details.paused ? " — durably queued, paused for explicit confirmation" : ` — ${details.message?.state ?? "queued"} (not task completion)`), 0, 0);
        }
        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const owner = runtime;
        assertRuntime(owner);
        if (params.message === undefined && !params.authorization) throw new Error("message is required unless resolving an exact uncertain action; request not accepted");
        if (params.message !== undefined && !params.message.trim()) throw new Error("message is required; request not accepted");
        const runs = runsFor(ctx);
        const entry = runs.resolve(params);
        const requestedName = entry.name;
        const runningMatch = Array.from(runningSubagents.values()).find((r) => r.subagentId === entry.id && r.id === entry.executionId);
        if (runningMatch?.cli === "claude") {
          if (params.replyTo !== undefined) throw new Error("Claude messaging does not support managed question replies");
          if (!params.message) throw new Error("Claude messaging does not support durable action authorization");
          const error = delegationError(runningMatch.agent) ?? terminalDeliveryError(runningMatch);
          if (error) throw new Error(error);
          const delivered = legacyTerminalMessage(runningMatch, params.message);
          if ("error" in delivered) throw new Error(delivered.error);
          return { content: [{ type: "text", text: "Legacy Claude terminal message sent (no managed-Pi delivery guarantee)." }], details: { status: "steered", name: entry.name } };
        }
        if (!entry.writerToken) throw new Error("Legacy writer ownership is uncertain; request not accepted");
        const message = params.message ?? "Explicitly reconciled uncertain action";
        const name = requestedName;
        const sessionPath = entry.sessionFile;
        if (!sessionPath || (writerExited(entry) && !existsSync(sessionPath))) {
          const err =
            `Subagent "${requestedName}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
          return { isError: true, content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // Reconstruct the loadout from the snapshot written at spawn time.
        // Without it we cannot safely resume: relaunching bare would load every
        // global extension + the full toolset. Refuse rather than escalate.
        const loadout = readSubagentLoadout(sessionPath);
        if (!loadout) {
          const err =
            `Cannot safely resume "${requestedName}": no valid loadout snapshot for this session ` +
            `(the snapshot is missing, invalid, unsupported, or a required resource is unavailable). ` +
            `Resume is refused; history is retained. Re-run the task as a fresh named subagent instead.`;
          return { isError: true, content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!ctx.modelRegistry.getAll().some((model) => `${model.provider}/${model.id}` === loadout.model)) {
          const error = `Cannot safely resume "${requestedName}": recorded model ${loadout.model} is unavailable; delegate a fresh named role instead. History is retained.`;
          return { isError: true, content: [{ type: "text", text: error }], details: { error } };
        }
        const policyError = delegationError(loadout.agent);
        if (policyError) return { isError: true, content: [{ type: "text", text: policyError }], details: { error: policyError } };
        const inbox = new SubagentInbox(sessionPath);
        const prepare = () => {
          assertRuntime(owner);
          const target = runs.messageTarget(entry.id);
          if (!target.launch) return target;
          if (!hasSupportedParentTerminal()) throw new Error("Managed subagent resume requires a supported terminal; headless is not supported");
          if (entry.backend !== getMuxBackend()) throw new Error("Recorded backend differs; writer state is uncertain, request not accepted");
          return { run: runs.resume(target.run.id, target.run.generation, loadout), launch: true };
        };
        let queued = inbox.enqueue(entry, params, prepare);
        if (queued.waitingForExit) {
          const deadline = Date.now() + CLOSE_TIMEOUT_MS;
          while (!writerExited(queued.run) && Date.now() < deadline) { await delay(25); assertRuntime(owner); }
          if (writerExited(queued.run)) queued = inbox.enqueue(runs.resolve({ id: entry.id }), params, prepare);
        }
        const acknowledgement = {
          content: [{ type: "text" as const, text: queued.paused
            ? `Instruction retained for "${name}", but this collaborator is paused: reconcile or explicitly authorize the affected actionId. Ordinary follow-up is not permission to retry.`
            : `Instruction durably queued for "${name}". This is not child consumption or task completion; results arrive automatically.` }],
          details: { id: entry.id, generation: queued.run.generation, name, status: queued.paused ? "paused-uncertain" : "queued", paused: queued.paused, message: queued.message },
        };
        if (!queued.launch) {
          if (runningMatch && runningMatch.generation !== queued.run.generation) {
            runningMatch.abortController?.abort();
            const running = { ...runningMatch, generation: queued.run.generation, lastResultSequence: queued.run.resultAfterSequence, settled: false, abortController: undefined };
            runningSubagents.set(running.id, running);
            startSubagentWatch(pi, running);
          } else if (!runningMatch && !queued.paused && queued.run.surface && ["starting", "running"].includes(queued.run.state)) {
            // Explicit sends and automatic recovery share the same observer
            // owner; neither path takes over the existing Pi writer.
            const running: RunningSubagent = {
              owner, backend: queued.run.backend,
              id: queued.run.executionId, subagentId: entry.id, generation: queued.run.generation, runs,
              name, task: message, surface: queued.run.surface, startTime: queued.run.startTime,
              sessionFile: sessionPath, agent: loadout.agent, interactive: loadout.interactive,
              lastResultSequence: queued.run.resultAfterSequence,
              activityFile: getSubagentActivityFile(getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()), queued.run.executionId),
              statusState: createStatusState({ source: "pi", startTimeMs: queued.run.startTime }),
            };
            runningSubagents.set(running.id, running);
            startSubagentWatch(pi, running);
          }
          updateWidget();
          return acknowledgement;
        }
        const details = await launchRecorded(owner, runs, queued.run, message);
        return { content: acknowledgement.content, details: { ...acknowledgement.details, ...details } };
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      if (boundRuntime) assertRuntime(boundRuntime);
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = (details.outcome && details.outcome !== "succeeded") || exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = details.outcome === "aborted" ? "aborted"
            : details.outcome === "truncated" ? "truncated output"
            : details.outcome === "no-output" ? "no new output"
            : details.source?.kind === "surface_absent" ? "interrupted (surface disappeared)"
            : details.source?.kind === "process_exit" ? "failed before settlement"
            : errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = ["This generation:", ...formatUsageSegments(stats)].map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = stats.contextWindow;
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(/^Sub-agent [^\n]+\n\n/, "");

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);
        if (details.usage?.session) contentLines.push(theme.fg("dim", `Whole session (includes inherited history): ${formatUsageSegments(details.usage.session).join(" ") || "no recorded usage"}`));

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(truncateToWidth(line, Math.max(0, width - 2)));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
            if (details.resultFile) {
              contentLines.push(theme.fg("muted", `Result file: ${details.resultFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", truncateToWidth(line, Math.max(0, width - 2))));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          if (details.resultFile) contentLines.push(theme.fg("muted", `Full result: ${details.resultFile}`));
          contentLines.push(theme.fg("muted", `${keyText("app.tools.expand")} to expand`));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(Math.max(1, width))].map((line) => truncateToWidth(line, Math.max(0, width)));
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", `${keyText("app.tools.expand")} to expand`));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(Math.max(1, width))].map((line) => truncateToWidth(line, Math.max(0, width)));
      },
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message(${JSON.stringify({ id: details.id, replyTo: details.questionId, message: "…" })})`),
          );
        } else {
          const preview = truncateToWidth((details.question ?? "").split("\n")[0], Math.max(0, width - 2));
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", `${keyText("app.tools.expand")} to expand`));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(Math.max(1, width))].map((line) => truncateToWidth(line, Math.max(0, width)));
      },
    };
  });

}
