import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-utils";
import { loadConfig, type TodoConfig, validateGuidanceFields } from "./config.js";
import { formatStatusLabel, NOTICE_SOURCE, t } from "./state/i18n-bridge.js";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { getDefaultTodoStore, sid, type TodoStore } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
  buildTodoParamsSchema,
  COMMAND_NAME,
  type TaskMutationParams,
  TOOL_NAME,
  type TodoParams,
} from "./tool/types.js";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.js";

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export {
  __resetState,
  getNextId,
  getTodos,
  setActiveRenderSession,
  sid,
  TodoStore,
} from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

export function getDefaultPromptSnippet(): string {
  return t("tool.promptSnippet");
}

export function getDefaultPromptGuidelines(): string[] {
  return Array.from({ length: 8 }, (_, index) => t(`tool.guideline.${index + 1}`));
}

/** English-locale compatibility snapshots for callers that imported the old constants. */
export const DEFAULT_PROMPT_SNIPPET = getDefaultPromptSnippet();
export const DEFAULT_PROMPT_GUIDELINES = getDefaultPromptGuidelines();

export function registerTodoTool(
  pi: ExtensionAPI,
  store: TodoStore = getDefaultTodoStore(),
  config: TodoConfig = loadConfig(),
): void {
  const guidance = validateGuidanceFields(config.guidance);
  const parameters = buildTodoParamsSchema();
  pi.registerTool({
    name: TOOL_NAME,
    label: t("tool.label"),
    description: t("tool.description"),
    promptSnippet: guidance.promptSnippet ?? getDefaultPromptSnippet(),
    promptGuidelines: guidance.promptGuidelines ?? getDefaultPromptGuidelines(),
    parameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const typed = params as TodoParams;
      const sessionId = sid(ctx);
      const result = applyTaskMutation(store.getState(sessionId), typed.action, typed as TaskMutationParams);
      store.commitState(sessionId, result.state);
      return buildToolResult(typed.action, typed as TaskMutationParams, result.state, result.op);
    },

    renderCall(args, theme) {
      return renderTodoCall(args as TodoParams, theme, store.getRenderState());
    },

    renderResult(result, _options, theme) {
      return renderTodoResult(result, theme);
    },
  });
}

export function registerTodosCommand(pi: ExtensionAPI, store: TodoStore = getDefaultTodoStore()): void {
  pi.registerCommand(COMMAND_NAME, {
    description: t("command.description"),
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "warning",
          message: t("command.requiresInteractive"),
        });
        return;
      }

      const state = store.getState(sid(ctx));
      const visible = selectVisibleTasks(state);
      if (visible.length === 0) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: t("command.noTodos") });
        return;
      }

      const groups = selectTasksByStatus(state);
      const counts = selectTodoCounts(state);
      const header: string[] = [];
      if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
      if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
      if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

      const lines: string[] = [header.join(" · ")];
      if (groups.pending.length > 0) {
        lines.push(t("command.section.pending"));
        for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
      }
      if (groups.inProgress.length > 0) {
        lines.push(t("command.section.in_progress"));
        for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
      }
      if (groups.completed.length > 0) {
        lines.push(t("command.section.completed"));
        for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
      }

      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: lines.join("\n") });
    },
  });
}
