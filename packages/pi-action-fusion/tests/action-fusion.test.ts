/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Adapted upstream action-fusion regression tests (NVlabs/SoL-Pi).
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createEditToolDefinition, createWriteToolDefinition, type BashOperations, type EditToolDetails, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createActionFusionExtension, type ActionFusionOptions } from "../src/action-fusion.ts";
import { resolveToolPath, withFusedFileQueue } from "../src/file-queue.ts";
import { assertUnchangedBeforeCommand, executeMutationThenRun, resultText, THEN_RUN_FAILED, THEN_RUN_RUNNING, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED, type ActionFusionDetails } from "../src/then-run.ts";

const bounded = { timeout: 5_000 };

async function temporaryDirectory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-action-fusion-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context(cwd: string): ExtensionContext {
  return {
    cwd, hasUI: false, model: undefined, ui: {},
    sessionManager: {
      getSessionId: () => "action-fusion-regression",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function tools(options: ActionFusionOptions = {}) {
  const registered = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      assert.ok(!registered.has(tool.name), `duplicate tool: ${tool.name}`);
      registered.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  // No session_start, config, shell, or UI is needed by the explicit factory.
  createActionFusionExtension(options)(pi);
  assert.deepEqual([...registered.keys()].sort(), ["edit", "write"]);
  return { edit: registered.get("edit")!, write: registered.get("write")! };
}

function bash(exec: BashOperations["exec"]): Pick<ActionFusionOptions, "bashOptions"> {
  return { bashOptions: { operations: { exec }, exposeSessionEnvironment: false } };
}

function fusion(result: AgentToolResult<unknown>): ActionFusionDetails["actionFusion"] {
  const details = result.details as Partial<ActionFusionDetails> | undefined;
  assert.ok(details?.actionFusion);
  return details.actionFusion;
}

function execute(
  tool: Pick<ToolDefinition, "execute">, cwd: string, args: Record<string, unknown>,
  signal?: AbortSignal, onUpdate?: (result: AgentToolResult<unknown>) => void,
) {
  return tool.execute("fusion-regression", args, signal, onUpdate, context(cwd));
}

test("factory registers native schemas with optional then_run and preserves edit preparation", () => {
  const { edit, write } = tools();
  for (const [tool, native, args] of [
    [edit, createEditToolDefinition(process.cwd()), { path: "a", edits: [{ oldText: "a", newText: "b" }] }],
    [write, createWriteToolDefinition(process.cwd()), { path: "a", content: "b" }],
  ] as const) {
    const schema = tool.parameters as unknown as {
      properties: Record<string, { type?: string; minLength?: number; properties?: Record<string, { type: string }>; required?: string[] }>;
      required: string[];
    };
    const nativeSchema = native.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(schema.properties), [...Object.keys(nativeSchema.properties), "then_run"]);
    assert.deepEqual(schema.required, nativeSchema.required);
    for (const key of Object.keys(nativeSchema.properties)) {
      assert.deepEqual(schema.properties[key], nativeSchema.properties[key]);
    }
    const thenRun = schema.properties.then_run;
    assert.equal(thenRun.type, "object");
    assert.deepEqual(thenRun.required, ["command"]);
    assert.equal(thenRun.properties?.command.type, "string");
    assert.equal(thenRun.properties?.timeout.type, "number");
    assert.ok(!schema.required.includes("then_run"));
    assert.ok(Value.Check(tool.parameters, args));
    assert.ok(Value.Check(tool.parameters, { ...args, then_run: { command: "check", timeout: 12 } }));
    for (const invalid of [{}, { command: "" }, { command: 1 }, { command: "check", timeout: "12" }]) {
      assert.equal(Value.Check(tool.parameters, { ...args, then_run: invalid }), false);
    }
    assert.deepEqual(tool.promptGuidelines?.slice(0, -1), native.promptGuidelines);
  }
  assert.ok(edit.prepareArguments);
  const replacement = { oldText: "before", newText: "after" };
  const then_run = { command: "check", timeout: 3 };
  for (const input of [
    { path: "a", edits: JSON.stringify([replacement]), then_run },
    { path: "a", edits: JSON.stringify(replacement), then_run },
    { path: "a", edits: replacement, then_run },
    { path: "a", ...replacement, then_run },
  ]) {
    const prepared = edit.prepareArguments(input);
    assert.deepEqual(prepared, { path: "a", edits: [replacement], then_run });
    assert.equal(prepared.then_run, then_run);
    assert.ok(Value.Check(edit.parameters, prepared));
  }
});

test("quiet commands publish saved mutation and running state before shell execution", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const updates: AgentToolResult<unknown>[] = [];
  const { write } = tools(bash(async () => {
    assert.ok(updates.length > 0, "running progress must not depend on shell stdout");
    assert.equal(fusion(updates[0]).status, "running");
    assert.match(resultText(updates[0]), /Successfully wrote/);
    assert.ok(resultText(updates[0]).includes(THEN_RUN_RUNNING));
    return { exitCode: 0 };
  }));
  const result = await execute(write, dir, { path: "quiet.txt", content: "saved\n", then_run: { command: "quiet-check" } }, undefined, (update) => updates.push(update));
  assert.equal(fusion(result).status, "succeeded");
  assert.equal(await readFile(join(dir, "quiet.txt"), "utf8"), "saved\n");
});

test("write is visible before command; command/cwd/timeout/signal and streaming updates survive", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "written.txt");
  const controller = new AbortController();
  const updates: AgentToolResult<unknown>[] = [];
  let calls = 0;
  const command = "check 'written.txt' && report";
  const { write } = tools(bash(async (actualCommand, cwd, options) => {
    calls++;
    assert.equal(actualCommand, command);
    assert.equal(cwd, dir);
    assert.equal(options.timeout, 12);
    assert.equal(options.signal, controller.signal);
    assert.equal(typeof options.onData, "function");
    assert.equal(await readFile(file, "utf8"), "new content\n");
    options.onData(Buffer.from("write check passed\n"));
    return { exitCode: 0 };
  }));
  const result = await execute(write, dir, {
    path: "written.txt", content: "new content\n", then_run: { command, timeout: 12 },
  }, controller.signal, (update) => updates.push(update));
  assert.equal(calls, 1);
  assert.equal(fusion(result).status, "succeeded");
  assert.equal(fusion(result).command, command);
  assert.match(resultText(result), /\[then_run:succeeded\]\nwrite check passed/);
  assert.ok(updates.length >= 2);
  for (const update of updates) {
    assert.equal(fusion(update).status, "running");
    assert.equal(fusion(update).command, command);
    assert.match(resultText(update), /Successfully/);
    assert.ok(resultText(update).includes(THEN_RUN_RUNNING));
  }
  assert.ok(updates.some((update) => resultText(update).includes("write check passed")));
});

