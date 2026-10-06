import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowHostContext } from "./host.js";

function hasProjectDefinitions(cwd: string): boolean {
  if (existsSync(join(cwd, ".pi", "pi-workflow.json")) || existsSync(join(cwd, ".rpiv", "workflows", "config.ts"))) return true;
  try { return readdirSync(join(cwd, ".rpiv", "workflows", "packs")).some((name) => name.endsWith(".ts")); }
  catch { return false; }
}

/** Pi frontend only: custom-only definitions are executable even when native
 * Pi found no protected resources and returned an implicit true. */
export async function resolveWorkflowProjectTrusted(ctx: Pick<WorkflowHostContext, "cwd" | "isProjectTrusted">): Promise<boolean> {
  const decision = ctx.isProjectTrusted?.();
  if (decision !== true) return false;
  if (!hasProjectDefinitions(ctx.cwd)) return true;
  // Keep frontend discovery lightweight. Native trust services are needed only
  // when an admitted command can evaluate project-owned definitions.
  const { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  if (hasTrustRequiringProjectResources(ctx.cwd)) return true;
  const agentDir = getAgentDir();
  try {
    const saved = new ProjectTrustStore(agentDir).get(ctx.cwd);
    if (saved !== null) return saved;
  } catch { /* unreadable approval is not a grant */ }
  try {
    return SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
  } catch { return false; }
}
