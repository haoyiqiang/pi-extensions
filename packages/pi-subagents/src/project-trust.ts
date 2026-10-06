import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ProjectTrustOptions {
  /** Explicit owner decision captured for configCwd. Always wins. */
  projectTrusted?: boolean;
  /** Session context is authoritative only when it belongs to the same cwd. */
  context?: Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
  agentDir?: string;
}

function hasMarkdownFiles(directory: string): boolean {
  try {
    // Match the loader's filename-based scan, including symlinked .md files.
    return readdirSync(directory, { withFileTypes: true })
      .some((entry) => entry.name.endsWith(".md"));
  } catch {
    return false;
  }
}

/** Project-owned pi-subagents resources that native Pi 0.87 trust discovery does not cover. */
export function hasSubagentsProjectResources(cwd: string): boolean {
  const root = resolve(cwd);
  return existsSync(resolve(root, ".pi", "subagents.json"))
    || existsSync(resolve(root, ".pi", "agent-tool-description.md"))
    || hasMarkdownFiles(resolve(root, ".pi", "agents"))
    || hasMarkdownFiles(resolve(root, ".agents", "agents"));
}

function savedOrDefaultDecision(cwd: string, agentDir: string): boolean {
  try {
    const saved = new ProjectTrustStore(agentDir).get(cwd);
    if (saved !== null) return saved;
  } catch {
    // A missing or malformed store is not approval.
  }
  try {
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    return settings.getDefaultProjectTrust() === "always";
  } catch {
    return false;
  }
}

/**
 * Resolve the trust decision for one config root without borrowing process-global
 * state from a later root session.
 *
 * Pi 0.87 does not emit `project_trust` for a project containing only
 * `.pi/agents`, `.agents/agents`, or `.pi/subagents.json`. For that custom-only
 * case, reuse Pi's public saved trust store and global `defaultProjectTrust`:
 * saved approval or `always` enables project resources; `ask`/`never` remains
 * global-only. This adds no second approval store or daemon. A one-shot CLI
 * `--approve` cannot be observed for custom-only resources, so callers that own
 * that decision must pass `projectTrusted` explicitly.
 */
export function resolveProjectTrusted(cwd: string, options: ProjectTrustOptions = {}): boolean {
  if (options.projectTrusted !== undefined) return options.projectTrusted;

  const configCwd = resolve(cwd);
  const contextCwd = options.context?.cwd ? resolve(options.context.cwd) : undefined;
  const sameContext = contextCwd === configCwd;
  const hasContextDecision = sameContext && typeof options.context?.isProjectTrusted === "function";
  const contextDecision = hasContextDecision ? options.context!.isProjectTrusted() : undefined;
  const nativeResources = hasTrustRequiringProjectResources(configCwd);
  const customResources = hasSubagentsProjectResources(configCwd);

  if (!nativeResources && !customResources) return contextDecision ?? true;

  // Native Pi already ran the full CLI/extension/saved/default decision for the
  // active context, including one-shot --approve/--no-approve.
  if (nativeResources && contextDecision !== undefined) return contextDecision;

  // A host-declared false is authoritative even when only our custom files made
  // the project trust-sensitive. True is ambiguous here because native Pi uses
  // true automatically when it found no native protected resources.
  if (customResources && contextDecision === false) return false;

  return savedOrDefaultDecision(configCwd, options.agentDir ?? getAgentDir());
}
