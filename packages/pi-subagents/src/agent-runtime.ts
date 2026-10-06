import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager, isTopLevelAgent } from "./agent-manager.js";
import { buildAgentRegistry, getAgentConfigIn, resolveSpawnTypeIn } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { registerRpcHandlers, type RpcHandle } from "./cross-extension-rpc.js";
import { i18n } from "./i18n.js";
import { createNestedSubagentTools } from "./nested-tools.js";
import { createProductExecutionBackend } from "./product-backend.js";
import { resolveProjectTrusted } from "./project-trust.js";
import type { SubagentBackend } from "./settings.js";
import { captureRuntimePolicy, type SubagentsRuntimePolicy } from "./runtime-policy.js";
import { getLifetimeTotal, PendingUsagePool, toReportedUsage } from "./usage.js";

export interface AgentRuntimeOptions {
  backend?: SubagentBackend;
  allowedSubagents?: "all" | string[];
  depth?: number;
  maxSubagentDepth?: number;
  configCwd?: string;
  /** Owned defaults; workflow stages default to foreground without changing root Agents. */
  defaultRunInBackground?: boolean;
  runtimePolicy?: SubagentsRuntimePolicy;
}

/** Scoped Agent tools for SDK stages or terminal children; no root UI or global manager slot. */
export function createAgentRuntime(options: AgentRuntimeOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const usagePool = new PendingUsagePool();
    let manager: AgentManager | undefined;
    let current: ExtensionContext | undefined;
    let rpc: RpcHandle | undefined;
    let closing = false;

    pi.on("session_start", (_event, ctx) => {
      current = ctx;
      if (manager) return;
      const configCwd = options.configCwd ?? ctx.cwd;
      const policy = options.runtimePolicy ?? captureRuntimePolicy(configCwd, resolveProjectTrusted(configCwd, { context: ctx }));
      const settings = policy.settings;
      const depth = options.depth ?? 0;
      const maxDepth = Math.max(depth === 0 ? 1 : 0, options.maxSubagentDepth ?? policy.maxSubagentDepth);
      const allowedSubagents = options.allowedSubagents ?? "all";
      if (depth >= maxDepth || allowedSubagents.length === 0) return;
      manager = new AgentManager((record) => {
        if (closing || !isTopLevelAgent(record)) return;
        const failed = ["error", "aborted", "stopped"].includes(record.status);
        const usage = toReportedUsage(record.lifetimeUsage);
        const total = getLifetimeTotal(record.lifetimeUsage);
        pi.events.emit(failed ? "subagents:failed" : "subagents:completed", {
          id: record.id, type: record.type, description: record.description,
          status: record.status, result: record.result, error: record.error,
          toolUses: record.toolUses, durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
          ...(total > 0 ? { tokens: { input: record.lifetimeUsage.input, output: record.lifetimeUsage.output, total } } : {}),
          ...(usage ? { usage } : {}),
        });
        if (record.isBackground && !record.resultConsumed) {
          pi.sendMessage({
            customType: "subagent-notification",
            content: i18n.t("runtimeChild.result", {
              id: record.id, name: record.description, status: record.status,
              result: record.result ?? record.error ?? "",
            }),
            display: false,
            details: { id: record.id, status: record.status },
          }, { deliverAs: "followUp", triggerTurn: true });
        }
      }, settings.maxConcurrent, (record) => {
        if (!isTopLevelAgent(record)) return;
        pi.events.emit("subagents:started", { id: record.id, type: record.type, description: record.description });
      }, undefined, (_record, usage) => {
        if (settings.reportUsage) usagePool.add(usage);
      }, createProductExecutionBackend({ cwd: configCwd, backend: options.backend }));
      manager.setMaxConcurrentForeground(settings.maxConcurrentForeground ?? 0);
      for (const tool of createNestedSubagentTools({
        manager, pi, depth, defaultRunInBackground: options.defaultRunInBackground
          ?? (depth === 0 ? settings.backgroundByDefault ?? true : false),
        maxSubagentDepth: maxDepth, allowedSubagents, configCwd, runtimePolicy: policy,
      })) pi.registerTool({
        ...tool,
        async execute(...args) {
          const result = await tool.execute(...args);
          const usage = settings.reportUsage ? usagePool.drain() : undefined;
          return usage ? { ...result, usage } : result;
        },
      });

      // Nested actors expose only the bounded Agent tool contract, never a
      // second unrestricted RPC door around their definition's allowlist.
      if (depth !== 0 || allowedSubagents !== "all") return;
      rpc = registerRpcHandlers({
        events: pi.events, pi, getCtx: () => current, getRuntimePolicy: () => policy,
        manager: {
          spawn: (_pi, rawCtx, type, prompt, input) => {
            const ctx = rawCtx as ExtensionContext;
            const registry = buildAgentRegistry(loadCustomAgents(configCwd, false, { projectTrusted: policy.projectTrusted }), settings);
            const resolved = resolveSpawnTypeIn(registry, type, settings);
            if (!resolved.ok) throw new Error(resolved.message);
            const safe = { ...input };
            // Backend ownership is fixed by this scoped runtime. RPC callers may
            // choose invocation behavior, but cannot escape the workflow/session pin.
            delete safe.backend;
            delete safe.resumeSessionFile;
            delete safe.reclaim;
            delete safe.blocking;
            delete safe.runtimePolicy;
            return manager!.spawn(pi, ctx, resolved.type, prompt, {
              ...safe,
              agentConfig: getAgentConfigIn(registry, resolved.type),
              description: input?.description ?? type,
              parentAgentId: undefined, workflowId: undefined, depth: 1,
              configCwd, runtimePolicy: policy, rootSessionId: ctx.sessionManager.getSessionId(),
              maxSubagentDepth: maxDepth,
            });
          },
          awaitStartup: (id) => manager!.awaitStartup(id),
          control: (id, request) => manager!.control(id, request),
          getRecord: (id) => manager!.getRecord(id),
          consumeResult: (id) => {
            const record = manager!.getRecord(id);
            if (!record || !isTopLevelAgent(record) || record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            return true;
          },
        },
      });
      pi.events.emit("subagents:ready", {});
    });

    pi.on("session_shutdown", async () => {
      closing = true;
      current = undefined;
      rpc?.unsubPing(); rpc?.unsubSpawn(); rpc?.unsubControl(); rpc?.unsubConsume();
      await manager?.dispose(pi);
    });
  };
}
