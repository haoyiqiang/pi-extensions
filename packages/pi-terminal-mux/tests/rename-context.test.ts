import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSurfaceRenameContext, readSurfaceRenameContext, resolveTerminalRenameTargets,
  renameTerminalTarget, TERMINAL_RENAME_CONTEXT_ENV,
  type SurfaceRenameContext, type TerminalRenameTarget,
} from "../src/index.ts";

function contextEnv(context: SurfaceRenameContext): NodeJS.ProcessEnv {
  return { [TERMINAL_RENAME_CONTEXT_ENV]: JSON.stringify(context) };
}

test("tmux resolves fixed window/session IDs without depending on focus or legacy opt-ins", () => {
  for (const value of [undefined, "0", "1"]) {
    const queries: string[][] = [];
    const results = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "tmux", env: {
      TMUX_PANE: "%own", PI_SUBAGENT_RENAME_TMUX_WINDOW: value, PI_SUBAGENT_RENAME_TMUX_SESSION: value,
    } }, (_command, args) => {
      queries.push(args);
      return args.at(-1) === "#{window_id}" ? "@own" : "$own";
    });
    assert.deepEqual(results.map((result) => result.status === "ready" && result.reference.id), ["$own", "@own"]);
    assert.ok(queries.every((args) => args.includes("%own")));
  }
  assert.deepEqual(resolveTerminalRenameTargets({ tab: false, workspace: false, backend: "tmux", env: {} }), []);
});

test("Orca uses its explicit terminal identity and reports workspace unsupported", () => {
  assert.deepEqual(resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "orca", env: {
    ORCA_TERMINAL_HANDLE: "term_own",
  } }), [
    { status: "skipped", operation: "workspace", reason: "unsupported" },
    { status: "ready", reference: { backend: "orca", operation: "tab", target: "terminal", id: "term_own", scope: "shared" } },
  ]);
  assert.deepEqual(resolveTerminalRenameTargets({ tab: true, workspace: false, backend: "orca", env: {} }), [
    { status: "skipped", operation: "tab", reason: "missing-id" },
  ]);
});

for (const backend of ["tmux", "orca"] as const) {
  test(`${backend} children never inherit shared window/tab rename permissions`, () => {
    const context = createSurfaceRenameContext("child", backend);
    assert.equal(context.ownedTarget, null);
    assert.deepEqual(resolveTerminalRenameTargets({ tab: true, workspace: true, backend, env: {
      ...contextEnv(context), TMUX_PANE: "%parent", ORCA_TERMINAL_HANDLE: "term_parent",
    } }), [
      { status: "skipped", operation: "workspace", reason: "shared" },
      { status: "skipped", operation: "tab", reason: "unverified" },
    ]);
  });
}

test("invalid or obsolete ownership contexts fail rather than granting parent permissions", () => {
  for (const raw of ["{", "null", JSON.stringify({ version: 2 }), JSON.stringify({
    ...createSurfaceRenameContext("child", "tmux"), ownedTarget: { target: "tab", id: "parent" },
  }), JSON.stringify({ version: 1, backend: "cmux", surface: "old", ownedTarget: null })]) {
    assert.throws(() => readSurfaceRenameContext({ [TERMINAL_RENAME_CONTEXT_ENV]: raw }));
  }
  const results = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "tmux", env: {
    PI_SUBAGENT_ID: "legacy", TMUX_PANE: "%parent",
  } });
  assert.ok(results.every((result) => result.status === "skipped"));
  assert.equal(readSurfaceRenameContext({}), undefined);
});

test("headless and missing identities never trigger a rename", () => {
  const context = createSurfaceRenameContext("headless:child", "orca");
  assert.equal(context.backend, null);
  assert.equal(context.ownedTarget, null);
  assert.deepEqual(resolveTerminalRenameTargets({ tab: false, workspace: false, backend: null, env: {} }), []);
  assert.deepEqual(resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "tmux", env: {} }), [
    { status: "skipped", operation: "workspace", reason: "missing-id" },
    { status: "skipped", operation: "tab", reason: "missing-id" },
  ]);
});

test("query failures remain per-target failures", () => {
  const results = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "tmux", env: { TMUX_PANE: "%own" } },
    () => { throw new Error("query failed"); });
  assert.ok(results.every((result) => result.status === "failed" && result.error === "query failed"));
});

test("tmux passes names as argv against the captured identity", () => {
  const calls: Array<[string, string[]]> = [];
  const dependencies = { run: (command: string, args: string[]) => { calls.push([command, args]); }, renameOrca: () => true };
  const reference: TerminalRenameTarget = { backend: "tmux", operation: "workspace", target: "session", id: "$own", scope: "shared" };
  const title = "title ' $(not-a-command)";
  assert.equal(renameTerminalTarget(reference, title, dependencies).status, "renamed");
  assert.deepEqual(calls, [["tmux", ["rename-session", "-t", "$own", title]]]);
  const failed = renameTerminalTarget(reference, title, { ...dependencies, run: () => { throw new Error("failure"); } });
  assert.deepEqual(failed, { status: "failed", operation: "workspace", error: "failure" });
  assert.equal(renameTerminalTarget({ ...reference, id: "" }, title, dependencies).status, "failed");
});

test("Orca success and failure come from the injected backend, without touching the local runtime", () => {
  const calls: Array<[string, string]> = [];
  const reference: TerminalRenameTarget = { backend: "orca", operation: "tab", target: "terminal", id: "term_own", scope: "shared" };
  const result = renameTerminalTarget(reference, "Task", {
    run: () => assert.fail("unexpected tmux command"),
    renameOrca: (id, title) => { calls.push([id, title]); return true; },
  });
  assert.equal(result.status, "renamed");
  assert.deepEqual(calls, [["term_own", "Task"]]);
  assert.equal(renameTerminalTarget(reference, "Task", { run: () => {}, renameOrca: () => false }).status, "failed");
});