test("native multi-replacement edit preserves diff, unified patch and firstChangedLine", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const original = "alpha\nunchanged\nomega\n";
  const edits = [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "omega", newText: "OMEGA" }];
  await writeFile(join(dir, "target.txt"), original);
  const native = createEditToolDefinition(dir);
  const expected = await execute(native, dir, { path: "target.txt", edits });
  await writeFile(join(dir, "target.txt"), original);
  let calls = 0;
  const updates: AgentToolResult<unknown>[] = [];
  const { edit } = tools(bash(async (command, cwd, { onData, timeout }) => {
    calls++;
    assert.equal(command, "check edit");
    assert.equal(cwd, dir);
    assert.equal(timeout, undefined);
    assert.equal(await readFile(join(dir, "target.txt"), "utf8"), "ALPHA\nunchanged\nOMEGA\n");
    onData(Buffer.from("edit check passed\n"));
    return { exitCode: 0 };
  }));
  const result = await execute(edit, dir, { path: "target.txt", edits, then_run: { command: "check edit" } },
    undefined, (update) => updates.push(update));
  assert.equal(calls, 1);
  assert.deepEqual(result.content.slice(0, -1), expected.content);
  const details = result.details as EditToolDetails & ActionFusionDetails;
  assert.deepEqual({ diff: details.diff, patch: details.patch, firstChangedLine: details.firstChangedLine }, expected.details);
  assert.match(details.diff, /ALPHA/);
  assert.match(details.diff, /OMEGA/);
  assert.match(details.patch, /@@/);
  assert.match(details.patch, /-alpha/);
  assert.match(details.patch, /\+ALPHA/);
  assert.ok(resultText(result).includes(THEN_RUN_SUCCEEDED));
  for (const update of updates) {
    assert.equal((update.details as EditToolDetails).patch, details.patch);
    assert.equal((update.details as EditToolDetails).diff, details.diff);
  }
});

