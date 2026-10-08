import { t } from "../state/i18n-bridge.js";
import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./types.js";

function formatListLine(task: Task): string {
  const block = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const form = task.status === "in_progress" && task.activeForm
    ? ` (${sanitizeTerminalText(task.activeForm)})`
    : "";
  return `[${task.status}] #${task.id} ${sanitizeTerminalText(task.subject)}${form}${block}`;
}

function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [t("result.getHeader", {
    id: task.id,
    status: task.status,
    subject: sanitizeTerminalText(task.subject),
  })];
  if (task.description) lines.push(`  ${t("result.field.description")}: ${sanitizeTerminalText(task.description)}`);
  if (task.activeForm) lines.push(`  ${t("result.field.activeForm")}: ${sanitizeTerminalText(task.activeForm)}`);
  if (task.blockedBy?.length) {
    lines.push(`  ${t("result.field.blockedBy")}: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (blocks.length) lines.push(`  ${t("result.field.blocks")}: ${blocks.map((id) => `#${id}`).join(", ")}`);
  if (task.owner) lines.push(`  ${t("result.field.owner")}: ${sanitizeTerminalText(task.owner)}`);
  return lines.join("\n");
}

export function formatContent(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": {
      const task = state.tasks.find((candidate) => candidate.id === op.taskId);
      if (!task) return t("result.createdFallback", { id: op.taskId });
      return t("result.created", {
        id: task.id,
        subject: sanitizeTerminalText(task.subject),
        status: "pending",
      });
    }
    case "update": {
      if (!op.changed) {
        return t("result.noChange", { id: op.id, status: op.toStatus });
      }
      const transition = op.fromStatus !== op.toStatus
        ? t("result.transition", { from: op.fromStatus, to: op.toStatus })
        : "";
      return t("result.updated", { id: op.id, transition });
    }
    case "delete":
      return t("result.deleted", { id: op.id, subject: sanitizeTerminalText(op.subject) });
    case "clear":
      return t("result.cleared", { count: op.count });
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((task) => task.status !== "deleted");
      if (op.statusFilter) view = view.filter((task) => task.status === op.statusFilter);
      return view.length === 0 ? t("result.noTasks") : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return t("result.error", { message: op.message });
  }
}

export function buildToolResult(
  action: TaskAction,
  params: TaskMutationParams,
  state: TaskState,
  op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
  const details: TaskDetails = {
    action,
    params: params as Record<string, unknown>,
    tasks: state.tasks,
    nextId: state.nextId,
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return { content: [{ type: "text", text: formatContent(op, state) }], details };
}
