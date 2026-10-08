# `todo` tool

Actions: `create`, `update`, `list`, `get`, `delete`, and `clear`.

Task fields:

```ts
interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}
```

Allowed forward transitions:

- `pending` → `in_progress`, `completed`, `deleted`
- `in_progress` → `pending`, `completed`, `deleted`
- `completed` → `deleted`
- `deleted` is terminal

The tool executes sequentially because calls mutate session-keyed state. Every result carries a complete post-operation snapshot in `details`:

```ts
interface TaskDetails {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}
```

Replay walks only `ctx.sessionManager.getBranch()` and applies the last valid `todo` tool-result snapshot. This preserves branch semantics through reload, tree changes, and compaction.