test("without then_run native edit/write results are unchanged and bash is never called", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const { write, edit } = tools(bash(async () => { assert.fail("bash must not run"); }));
  const writeArgs = { path: "plain.txt", content: "before\n" };
  const nativeWrite = await execute(createWriteToolDefinition(dir), dir, writeArgs);
  assert.deepEqual(await execute(write, dir, writeArgs), nativeWrite);
  const editArgs = { path: "plain.txt", edits: [{ oldText: "before", newText: "after" }] };
  const expected = await execute(createEditToolDefinition(dir), dir, editArgs);
  await writeFile(join(dir, "plain.txt"), "before\n");
  assert.deepEqual(await execute(edit, dir, editArgs), expected);
  assert.equal(await readFile(join(dir, "plain.txt"), "utf8"), "after\n");

  const untouched: AgentToolResult<{ sentinel: number }> = { content: [{ type: "text", text: "native" }], details: { sentinel: 1 } };
  const result = await executeMutationThenRun({
    toolCallId: "identity", absolutePath: join(dir, "identity.txt"), ctx: context(dir),
    mutate: async () => untouched,
    ...bash(async () => { assert.fail("bash must not run"); }),
  });
  assert.equal(result, untouched);
});

test("mutation failures skip command and leave content intact", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const { edit, write } = tools(bash(async () => { assert.fail("failed mutation must skip bash"); }));
  const file = join(dir, "unchanged.txt");
  await writeFile(file, "unique\nrepeat repeat\n");
  for (const args of [
    { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
    { path: file, edits: [{ oldText: "absent", newText: "b" }] },
    { path: file, edits: [{ oldText: "repeat", newText: "b" }] },
    { path: file, edits: [{ oldText: "unique", newText: "a" }, { oldText: "nique", newText: "b" }] },
  ]) {
    await assert.rejects(execute(edit, dir, { ...args, then_run: { command: "must not run" } }), /\[then_run:skipped\]/);
    assert.equal(await readFile(file, "utf8"), "unique\nrepeat repeat\n");
  }
  // Writing over a directory is an actual native write failure, not a mocked fused error.
  await assert.rejects(execute(write, dir, { path: dir, content: "x", then_run: { command: "must not run" } }), /\[then_run:skipped\]/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute(write, dir, { path: file, content: "no", then_run: { command: "no" } }, controller.signal), /\[then_run:skipped\]/);
  assert.equal(await readFile(file, "utf8"), "unique\nrepeat repeat\n");
  await assert.rejects(execute(edit, dir, { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }),
    (error: unknown) => error instanceof Error && !error.message.includes(THEN_RUN_SKIPPED));
});

test("empty commands are rejected before mutation even outside schema validation", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "unchanged.txt");
  await writeFile(file, "keep");
  const { write } = tools(bash(async () => { assert.fail("invalid command must not run"); }));
  for (const command of ["", " \t\n", 123, null]) {
    await assert.rejects(execute(write, dir, { path: file, content: "replace", then_run: { command } }));
    assert.equal(await readFile(file, "utf8"), "keep");
  }
});

