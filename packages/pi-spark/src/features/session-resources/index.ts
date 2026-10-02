import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/index.ts";
import { collectSessionResources, collectToolResources } from "./collector.ts";
import { isResourcesEnabled } from "./config.ts";
import { registerSessionResourcesCommand } from "./command.ts";
import { ensureSessionResourceRuntime } from "./runtime.ts";

function syncEnabled(ctx: ExtensionContext): void {
  ensureSessionResourceRuntime().enabled = isResourcesEnabled(loadConfig(ctx).resources);
}

/** Collects session resources and registers the # picker commands. */
export function registerSessionResources(pi: ExtensionAPI): void {
  const runtime = ensureSessionResourceRuntime();
  registerSessionResourcesCommand(pi);

  pi.on("session_start", (_event, ctx) => {
    syncEnabled(ctx);
    runtime.index.replace(collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd));
  });

  pi.on("session_tree", (_event, ctx) => {
    runtime.index.replace(collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd));
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    runtime.index.observe(collectToolResources({
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      details: event.details,
      cwd: ctx.cwd,
      timestamp: Date.now(),
    }));
  });

  pi.on("session_shutdown", () => {
    runtime.index.clear();
  });
}
