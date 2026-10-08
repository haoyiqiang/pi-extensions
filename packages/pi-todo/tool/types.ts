import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { t } from "../state/i18n-bridge.js";

export const TOOL_NAME = "todo";
export const COMMAND_NAME = "todos";
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskDetails {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}

export interface TaskMutationParams {
  [key: string]: unknown;
  action?: TaskAction;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  includeDeleted?: boolean;
}

export interface TodoParams extends TaskMutationParams {
  action: TaskAction;
}

export function buildTodoParamsSchema() {
  return Type.Object({
    action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
    subject: Type.Optional(Type.String({ description: t("schema.subject") })),
    description: Type.Optional(Type.String({ description: t("schema.description") })),
    activeForm: Type.Optional(Type.String({ description: t("schema.activeForm") })),
    status: Type.Optional(
      StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
        description: t("schema.status"),
      }),
    ),
    blockedBy: Type.Optional(Type.Array(Type.Number(), { description: t("schema.blockedBy") })),
    addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: t("schema.addBlockedBy") })),
    removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: t("schema.removeBlockedBy") })),
    owner: Type.Optional(Type.String({ description: t("schema.owner") })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: t("schema.metadata") })),
    id: Type.Optional(Type.Number({ description: t("schema.id") })),
    includeDeleted: Type.Optional(Type.Boolean({ description: t("schema.includeDeleted") })),
  });
}