for (const scenario of ["nonzero", "null-exit", "exception", "cancel", "timeout"] as const) {
  test(`command ${scenario} throws failed marker, preserves mutation and releases queue`, bounded, async (t) => {
    const dir = await temporaryDirectory(t);
    const file = join(dir, "preserved.txt");
    const controller = new AbortController();
    let calls = 0;
    const { write } = tools(bash(async (command, cwd, options) => {
      calls++;
      assert.equal(command, "validate");
      assert.equal(cwd, dir);
      assert.equal(options.timeout, 7);
      assert.equal(options.signal, controller.signal);
      assert.equal(await readFile(file, "utf8"), "keep me\n");
      options.onData(Buffer.from("validation output\n"));
      if (scenario === "nonzero") return { exitCode: 7 };
      if (scenario === "null-exit") return { exitCode: null };
      if (scenario === "exception") throw new Error("injected exec failure");
      if (scenario === "cancel") {
        controller.abort();
        assert.ok(options.signal?.aborted);
        throw new Error("aborted");
      }
      throw new Error("timeout:7");
    }));
    const message = {
      nonzero: /Command exited with code 7/,
      "null-exit": /Command terminated without an exit code/,
      exception: /injected exec failure/,
      cancel: /Command aborted/,
      timeout: /Command timed out after 7 seconds/,
    }[scenario];
    await assert.rejects(execute(write, dir, {
      path: file, content: "keep me\n", then_run: { command: "validate", timeout: 7 },
    }, controller.signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(THEN_RUN_FAILED));
      assert.match(error.message, /Successfully/);
      assert.match(error.message, message);
      if (scenario !== "exception") assert.match(error.message, /validation output/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(await readFile(file, "utf8"), "keep me\n");
    await execute(write, dir, { path: file, content: "next" });
    assert.equal(await readFile(file, "utf8"), "next");
    assert.equal(calls, 1);
  });
}

test("failed edit follow-up does not roll back the completed multi-replacement mutation", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "edited.txt");
  await writeFile(file, "alpha\nmiddle\nomega\n");
  const { edit } = tools(bash(async (command, cwd, { onData }) => {
    assert.equal(command, "check edit");
    assert.equal(cwd, dir);
    assert.equal(await readFile(file, "utf8"), "ALPHA\nmiddle\nOMEGA\n");
    onData(Buffer.from("edit validation failed"));
    return { exitCode: 9 };
  }));
  await assert.rejects(execute(edit, dir, {
    path: file,
    edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "omega", newText: "OMEGA" }],
    then_run: { command: "check edit" },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(THEN_RUN_FAILED));
    assert.match(error.message, /Successfully replaced 2 block/);
    assert.match(error.message, /edit validation failed/);
    assert.match(error.message, /Command exited with code 9/);
    return true;
  });
  assert.equal(await readFile(file, "utf8"), "ALPHA\nmiddle\nOMEGA\n");
});

test("large successful stdout keeps truncation and fullOutputPath nested in bashDetails", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const output = Array.from({ length: 3_000 }, (_, i) => `line ${i}: ${"x".repeat(40)}\n`).join("");
  const outputFiles = new Set<string>();
  t.after(async () => { await Promise.all([...outputFiles].map((file) => rm(file, { force: true }))); });
  const { write } = tools(bash(async (_command, _cwd, { onData }) => {
    onData(Buffer.from(output));
    return { exitCode: 0 };
  }));
  const result = await execute(write, dir, { path: "large.txt", content: "ok", then_run: { command: "large output" } },
    undefined, (update) => {
      const path = fusion(update).bashDetails?.fullOutputPath;
      if (path) outputFiles.add(path);
    });
  const details = fusion(result);
  const outputPath = details.bashDetails?.fullOutputPath;
  assert.ok(outputPath);
  outputFiles.add(outputPath);
  assert.equal(details.status, "succeeded");
  assert.equal(details.command, "large output");
  assert.equal(details.bashDetails?.truncation?.truncated, true);
  assert.equal((result.details as Record<string, unknown>).fullOutputPath, undefined);
  assert.equal((result.details as Record<string, unknown>).truncation, undefined);
  assert.equal(await readFile(outputPath, "utf8"), output);
  assert.ok(resultText(result).includes(THEN_RUN_SUCCEEDED));
  assert.ok(resultText(result).includes(outputPath));
  assert.match(resultText(result), /line 2999:/);
});

