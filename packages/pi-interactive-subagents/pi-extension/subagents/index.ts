import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { keyHint, loadSkills } from "@earendil-works/pi-coding-agent";
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
import { randomUUID } from "node:crypto";
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

import { SubagentRuns, normalizeSubagentName, projectRun, writerExited, type SubagentRun } from "./runs.ts";
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
  forceStatusAfterInterrupt,
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

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
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
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(extBase, "web-search", "index.ts"),
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = Object.hasOwn(map, tool) ? map[tool] : undefined;
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
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

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
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
  lifecycle?: SubagentRun["state"];
  lastResultSequence?: number;
  terminalState?: SurfaceState;
  lastInventoryAt?: number;
  closure?: "confirmed" | "unconfirmed";
  closing?: boolean;
  launchError?: string;
}

const READY_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fencedCommand(command: string, run: SubagentRun): string {
  return [process.execPath, join(SUBAGENTS_DIR, "writer.mjs"), run.sessionFile, run.executionId, run.writerToken, command].map(shellEscape).join(" ");
}
function isCurrent(running: RunningSubagent): boolean {
  return !running.runs || running.runs.current(running.subagentId!, running.generation!);
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
  if (!isCurrent(running)) return;
  running.closing = true;
  // Let the gate observe autonomous Pi exit before closing its shell surface.
  if (running.settled) {
    for (let attempt = 0; attempt < 10 && !existsSync(processExitFile(running.sessionFile, running.id)); attempt++) {
      await delay(25);
      if (!isCurrent(running)) return;
    }
  }
  let diagnostic: string | undefined;
  running.terminalState = surfaceState(running.surface);
  if (running.terminalState !== "absent") {
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

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => [...runningSubagents.values()].filter((child) => !child.settled).length;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

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

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const title = "Subagents";
  const info = `${agents.filter((agent) => !agent.settled).length} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
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

  lines.push(borderBottom(width));
  return lines;
}

function widgetAgents(): RunningSubagent[] {
  if (!latestCtx?.sessionManager.getSessionFile()) return [];
  const runs = runsFor(latestCtx);
  return runs.list().map(projectRun).filter((run) => run.closure !== "confirmed" || run.state === "running" || run.state === "starting").map((run) => {
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
    child.lifecycle = run.state;
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
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(agents, width);
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
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
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
  if (statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      if (!isCurrent(running) || running.settled) continue;
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive && (statusConfig.enabled || snapshot.statusLabel?.includes("uncertain") || transition === "recovered")) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export const __test__ = {
  borderLine,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  steerSubagent,
  resolveResultPresentation,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  formatUsageSegments,
  widgetIcon,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
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
      id, subagentId: record.id, generation: record.generation, runs,
      name: params.name, task: params.task, agent: params.agent, surface, startTime,
      sessionFile: subagentSessionFile, launchScriptFile, activityFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
    };
    runningSubagents.set(id, running);
    runs.update(record.id, record.generation, { surface });
    await confirmSubagentReady(running);
    runs.update(record.id, record.generation, { state: "running", sessionId: getSessionId(subagentSessionFile) });
    return running;
  } catch (cause) {
    runs.update(record.id, record.generation, { state: "failed", diagnostic: cause instanceof Error ? cause.message : String(cause) });
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

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  let payload: any = null;
  try {
    if (!existsSync(askFile)) return;
    payload = JSON.parse(readFileSync(askFile, "utf-8"));
  } catch {
    // Malformed/partway-written file — drop it and move on.
  }
  try {
    unlinkSync(askFile);
  } catch {}
  if (!payload?.question) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult | null> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const observationSignal = AbortSignal.any([signal, getModuleAbortSignal()]);
    if (running.cli !== "claude") {
      for (;;) {
        observationSignal.throwIfAborted();
        if (!isCurrent(running)) return null;
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
          running.terminalState = surfaceState(surface);
          running.lastInventoryAt = now;
          if (running.terminalState === "unknown" && previous !== "unknown") {
            recordTerminal(running, "inventory-unknown", "Terminal inventory unavailable; execution is uncertain, not absent");
            const line = `${name}: terminal inventory unknown; work is retained, no automatic restart or termination.`;
            latestPi?.sendMessage({ customType: "subagent_status", content: line, display: true,
              details: { name, surface, inventory: "unknown", lines: [line], overflow: 0, terminalRecordFile: terminalRecordFile(running) },
            }, { triggerTurn: true, deliverAs: "steer" });
          }
        }
        const exited = existsSync(processExitFile(sessionFile, running.id));
        if (exited || running.terminalState === "absent") {
          // Publication can race inventory/process observation. Durable results
          // always win, even after the surface is already gone.
          if (readSubagentOutcomes(sessionFile, running.id, running.lastResultSequence, running.generation).length > 0) continue;
          if (running.settled) return null;
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
        deliverPendingQuestion(running);
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
      if (signal.aborted || getModuleAbortSignal().aborted) return null;
      throw err;
    }
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
  if (running.closure === "confirmed") forgetRunning(running);
  else {
    const line = `${running.name}: surface closure unconfirmed (inventory=${running.terminalState}); history and ownership retained.`;
    pi.sendMessage({ customType: "subagent_status", content: line, display: true,
      details: { name: running.name, surface: running.surface, closure: running.closure,
        terminalRecordFile: terminalRecordFile(running), lines: [line], overflow: 0 },
    }, { triggerTurn: true, deliverAs: "steer" });
  }
  updateWidget();
}

/** One observation and notification path for both fresh and resumed work. */
function startSubagentWatch(
  pi: ExtensionAPI,
  running: RunningSubagent,
): void {
  // The tool's signal ends with its acknowledgement, not with delegated work.
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  startWidgetRefresh();
  startStatusRefresh(pi);

  void (async () => {
    for (;;) {
      const result = await watchSubagent(running, watcherAbort.signal);
      if (watcherAbort.signal.aborted || getModuleAbortSignal().aborted || !isCurrent(running)) return;
      if (!result) {
        await reconcileClosure(pi, running);
        return;
      }
      if (running.runs && !running.runs.update(running.subagentId!, running.generation!, {
        state: result.outcome === "succeeded" || (!result.outcome && result.exitCode === 0) ? "completed" : result.outcome === "aborted" ? "aborted" : "failed",
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.resultFile ? { latestResult: { resultFile: result.resultFile, outcome: result.outcome!, sequence: result.sequence!, generation: running.generation! } } : {}),
      })) return;
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: resolveResultPresentation(result, running.name),
          display: true,
          details: {
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
        { triggerTurn: true, deliverAs: "steer" },
      );
      // Keep descendant work outstanding until its result is accepted by Pi.
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
    latestCtx?.ui.notify?.(diagnostic, "error");
    console.error(diagnostic);
  });
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
    // Read-only UI reconstruction, not watcher takeover or automatic restart.
    startWidgetRefresh();
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
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
        return { ...run, liveness: { surface: inventory, writer: writerExited(run) ? "exited" : "claimed-or-unknown", heartbeatAt: heartbeat,
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
        "Send a message to a subagent by stable id or unique name owned by your parent session. Both must agree when supplied together. " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "`message` and either `id` or `name` are required. Concurrent startup requests fail explicitly; they are not durably queued in this slice. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a collaborator by stable id or unique name: steers active work, starts a new generation for completed work. " +
        "`message` and an owned target are required. Busy/uncertain writer refusals are not acceptance; full queuing is not provided yet. " +
        "Do not poll or fabricate results.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Stable collaborator id owned by this parent session." })),
        name: Type.Optional(Type.String({ description: "Unique assigned name. If id is also supplied, both must identify the same collaborator." })),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
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
        if (!params.message?.trim()) throw new Error("message is required; request not accepted");
        const runs = runsFor(ctx);
        const entry = runs.resolve(params);
        const requestedName = entry.name;
        if (entry.state === "starting") throw new Error("Subagent launch is busy; this request was not accepted");

        if (!hasSupportedParentTerminal()) {
          return muxUnavailableResult();
        }

        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it.
        const runningMatch = Array.from(runningSubagents.values()).find((r) => r.subagentId === entry.id && r.generation === entry.generation);
        if (runningMatch && !writerExited(entry)) {
          const error = delegationError(runningMatch.agent) ?? terminalDeliveryError(runningMatch);
          if (error) throw new Error(error);
          const delivered = steerSubagent(runningMatch, params.message);
          if ("error" in delivered) throw new Error(delivered.error);
          let running = runningMatch;
          if (runningMatch.settled) {
            const next = runs.nextTask(entry.id, entry.generation, runningMatch.lastResultSequence ?? 0);
            runningMatch.abortController?.abort();
            running = { ...runningMatch, generation: next.generation, settled: false, abortController: undefined };
            runningSubagents.set(running.id, running);
            startSubagentWatch(pi, running);
          }
          running.statusState = forceStatusAfterInterrupt(running.statusState, Date.now());
          updateWidget();
          return { content: [{ type: "text", text: `Message delivered to running subagent "${running.name}".` }],
            details: { id: entry.id, generation: running.generation, name: entry.name, status: "steered" } };
        }

        // ── Resume a finished session by name ──
        const message = params.message;
        const name = requestedName; // identity preservation: the resumed run reclaims its name
        const startTime = Date.now();
        if (entry.backend !== getMuxBackend()) throw new Error("Recorded backend differs; writer state is uncertain, request not accepted");
        if (!writerExited(entry)) throw new Error("Prior writer is active or uncertain; no takeover or replacement started, request not accepted");

        const sessionPath = entry.sessionFile;
        if (!sessionPath || !existsSync(sessionPath)) {
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
        const { autoExit, interactive } = loadout;
        const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;
        const record = runs.resume(entry.id, entry.generation, loadout);
        const id = record.executionId;

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(sessionPath)];

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        // Replay the model, identity, and pinned tool/extension restrictions.
        applySandboxToParts(parts, loadout, { artifactDir, name: `${record.id}-${id}` });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${record.id}-${id}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          const identity = loadout.systemPromptMode === "task" && loadout.identity ? `${loadout.identity}\n\n` : "";
          writeFileSync(resumeMsgFile, identity + message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — replay the snapshot's config dir + spawn whitelist
        // so the resumed process resolves the same agents/extensions and keeps
        // the same nested-spawn restriction it originally ran with.
        const resumeEnvParts: string[] = [];
        resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(loadout.agentDir)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
        resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_RUN_ID=${shellEscape(record.id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_GENERATION=${record.generation}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=${autoExit ? "1" : "0"}`);
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        // Resume in the subagent's original cwd so its tools (safe_bash, edits)
        // operate where they did before.
        const resumeCdPrefix = `cd ${shellEscape(loadout.cwd)} && `;

        const command = fencedCommand(`${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}`, record);
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${record.id}-resume-${id}.sh`,
        );
        let surface: string;
        try { surface = createSubagentSurface(name, command, launchScriptFile, sessionPath, id); }
        catch (cause) {
          runs.update(record.id, record.generation, { state: "failed", diagnostic: cause instanceof Error ? cause.message : String(cause) });
          throw cause;
        }

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          subagentId: record.id, generation: record.generation, runs,
          name,
          task: message,
          surface,
          startTime,
          sessionFile: sessionPath,
          agent: loadout.agent,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        runs.update(record.id, record.generation, { surface });
        try { await confirmSubagentReady(running); }
        catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          runs.update(record.id, record.generation, { state: "failed", diagnostic: error });
          return { isError: true, content: [{ type: "text", text: error }], details: { error, ...(cause as any)?.details } };
        }
        runs.update(record.id, record.generation, { state: "running" });
        startSubagentWatch(pi, running);

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id: record.id,
            generation: record.generation,
            name,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            launchScriptFile,
            terminalRecordFile: terminalRecordFile(running),
            surface,
            readiness: "ready",
            status: "started",
          },
        };
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
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
              contentLines.push(line.slice(0, width - 6));
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
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
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
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
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
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