for (const alias of ["relative", "symlink-file", "symlink-parent-missing-target"] as const) {
  test(`same-file ${alias} queue includes command, while different files can progress`, bounded, async (t) => {
    const dir = await temporaryDirectory(t);
    const realDir = join(dir, "real");
    await mkdir(realDir);
    const file = join(realDir, "ordered.txt");
    let aliasPath = join("real", "..", "real", "ordered.txt");
    if (alias === "symlink-file") {
      await writeFile(file, "initial");
      const link = join(dir, "alias.txt");
      try { await symlink(file, link); }
      catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink permission unavailable");
        throw error;
      }
      aliasPath = link;
    } else if (alias === "symlink-parent-missing-target") {
      const link = join(dir, "alias-dir");
      try { await symlink(realDir, link, process.platform === "win32" ? "junction" : "dir"); }
      catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink permission unavailable");
        throw error;
      }
      aliasPath = join(link, "ordered.txt");
    }
    const started = deferred();
    const finish = deferred();
    const events: string[] = [];
    const { write } = tools({
      ...bash(async (command, cwd) => {
        assert.equal(command, "block");
        assert.equal(cwd, dir);
        events.push("command:start");
        started.resolve();
        await finish.promise;
        assert.equal(await readFile(file, "utf8"), "first");
        events.push("command:end");
        return { exitCode: 0 };
      }),
      writeOptions: { operations: {
        mkdir: (path) => mkdir(path, { recursive: true }).then(() => {}),
        writeFile: async (path, content) => {
          events.push(`write:${content}`);
          await writeFile(path, content);
        },
      } },
    });
    const first = execute(write, dir, { path: file, content: "first", then_run: { command: "block" } });
    let second: ReturnType<typeof execute> | undefined;
    try {
      await started.promise;
      second = execute(write, dir, { path: aliasPath, content: "second" });
      // A completed unrelated write is a progress barrier, not a timing-based sleep.
      await execute(write, dir, { path: "different.txt", content: "different" });
      assert.deepEqual(events, ["write:first", "command:start", "write:different"]);
      assert.equal(await readFile(file, "utf8"), "first");
    } finally {
      finish.resolve();
      await Promise.all([first, ...(second ? [second] : [])]);
    }
    assert.deepEqual(events, ["write:first", "command:start", "write:different", "command:end", "write:second"]);
    assert.equal(await readFile(file, "utf8"), "second");
  });
}

test("direct queue serializes aliases, propagates failure and releases already waiting work", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "queued.txt");
  await writeFile(file, "initial");
  const link = join(dir, "alias.txt");
  try { await symlink(file, link); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink permission unavailable");
    throw error;
  }
  const started = deferred();
  const finish = deferred();
  const events: string[] = [];
  const failure = new Error("queue failure");
  const first = withFusedFileQueue(file, async () => {
    events.push("first:start");
    started.resolve();
    await finish.promise;
    events.push("first:fail");
    throw failure;
  });
  const rejected = assert.rejects(first, (error: unknown) => error === failure);
  await started.promise;
  const second = withFusedFileQueue(link, async () => { events.push("second"); return 42; });
  try {
    await withFusedFileQueue(join(dir, "other.txt"), async () => { events.push("other"); });
    assert.deepEqual(events, ["first:start", "other"]);
  } finally {
    finish.resolve();
    await rejected;
  }
  assert.equal(await second, 42);
  assert.deepEqual(events, ["first:start", "other", "first:fail", "second"]);
  assert.equal(await withFusedFileQueue(file, async () => "released"), "released");
});

test("guard accepts stable content but rejects external replacement, deletion and cancellation", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "guard.txt");
  await writeFile(file, "mutation");
  let yielded = false;
  await assertUnchangedBeforeCommand(file, async () => { yielded = true; });
  assert.ok(yielded);
  await assertUnchangedBeforeCommand(file); // Also exercise the default setImmediate yield.
  await assert.rejects(assertUnchangedBeforeCommand(file, () => writeFile(file, "external")), /\[then_run:skipped\]/);
  assert.equal(await readFile(file, "utf8"), "external");
  await assert.rejects(assertUnchangedBeforeCommand(file, () => rm(file)), /\[then_run:skipped\]/);
  await assert.rejects(assertUnchangedBeforeCommand(file), /\[then_run:skipped\]/);
  await writeFile(file, "stable");
  const controller = new AbortController();
  await assert.rejects(assertUnchangedBeforeCommand(file, async () => { controller.abort(); }, controller.signal), /\[then_run:skipped\]/);
  await assert.rejects(assertUnchangedBeforeCommand(file, async () => { assert.fail("must not yield when already aborted"); }, controller.signal), /\[then_run:skipped\]/);
});

test("post-mutation guard failure skips bash, includes mutation result and releases queue", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "vanished.txt");
  const mutation: AgentToolResult<undefined> = { content: [{ type: "text", text: "mutation completed" }], details: undefined };
  await assert.rejects(executeMutationThenRun({
    toolCallId: "guard", absolutePath: file, thenRun: { command: "must not run" }, ctx: context(dir),
    mutate: async () => { await writeFile(file, "changed"); await rm(file); return mutation; },
    ...bash(async () => { assert.fail("guard must skip bash"); }),
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /mutation completed/);
    assert.ok(error.message.includes(THEN_RUN_SKIPPED));
    assert.ok(!error.message.includes(THEN_RUN_FAILED));
    return true;
  });
  await withFusedFileQueue(file, async () => { await writeFile(file, "recovered"); });
  assert.equal(await readFile(file, "utf8"), "recovered");
});

test("cancellation after mutation is skipped rather than command failure and does not roll back", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "cancelled.txt");
  const controller = new AbortController();
  await assert.rejects(executeMutationThenRun({
    toolCallId: "cancel-after-mutation", absolutePath: file, thenRun: { command: "must not run" },
    ctx: context(dir), signal: controller.signal,
    mutate: async () => {
      await writeFile(file, "completed mutation");
      controller.abort();
      return { content: [{ type: "text", text: "mutation succeeded" }], details: undefined };
    },
    ...bash(async () => { assert.fail("cancelled guard must skip bash"); }),
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /mutation succeeded/);
    assert.ok(error.message.includes(THEN_RUN_SKIPPED));
    assert.ok(!error.message.includes(THEN_RUN_FAILED));
    return true;
  });
  assert.equal(await readFile(file, "utf8"), "completed mutation");
  assert.equal(await withFusedFileQueue(file, async () => "released"), "released");
});

test("resolveToolPath normalizes file URLs, @, ~, dot segments and Unicode spaces", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "测试 file.txt");
  for (const input of [
    file, "测试 file.txt", "@测试 file.txt", "./nested/../测试 file.txt",
    pathToFileURL(file).href, `@${pathToFileURL(file).href}`,
    ...["\u00a0", "\u2000", "\u2007", "\u200a", "\u202f", "\u205f", "\u3000"].map((space) => `测试${space}file.txt`),
  ]) {
    assert.equal(resolveToolPath(dir, input), file, input);
  }
  // Only resolve home paths; never read/write the user's home directory.
  assert.equal(resolveToolPath(dir, "~"), homedir());
  assert.equal(resolveToolPath(dir, "~/fusion-test/../target.txt"), resolve(homedir(), "target.txt"));
  assert.equal(resolveToolPath(dir, "@~/target.txt"), resolve(homedir(), "target.txt"));
});

test("native write/edit and guard agree on normalized target paths", bounded, async (t) => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, "测试 file.txt");
  let calls = 0;
  const { write, edit } = tools(bash(async (command, cwd) => {
    calls++;
    assert.equal(cwd, dir);
    assert.equal(await readFile(file, "utf8"), command === "write check" ? "before" : "after");
    return { exitCode: 0 };
  }));
  for (const path of ["@测试\u202ffile.txt", pathToFileURL(file).href]) {
    const written = await execute(write, dir, { path, content: "before", then_run: { command: "write check" } });
    assert.equal(fusion(written).status, "succeeded");
    const edited = await execute(edit, dir, {
      path, edits: [{ oldText: "before", newText: "after" }], then_run: { command: "edit check" },
    });
    assert.equal(fusion(edited).status, "succeeded");
    await access(file);
  }
  assert.equal(calls, 4);
});
