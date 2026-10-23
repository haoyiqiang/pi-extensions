import { mock, test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import subagents from "../pi-extension/subagents/index.ts";
import { shellEscape } from "@kevinhao/pi-terminal-mux";
import { createMockExtensionApi, plainTheme, waitFor } from "./harness.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const task = "Return the exact phrase: identity retained.";
async function withIdentity(run: (h: any) => Promise<void>, fixture = "runtime.ts") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-identity-")));
  const env = { ...process.env };
  const terminal = join(root, "terminal");
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const bin = join(root, "bin");
  for (const dir of [join(project, ".pi/agents"), terminal, sessions, bin]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(testDir, "fixtures/terminal.mjs"), join(bin, "tmux"));
  const command = [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), join(testDir, "fixtures", fixture)].map(shellEscape).join(" ");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  Object.assign(process.env, { PATH: `${bin}:${env.PATH}`, PI_TERMINAL_MUX: "tmux", TMUX: "fixture", TMUX_PANE: "%fixture-parent", PI_CODING_AGENT_DIR: join(root, "config"), SUBAGENT_TEST_TERMINAL: terminal, SUBAGENT_TEST_TERMINAL_BASE: terminal });
  writeFileSync(join(project, ".pi/agents/echo.md"), "---\nname: echo\ntools: read\n---\nEcho identity\n");
  const parentFile = join(sessions, "parent.jsonl");
  writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "identity-parent", cwd: project }) + "\n");
  const parent = createMockExtensionApi();
  const widgets: string[] = [];
  parent.api.getThinkingLevel = () => "off";
  const ctx = {
    cwd: project, hasUI: true, model: { provider: "fixture", id: "parent-model" },
    modelRegistry: { getAll: () => [{ provider: "fixture", id: "parent-model" }] },
    sessionManager: { getSessionFile: () => parentFile, getSessionId: () => "identity-parent", getSessionDir: () => sessions },
    ui: { setWidget(_name: string, factory: any) { if (typeof factory === "function") widgets.push(factory({}, plainTheme).render(100).join("\n")); } },
  };
  const call = (tool: string, params: any, context = ctx) => parent.tool(tool).execute("identity", params, undefined, undefined, context);
  // Queue/persistence cases run actual Pi, whose cold module import time is not
  // the behavior under test. Freeze only the controller's startup deadline while
  // still requiring a real child-ready signal; node:test's real timeout remains.
  // Production startup deadlines have their own controlled-clock terminal suite.
  const boot = async (tool: string, params: any) => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try { return await call(tool, params); } finally { mock.timers.reset(); }
  };
  try {
    subagents(parent.api);
    await parent.emit("session_start", {}, ctx);
    await run({ root, parent, ctx, call, boot, terminal, sessions, project, widgets });
  } catch (error) {
    for (const file of readdirSync(terminal, { recursive: true }).map(String).filter((file) => /(^|\/)(screen|provider-input.jsonl|settlements)$/.test(file))) console.error(file, readFileSync(join(terminal, file), "utf8"));
    throw error;
  } finally {
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    const terminals = [terminal, ...readdirSync(terminal, { recursive: true }).map(String).filter((file) => file.endsWith("/pid")).map((file) => dirname(join(terminal, file)))];
    for (const directory of terminals) if (existsSync(join(directory, "pid"))) { try { process.kill(-Number(readFileSync(join(directory, "pid"), "utf8")), "SIGKILL"); } catch {} }
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
}

test("normal parent quit suspends and restores known work with an explicit continuation, not the original task", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ boot, call, terminal, parent, ctx, project }) => {
    const launched = await boot("subagent", { agent: "echo", task: "Continue a known task after suspension" });
    const requests = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    await waitFor(() => requests()[0], "initial provider request");
    const original = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    const suspended = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(suspended.state, "suspended");
    assert.equal(suspended.liveness.writer, "exited");
    assert.equal(suspended.closure, "confirmed");
    assert.equal(suspended.checkpoint.wait, "continue");
    writeFileSync(join(project, ".pi/agents/echo.md"), "---\nname: echo\ntools: bash\nauto-exit: false\n---\nChanged role must not affect restoration\n");
    await parent.emit("session_start", { reason: "resume" }, ctx);
    const resumed = await waitFor(() => requests().find((request: any) => request.executionId !== original.executionId), "useful automatic provider continuation", 30_000);
    assert.match(resumed.inputs.at(-1), /continu(e|ation).*recorded|recorded.*continu(e|ation)/i);
    assert.notEqual(resumed.inputs.at(-1), requests()[0].inputs.at(-1));
    const running = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.deepEqual(running.loadout, original.loadout);
    assert.equal(running.generation, 2);
    writeFileSync(join(terminal, `release-${resumed.call}`), "complete");
    const result = await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result" && e.message.details.generation === 2), "continued settlement");
    assert.equal(result.message.details.outcome, "succeeded");
  }, "pi-runtime.ts");
});

test("safe suspension preserves never-dispatched followUp behind useful continuation of the current task", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ boot, call, terminal, parent, ctx }) => {
    const launched = await boot("subagent", { agent: "echo", task: "Known current work" });
    const requests = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    await waitFor(() => requests()[0], "initial active task");
    const pid = Number(readFileSync(join(terminal, "control-pid"), "utf8"));
    process.kill(pid, "SIGSTOP");
    let quitting: Promise<void>;
    try {
      await call("subagent_message", { id: launched.details.id, message: "Distinct queued follow-up", messageId: "safe-followup", deliverAs: "followUp" });
      quitting = parent.emit("session_shutdown", { reason: "quit" }, ctx);
    } finally { process.kill(pid, "SIGCONT"); }
    await quitting!;
    const suspended = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(suspended.messages.find((message: any) => message.id === "safe-followup").state, "queued");
    assert.equal(suspended.paused, false);
    await parent.emit("session_start", { reason: "resume" }, ctx);
    const continuation = await waitFor(() => requests()[1], "original task continuation first", 30_000);
    assert.match(continuation.inputs.at(-1), /new continuation/);
    assert.equal(continuation.inputs.includes("Distinct queued follow-up"), false);
    writeFileSync(join(terminal, `release-${continuation.call}`), "continue current work");
    const followup = await waitFor(() => requests()[2], "preserved followUp after continuation");
    assert.equal(followup.inputs.at(-1), "Distinct queued follow-up");
    writeFileSync(join(terminal, `release-${followup.call}`), "finish followUp");
    await waitFor(() => parent.sentMessages.find((event: any) => event.message.customType === "subagent_result" && event.message.details.generation === 2), "final settlement after queued followup");
  }, "pi-runtime.ts");
});

test("a suspended question keeps its exact wait and only the correlated event starts continuation", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ call, boot, terminal, parent, ctx }) => {
    const launched = await boot("subagent", { agent: "echo", task: "ASK_TWO" });
    const requests = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    const release = (request: any) => writeFileSync(join(terminal, `release-${request.call}`), "complete");
    const status = async () => (await call("subagent_status", { id: launched.details.id })).details.subagent;
    release(await waitFor(() => requests()[0], "ask two questions"));
    release(await waitFor(() => requests()[1], "question waiting response"));
    await waitFor(() => existsSync(join(terminal, "settlements")) ? true : undefined, "question wait");
    const questions = (await status()).questions;
    assert.equal(questions.length, 2);
    writeFileSync(join(terminal, "runtime-command.json"), JSON.stringify({ id: "abandoned-tail", action: "abandon-tail" }));
    await waitFor(() => existsSync(join(terminal, "command-abandoned-tail-done")) ? true : undefined, "active branch differs from physical tail");
    await parent.emit("session_shutdown", { reason: "new" }, ctx);
    assert.equal((await status()).checkpoint.wait, "question");
    await parent.emit("session_start", { reason: "resume" }, ctx);
    await waitFor(async () => (await status()).generation === 2 ? true : undefined, "restored question waiter");
    assert.equal(requests().length, 2, "history reopening is a preserved wait, not permission for a new model call");
    assert.deepEqual((await status()).questions.map((q: any) => q.questionId), questions.map((q: any) => q.questionId));
    for (const [index, question] of questions.entries()) {
      await call("subagent_message", { id: launched.details.id, message: `Answer ${index + 1}`, replyTo: question.questionId });
      const replyRequest = await waitFor(() => requests()[2 + index], "correlated answer provider request");
      assert.doesNotMatch(JSON.stringify(replyRequest.inputs), /Abandoned physical tail/);
      release(replyRequest);
    }
    const result = await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result" && e.message.details.generation === 2), "completion after exact answers");
    assert.equal(result.message.details.outcome, "succeeded");
  }, "pi-runtime.ts");
});

test("native stop retains history, enforces ownership and never restarts stopped work on normal restore", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx }) => {
    const launched = await call("subagent", { agent: "echo", task: `${task}\nLONG_TOOL` });
    const status = async () => (await call("subagent_status", { id: launched.details.id })).details.subagent;
    const foreign = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "different-parent" } };
    await assert.rejects(call("subagent_stop", { id: launched.details.id }, foreign), /owned by this parent/);
    await assert.rejects(call("subagent_stop", { id: launched.details.id, name: "different-name" }), /named|mismatch/);
    const stopped = await call("subagent_stop", { id: launched.details.id, name: launched.details.name });
    assert.equal(stopped.details.status, "stopped");
    const retained = await status();
    assert.equal(retained.state, "stopped");
    assert.deepEqual(retained.uncertainty.activeTools, ["long-tool"], "honest effect uncertainty is retained without disguising confirmed stop");
    assert.equal(retained.liveness.writer, "exited");
    assert.equal(retained.closure, "confirmed");
    assert.ok(existsSync(retained.sessionFile));
    const history = readFileSync(retained.sessionFile, "utf8");
    assert.match(history, /identity retained/);
    const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").split("\n").filter((line: string) => line.includes("split-window")).length;
    assert.equal((await call("subagent_stop", { name: retained.name })).details.status, "stopped");
    await parent.emit("session_shutdown", { reason: "new" }, ctx);
    await parent.emit("session_start", { reason: "resume" }, ctx);
    assert.equal((await status()).state, "stopped");
    assert.equal(readFileSync(retained.sessionFile, "utf8"), history);
    assert.equal(readFileSync(join(terminal, "commands.jsonl"), "utf8").split("\n").filter((line: string) => line.includes("split-window")).length, commands);
    await assert.rejects(call("subagent_message", { id: retained.id, message: task }), /explicitly stopped|explicit stop/i);
  });
});

test("an interrupted initial tool stays paused across normal restore until exact-action authorization", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx }) => {
    const launched = await call("subagent", { agent: "echo", task: `${task}\nLONG_TOOL` });
    await parent.emit("session_shutdown", { reason: "resume" }, ctx);
    const status = async () => (await call("subagent_status", { id: launched.details.id })).details.subagent;
    const suspended = await status();
    assert.equal(suspended.state, "paused-uncertain");
    assert.deepEqual(suspended.uncertainty.activeTools, ["long-tool"]);
    await parent.emit("session_start", { reason: "resume" }, ctx);
    assert.equal((await status()).executionId, launched.details.executionId ?? suspended.executionId);
    const queued = await call("subagent_message", { id: launched.details.id, message: "Unrelated independent follow-up" });
    assert.equal(queued.details.status, "paused-uncertain");
    assert.equal((await status()).generation, 1);
    await assert.rejects(call("subagent_message", { id: launched.details.id, authorization: { actionId: "wrong-action", decision: "retry", reason: "not specific" } }), /exact current uncertain/);
    // Reconcile only this affected tool; an ordinary restored parent never does so.
    writeFileSync(join(terminal, "finish"), "permit fixture completion");
    await call("subagent_message", { id: launched.details.id, message: "Return the exact phrase: authorized continuation.", authorization: { actionId: suspended.uncertainty.actionId, decision: "confirm-completed", reason: "Verified the affected external change; it must not be repeated" } });
    const resumed = await waitFor(async () => { const current = await status(); return current.generation === 2 ? current : undefined; }, "authorized replacement writer");
    assert.equal(resumed.paused, false);
  });
});

test("unknown closure and failed close retain ownership instead of reporting stopped or automatically relaunching", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx }) => {
    const launched = await call("subagent", { agent: "echo", task });
    writeFileSync(join(terminal, "inventory-unknown"), "fault");
    await assert.rejects(call("subagent_stop", { id: launched.details.id }), /unconfirmed/);
    let status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.state, "stopping");
    assert.equal(status.closure, "unconfirmed");
    assert.equal(status.liveness.writer, "exited");
    await parent.emit("session_shutdown", { reason: "new" }, ctx);
    await parent.emit("session_start", { reason: "resume" }, ctx);
    assert.equal((await call("subagent_status", { id: launched.details.id })).details.subagent.generation, 1);
    rmSync(join(terminal, "inventory-unknown"));
    writeFileSync(join(terminal, "close-fails"), "fault");
    // Deterministic clock advances the bounded close handshake, not a long sleep.
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const stopping = call("subagent_stop", { id: launched.details.id });
    mock.timers.tick(4_000);
    await assert.rejects(stopping, /unconfirmed/);
    mock.timers.reset();
    status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.state, "stopping");
    assert.match(status.diagnostic, /closure|Fixture closure failed/i);
    rmSync(join(terminal, "close-fails"));
    assert.equal((await call("subagent_stop", { id: launched.details.id })).details.status, "stopped");
  });
});

test("a bounded cooperative abort timeout is not a stopped writer or permission to restart", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx }) => {
    writeFileSync(join(terminal, "ignore-abort"), "fault: child does not honor cancellation");
    const launched = await call("subagent", { agent: "echo", task });
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      const stopping = call("subagent_stop", { id: launched.details.id });
      await waitFor(() => existsSync(join(terminal, "abort-requested")) ? true : undefined, "cooperative abort request reached real child");
      mock.timers.tick(4_000);
      await assert.rejects(stopping, /unconfirmed.*handshake|handshake.*timed out/i);
    } finally { mock.timers.reset(); }
    const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.state, "stopping");
    assert.equal(status.liveness.writer, "claimed-or-unknown");
    assert.equal(status.closure, "unconfirmed");
    assert.doesNotThrow(() => process.kill(Number(readFileSync(join(terminal, "control-pid"), "utf8")), 0));
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    await parent.emit("session_start", { reason: "resume" }, ctx);
    assert.equal((await call("subagent_status", { id: launched.details.id })).details.subagent.generation, 1);
    writeFileSync(join(terminal, "finish"), "child reaches its real settlement/exit boundary");
    await waitFor(() => { try { process.kill(Number(readFileSync(join(terminal, "control-pid"), "utf8")), 0); return undefined; } catch (error: any) { return error.code === "ESRCH" ? true : undefined; } }, "positive Pi process exit");
    assert.equal((await call("subagent_stop", { id: launched.details.id })).details.status, "stopped");
  });
});

test("a durable completion racing parent suspension wins and is never continued again", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx }) => {
    const launched = await call("subagent", { agent: "echo", task });
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    writeFileSync(join(terminal, "hold-exit"), "retain writer while outcome becomes durable");
    writeFileSync(join(terminal, "finish"), "complete");
    await waitFor(() => existsSync(join(terminal, "waiting-exit")) ? true : undefined, "durable outcome before writer exit");
    const starting = parent.emit("session_start", { reason: "reload" }, ctx);
    const quitting = parent.emit("session_shutdown", { reason: "quit" }, ctx);
    writeFileSync(join(terminal, "release-exit"), "positive writer exit");
    await starting;
    await quitting;
    const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.state, "completed");
    assert.equal(status.latestResult.outcome, "succeeded");
    assert.ok(existsSync(status.latestResult.resultFile));
    await parent.emit("session_start", { reason: "resume" }, ctx);
    assert.equal((await call("subagent_status", { id: launched.details.id })).details.subagent.generation, 1);
  });
});

test("launch allocates normalized unique explicit names and status retains identities", { timeout: 30_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent }) => {
    const first = await call("subagent", { agent: "echo", name: "  Reviewer  ", task });
    assert.equal(first.details.name, "Reviewer");
    assert.equal(first.details.generation, 1);
    writeFileSync(join(terminal, "finish"), "complete");
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "settlement");
    await waitFor(() => readFileSync(join(terminal, "surface"), "utf8") === "closed" ? true : undefined, "surface cleanup before fixture handle reuse");
    const second = await call("subagent", { agent: "echo", name: "Reviewer", task });
    assert.equal(second.details.name, "Reviewer-2");
    assert.notEqual(second.details.id, first.details.id);
    await assert.rejects(call("subagent_message", { id: first.details.id, name: second.details.name, message: task }), /mismatch/i);
    await assert.rejects(call("subagent_status", { id: first.details.id, name: second.details.name }), /mismatch/i);
    const listed = await call("subagent_status", {});
    assert.deepEqual(listed.details.subagents.map((r: any) => [r.id, r.name]), [[first.details.id, "Reviewer"], [second.details.id, "Reviewer-2"]]);
    const status = await call("subagent_status", { id: first.details.id, name: "Reviewer" });
    assert.equal(status.details.subagent.state, "completed");
    assert.equal(status.details.subagent.latestResult.outcome, "succeeded");
  });
});

test("native inbox preserves exact multiline instructions and reports enqueue separately from consumption", { timeout: 30_000 }, async () => {
  await withIdentity(async ({ call, terminal }) => {
    const launched = await call("subagent", { agent: "echo", task });
    const message = "  /not-a-command\r\n```ts\nconst x = 'λ';\n```\n\n  trailing spaces  \n";
    const queued = await call("subagent_message", { id: launched.details.id, message, messageId: "multiline-1", deliverAs: "followUp" });
    assert.equal(queued.details.status, "queued");
    assert.equal(queued.details.message.id, "multiline-1");
    assert.equal(queued.details.message.state, "queued");
    const accepted = await waitFor(asyncRead, "child acceptance");
    function asyncRead() {
      const file = join(terminal, "inbox-received.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    }
    assert.equal(accepted[0].content, message);
    assert.equal(accepted[0].options.deliverAs, "followUp");
    const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.messages[0].state, "accepted", "void in-memory queue return is not consumption");
    const duplicate = await call("subagent_message", { name: launched.details.name, message, messageId: "multiline-1", deliverAs: "followUp" });
    assert.equal(duplicate.details.message.sequence, 1);
    await assert.rejects(call("subagent_message", { id: launched.details.id, message: "different", messageId: "multiline-1" }), /message.*id.*different|conflict/i);
  });
});

test("supported Pi consumes steering before followUp, preserves bytes, and starts idle prompts without terminal keys", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ call, boot, terminal, project, parent }) => {
    writeFileSync(join(terminal, "gate-preparation"), "hold initial prompt before agent_start");
    writeFileSync(join(project, ".pi/agents/resident.md"), "---\nname: resident\ntools:\nauto-exit: false\n---\nStay available\n");
    const launched = await boot("subagent", { agent: "resident", task });
    const provider = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    const release = (request: any) => writeFileSync(join(terminal, `release-${request.call}`), "complete");
    await waitFor(() => existsSync(join(terminal, "preparing")) ? true : undefined, "actual Pi initial preparation boundary");
    const followUp = "\nnext automatic task\r\n  preserve this  \n";
    const steering = "  /literal-slash\n```js\nconst unicode = 'λ';\n```\n";
    await call("subagent_message", { id: launched.details.id, message: followUp, messageId: "follow-up", deliverAs: "followUp" });
    await call("subagent_message", { id: launched.details.id, message: steering, messageId: "steering", deliverAs: "auto" });
    const preparing = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.deepEqual(preparing.messages.map((m: any) => m.state), ["queued", "queued"], "minimum Pi's isIdle during preparation is not permission for a parallel prompt");
    assert.equal(provider().length, 0);
    writeFileSync(join(terminal, "release-preparation"), "continue the same initial run");
    const first = await waitFor(() => provider()[0], "initial real provider call");
    let status: any = await waitFor(async () => {
      const current = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return current.messages.every((m: any) => m.state === "accepted") ? current : undefined;
    }, "durable child acceptance while provider is gated");
    assert.deepEqual(status.messages.map((m: any) => m.state), ["accepted", "accepted"]);
    assert.ok(status.messages.every((m: any) => m.evidence.transcriptEntryId === null), "memory queueing is not durable transcript consumption");
    release(first);
    const second = await waitFor(() => provider()[1], "steering provider request");
    assert.equal(second.inputs.at(-1), steering);
    assert.equal(second.inputs.includes(followUp), false, "followUp waits behind the steered automatic run");
    status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.messages.find((m: any) => m.id === "steering").state, "consumed");
    release(second);
    const third = await waitFor(() => provider()[2], "followUp provider request");
    assert.equal(third.inputs.at(-1), followUp);
    release(third);
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "real Pi final settlement");
    status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.deepEqual(status.messages.map((m: any) => m.state), ["settled", "settled"]);
    const idle = await call("subagent_message", { id: launched.details.id, message: "idle prompt", messageId: "idle", deliverAs: "steer" });
    assert.equal(idle.details.generation, 2);
    const fourth = await waitFor(() => provider()[3], "idle prompt request");
    assert.equal(fourth.inputs.at(-1), "idle prompt");
    const inFlight = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(inFlight.state, "running", "the prior generation's settled result cannot complete this queued task");
    assert.equal(inFlight.latestResult.generation, 1);
    release(fourth);
    const completed = await waitFor(async () => {
      const current = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return current.latestResult?.generation === 2 ? current : undefined;
    }, "consumed instruction's generation-specific result");
    const result = JSON.parse(readFileSync(completed.latestResult.resultFile, "utf8"));
    assert.equal(result.generation, 2);
    assert.equal(result.subagentId, launched.details.id);
    assert.equal(result.source.instructionEntryId, completed.messages.find((message: any) => message.id === "idle").evidence.transcriptEntryId);
    const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8");
    assert.doesNotMatch(commands, /send-keys/, "native inbox must never type into the editor or shell");
  }, "pi-runtime.ts");
});

test("parallel children retain distinct questions and reject replies belonging to another child", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent }) => {
    process.env.SUBAGENT_TEST_MULTI = "1";
    const launched = await Promise.all(["First", "Second"].map((name) => call("subagent", { agent: "echo", name, task: `${task}\nASK_AFTER_INPUT\nASK_TWICE` })));
    for (const child of launched) writeFileSync(join(terminal, "surfaces", child.details.surface, "finish"), "reach questions");
    const children = await waitFor(async () => {
      const current = (await call("subagent_status", {})).details.subagents;
      return current.length === 2 && current.every((child: any) => child.questions.length === 2) ? current : undefined;
    }, "four independent questions");
    assert.equal(new Set(children.flatMap((child: any) => child.questions.map((q: any) => q.questionId))).size, 4);
    await waitFor(() => parent.sentMessages.filter((e: any) => e.message.customType === "subagent_question").length === 4 ? true : undefined, "all question notifications");
    await assert.rejects(call("subagent_message", { id: children[1].id, message: "wrong child", replyTo: children[0].questions[0].questionId }), /question.*child|question.*replyTo/i);
    assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 0);
    // Retrying a correlated logical message is safe, but cannot change its
    // question association or allocate another answer for the same question.
    const args = { id: children[0].id, message: "Use v2", messageId: "same-reply", replyTo: children[0].questions[0].questionId };
    const first = await call("subagent_message", args);
    const duplicate = await call("subagent_message", args);
    assert.equal(duplicate.details.message.id, first.details.message.id);
    assert.equal(duplicate.details.message.sequence, first.details.message.sequence);
    await assert.rejects(call("subagent_message", { ...args, replyTo: children[0].questions[1].questionId }), /conflict/i);
  });
});

test("supported Pi retains independent questions across reload and resolves only durably consumed correlated replies", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ call, boot, terminal, parent, ctx }) => {
    const launched = await boot("subagent", { agent: "echo", task: "ASK_TWO" });
    const requests = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    const release = (request: any) => writeFileSync(join(terminal, `release-${request.call}`), "complete");
    const status = async () => (await call("subagent_status", { id: launched.details.id })).details.subagent;
    release(await waitFor(() => requests()[0], "question tool request"));
    const questions = await waitFor(async () => {
      const current = await status();
      return current.questions?.length === 2 ? current.questions : undefined;
    }, "two independently queryable questions");
    assert.notEqual(questions[0].questionId, questions[1].questionId);
    const notifications = await waitFor(() => {
      const events = parent.sentMessages.filter((e: any) => e.message.customType === "subagent_question");
      return events.length === 2 ? events : undefined;
    }, "two question notifications");
    for (const event of notifications) {
      assert.equal(event.message.details.id, launched.details.id);
      assert.match(event.message.content, new RegExp(event.message.details.questionId));
      assert.match(event.message.content, /replyTo/);
    }
    release(await waitFor(() => requests()[1], "question followup"));
    await waitFor(() => existsSync(join(terminal, "settlements")) ? true : undefined, "initial boundary");
    // Real runtime replacement, not merely constructing another flag holder.
    writeFileSync(join(terminal, "runtime-command.json"), JSON.stringify({ id: "reload", action: "reload" }));
    await waitFor(() => existsSync(join(terminal, "command-reload-done")) ? true : undefined, "actual child reload");
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    await parent.emit("session_start", { reason: "reload" }, ctx);
    assert.deepEqual((await status()).questions.map((q: any) => q.questionId).sort(), questions.map((q: any) => q.questionId).sort());
    await assert.rejects(call("subagent_message", { id: launched.details.id, message: "wrong", replyTo: "unknown-question" }), /question/i);
    // Without replyTo this is a valid ordinary instruction, never an answer.
    await call("subagent_message", { id: launched.details.id, message: "Ordinary additional requirements", messageId: "ordinary" });
    const ordinary = await waitFor(() => requests()[2], "ordinary instruction");
    assert.ok((await status()).questions.every((q: any) => q.state !== "answered"));
    release(ordinary);
    await waitFor(async () => (await status()).messages.find((m: any) => m.id === "ordinary")?.state === "settled" ? true : undefined, "ordinary settlement");
    writeFileSync(join(terminal, "runtime-command.json"), JSON.stringify({ id: "human", action: "input", text: "Human clarification, not a reply" }));
    release(await waitFor(() => requests()[3], "human instruction"));
    await waitFor(() => existsSync(join(terminal, "command-human-done")) ? true : undefined, "human settlement");
    assert.ok((await status()).questions.every((q: any) => q.state !== "answered"));
    assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 0);
    // A correlated followUp accepted into a busy queue is not yet an answer.
    await call("subagent_message", { id: launched.details.id, message: "Unrelated gated work", messageId: "busy" });
    const busy = await waitFor(() => requests()[4], "busy run");
    const reply = await call("subagent_message", { id: launched.details.id, message: "Use v2", messageId: "answer-version", replyTo: questions[0].questionId, deliverAs: "followUp" });
    assert.equal(reply.details.id, launched.details.id);
    await waitFor(async () => (await status()).messages.find((m: any) => m.id === "answer-version")?.state === "accepted" ? true : undefined, "reply accepted in Pi queue");
    assert.equal((await status()).questions.find((q: any) => q.questionId === questions[0].questionId).state, "reply-queued");
    release(busy);
    const answer = await waitFor(() => requests()[5], "correlated reply consumption");
    assert.equal(answer.inputs.at(-1), "Use v2");
    assert.equal((await status()).questions.find((q: any) => q.questionId === questions[0].questionId).state, "answered");
    release(answer);
    await waitFor(async () => (await status()).messages.find((m: any) => m.id === "answer-version")?.state === "settled" ? true : undefined, "first answer settlement");
    await assert.rejects(call("subagent_message", { id: launched.details.id, message: "Reuse answer", replyTo: questions[0].questionId }), /already|answered/i);
    await call("subagent_message", { id: launched.details.id, message: "Still no implicit answer", messageId: "single-ordinary" });
    release(await waitFor(() => requests()[6], "ordinary with single pending question"));
    await waitFor(async () => (await status()).messages.find((m: any) => m.id === "single-ordinary")?.state === "settled" ? true : undefined, "single-question wait");
    assert.equal((await status()).questions.filter((q: any) => q.state !== "answered").length, 1);
    await call("subagent_message", { id: launched.details.id, message: "Use eu-west", replyTo: questions[1].questionId });
    release(await waitFor(() => requests()[7], "last explicit answer"));
    const result = await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "final result after all replies");
    assert.equal(result.message.details.id, launched.details.id);
    assert.equal(result.message.details.outcome, "succeeded");
    assert.ok((await status()).questions.every((q: any) => q.state === "answered"));
  }, "pi-runtime.ts");
});

for (const operation of ["suspend", "stop"] as const) test(`native ${operation} owns the full work tree and retains descendant waits across restoration`, { timeout: 180_000 }, async () => {
  await withIdentity(async ({ call, boot, terminal, project, parent, ctx }) => {
    process.env.SUBAGENT_TEST_MULTI = "1";
    writeFileSync(join(project, ".pi/agents/trunk.md"), "---\nname: trunk\ntools:\nsubagent_agents: branch\n---\nDelegate to branch\n");
    writeFileSync(join(project, ".pi/agents/branch.md"), "---\nname: branch\ntools:\nsubagent_agents: leaf\n---\nDelegate to leaf\n");
    writeFileSync(join(project, ".pi/agents/leaf.md"), "---\nname: leaf\ntools:\n---\nFinish leaf\n");
    const launched = await boot("subagent", { agent: "trunk", task: "NEST_PARENT" });
    const trunk = join(terminal, "surfaces", launched.details.surface);
    const requests = (root: string) => existsSync(join(root, "provider-input.jsonl")) ? readFileSync(join(root, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    const release = (root: string, request: any) => writeFileSync(join(root, `release-${request.call}`), "complete");
    const descendant = async (root: string) => waitFor(() => {
      const surfaces = join(root, "surfaces");
      const id = existsSync(surfaces) ? readdirSync(surfaces)[0] : undefined;
      return id ? join(surfaces, id) : undefined;
    }, "owned descendant surface", 45_000);
    release(trunk, await waitFor(() => requests(trunk)[0], "root delegation"));
    const branch = await descendant(trunk);
    release(trunk, await waitFor(() => requests(trunk)[1], "root waiting response", 45_000));
    release(branch, await waitFor(() => requests(branch)[0], "child delegation", 45_000));
    const leaf = await descendant(branch);
    release(branch, await waitFor(() => requests(branch)[1], "child waiting response", 45_000));
    await waitFor(() => requests(leaf)[0], "leaf active work", 45_000);
    await waitFor(() => existsSync(join(branch, "settlements")) && existsSync(join(trunk, "settlements")) ? true : undefined, "both descendant waiters settled");
    if (operation === "stop") {
      const result = await call("subagent_stop", { id: launched.details.id });
      assert.equal(result.details.status, "stopped");
      assert.equal(result.details.subagents.length, 3);
      assert.ok(result.details.subagents.every((run: any) => run.state === "stopped" && existsSync(run.sessionFile)));
    } else {
      await parent.emit("session_shutdown", { reason: "quit" }, ctx);
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(status.state, "suspended");
      assert.equal(status.checkpoint.wait, "descendants");
    }
    for (const root of [trunk, branch, leaf]) {
      assert.equal(readFileSync(join(root, "surface"), "utf8"), "closed");
      const pid = Number(readFileSync(join(root, "control-pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), (error: any) => error.code === "ESRCH", "all real Pi writers exited");
    }
    if (operation === "stop") await parent.emit("session_shutdown", { reason: "new" }, ctx);
    await parent.emit("session_start", { reason: "resume" }, ctx);
    if (operation === "stop") {
      assert.equal((await call("subagent_status", { id: launched.details.id })).details.subagent.state, "stopped");
      assert.equal(readdirSync(join(terminal, "surfaces")).length, 1, "stopped descendants must never relaunch");
      return;
    }
    const restored = await waitFor(async () => {
      const current = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return current.generation === 2 && current.state === "running" ? current : undefined;
    }, "root waiting writer restored", 45_000);
    const newTrunk = join(terminal, "surfaces", restored.surface);
    const newBranch = await descendant(newTrunk);
    const newLeaf = await descendant(newBranch);
    assert.equal(requests(newTrunk).length, 0, "descendant wait remains parked");
    assert.equal(requests(newBranch).length, 0, "grandchild wait remains parked");
    const leafContinuation = await waitFor(() => requests(newLeaf)[0], "leaf useful continuation", 45_000);
    assert.match(leafContinuation.inputs.at(-1), /continuation/);
    release(newLeaf, leafContinuation);
    const childIncorporation = await waitFor(() => requests(newBranch)[0], "resumed child incorporates leaf", 45_000);
    assert.match(childIncorporation.inputs.at(-1), /Leaf incorporated/);
    release(newBranch, childIncorporation);
    const rootIncorporation = await waitFor(() => requests(newTrunk)[0], "resumed root incorporates child", 45_000);
    assert.match(rootIncorporation.inputs.at(-1), /Child incorporated[\s\S]*Leaf incorporated/);
    release(newTrunk, rootIncorporation);
    const final = await waitFor(() => parent.sentMessages.find((event: any) => event.message.customType === "subagent_result" && event.message.details.generation === 2), "complete restored tree", 45_000);
    assert.match(final.message.content, /Parent incorporated[\s\S]*Child incorporated[\s\S]*Leaf incorporated/);
  }, "pi-runtime.ts");
});

test("nested parent-child-grandchild results survive reload and the last-result busy-start race", { timeout: 150_000 }, async () => {
  await withIdentity(async ({ call, boot, terminal, project, parent }) => {
    process.env.SUBAGENT_TEST_MULTI = "1";
    writeFileSync(join(project, ".pi/agents/trunk.md"), "---\nname: trunk\ntools:\nsubagent_agents: branch\n---\nDelegate to branch\n");
    writeFileSync(join(project, ".pi/agents/branch.md"), "---\nname: branch\ntools:\nsubagent_agents: leaf\n---\nDelegate to leaf\n");
    writeFileSync(join(project, ".pi/agents/leaf.md"), "---\nname: leaf\ntools:\n---\nFinish leaf\n");
    const launched = await boot("subagent", { agent: "trunk", task: "NEST_PARENT" });
    const trunk = join(terminal, "surfaces", launched.details.surface);
    const requests = (root: string) => existsSync(join(root, "provider-input.jsonl")) ? readFileSync(join(root, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    const release = (root: string, request: any) => writeFileSync(join(root, `release-${request.call}`), "complete");
    const descendant = async (root: string) => waitFor(() => {
      const surfaces = join(root, "surfaces");
      const id = existsSync(surfaces) ? readdirSync(surfaces)[0] : undefined;
      return id ? join(surfaces, id) : undefined;
    }, "nested owned surface", 30_000);
    release(trunk, await waitFor(() => requests(trunk)[0], "parent spawn request"));
    const branch = await descendant(trunk);
    release(trunk, await waitFor(() => requests(trunk)[1], "parent waiting response", 30_000));
    await waitFor(() => existsSync(join(trunk, "settlements")) ? true : undefined, "parent waits for child");
    assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 0);
    writeFileSync(join(trunk, "runtime-command.json"), JSON.stringify({ id: "nested-reload", action: "reload" }));
    await waitFor(() => existsSync(join(trunk, "command-nested-reload-done")) ? true : undefined, "reload while descendants outstanding");
    release(branch, await waitFor(() => requests(branch)[0], "child spawn request", 30_000));
    const leaf = await descendant(branch);
    release(branch, await waitFor(() => requests(branch)[1], "child waiting response", 30_000));
    await waitFor(() => existsSync(join(branch, "settlements")) ? true : undefined, "child waits for grandchild");
    // Minimum Pi reports idle during before_agent_start. A result must not
    // start a parallel run or let the autonomous parent exit in that window.
    writeFileSync(join(trunk, "gate-preparation"), "hold human preparation");
    writeFileSync(join(trunk, "runtime-command.json"), JSON.stringify({ id: "human-race", action: "input", text: "Human instruction during descendant completion" }));
    await waitFor(() => existsSync(join(trunk, "preparing")) ? true : undefined, "parent busy-start preparation gate");
    release(leaf, await waitFor(() => requests(leaf)[0], "grandchild work", 30_000));
    const incorporatedLeaf = await waitFor(() => requests(branch)[2], "child receives grandchild result", 30_000);
    assert.match(incorporatedLeaf.inputs.at(-1), /Leaf incorporated/);
    release(branch, incorporatedLeaf);
    await waitFor(() => existsSync(join(branch, "command")) && readFileSync(join(branch, "surface"), "utf8") !== "open" ? true : undefined, "child completed and surface cleaned", 30_000);
    assert.equal(requests(trunk).length, 2, "void result send cannot enter minimum Pi's idle preparation gap");
    assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 0, "last descendant still owes incorporation");
    writeFileSync(join(trunk, "release-preparation"), "continue prepared prompt");
    const human = await waitFor(() => requests(trunk)[2], "human run resumes");
    release(trunk, human);
    const incorporatedChild = await waitFor(() => requests(trunk)[3], "parent receives child result", 30_000);
    assert.match(incorporatedChild.inputs.at(-1), /Child incorporated[\s\S]*Leaf incorporated/);
    release(trunk, incorporatedChild);
    const final = await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "root gets incorporated chain", 30_000);
    assert.match(final.message.content, /Parent incorporated[\s\S]*Child incorporated[\s\S]*Leaf incorporated/);
    assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 1);
  }, "pi-runtime.ts");
});

test("a real child-control process restart retains consumed IDs and pauses effects until exact-action authorization", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ call, boot, terminal, project, parent }) => {
    writeFileSync(join(project, ".pi/agents/resident.md"), "---\nname: resident\ntools:\nauto-exit: false\n---\nStay available\n");
    const launched = await boot("subagent", { agent: "resident", task });
    const provider = () => existsSync(join(terminal, "provider-input.jsonl")) ? readFileSync(join(terminal, "provider-input.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)) : [];
    const release = (request: any) => writeFileSync(join(terminal, `release-${request.call}`), "complete");
    release(await waitFor(() => provider()[0], "first provider call"));
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "initial settlement");
    const instruction = "An external change might happen here.\nDo not repeat without permission.\n";
    await call("subagent_message", { id: launched.details.id, message: instruction, messageId: "affected-operation" });
    const interrupted = await waitFor(() => provider()[1], "controlled consumption before crash");
    const before = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(before.messages[0].state, "consumed");
    const entryId = before.messages[0].evidence.transcriptEntryId;
    process.kill(Number(readFileSync(join(terminal, "control-pid"), "utf8")), "SIGKILL");
    const uncertain = await waitFor(async () => {
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return status.paused && status.liveness.writer === "exited" ? status : undefined;
    }, "positive writer exit and durable uncertainty");
    assert.equal(uncertain.messages[0].delivery, "consumed");
    assert.equal(uncertain.messages[0].evidence.transcriptEntryId, entryId);
    const queued = await call("subagent_message", { id: launched.details.id, message: "Independent next instruction", messageId: "ordinary-followup", deliverAs: "followUp" });
    assert.equal(queued.details.status, "paused-uncertain", "ordinary follow-up cannot authorize repeating uncertain work");
    const actionId = uncertain.messages[0].uncertainty.actionId;
    await assert.rejects(call("subagent_message", { id: launched.details.id, authorization: { actionId: "not-the-action", decision: "retry", reason: "Do it" } }), /exact.*actionId/);
    const replacementController = await controller(dirname(terminal));
    try {
      const reconstructed = (await replacementController.call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(reconstructed.state, "paused-uncertain");
      assert.equal(reconstructed.messages[0].uncertainty.actionId, actionId);
    } finally { replacementController.child.kill("SIGKILL"); }
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.details?.uncertainty?.actionId === actionId), "parent uncertainty notification");
    const authorized = await boot("subagent_message", { id: launched.details.id, authorization: { actionId, decision: "retry", reason: "User explicitly permits repeating the affected operation after checking the destination." } });
    assert.equal(authorized.details.status, "queued");
    const restarted = await waitFor(() => provider().find((r: any) => r.executionId !== interrupted.executionId), "genuine replacement child-control process");
    assert.equal(restarted.inputs.at(-1), instruction);
    assert.notEqual(restarted.executionId, interrupted.executionId);
    release(restarted);
    const ordinary = await waitFor(() => provider().find((r: any) => r.executionId === restarted.executionId && r.call !== restarted.call), "retained ordinary followup");
    assert.equal(ordinary.inputs.at(-1), "Independent next instruction");
    release(ordinary);
    const final = await waitFor(async () => {
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return status.messages.every((m: any) => m.state === "settled") ? status : undefined;
    }, "authorized work settlement");
    assert.equal(final.paused, false);
    const duplicate = await call("subagent_message", { id: launched.details.id, message: instruction, messageId: "affected-operation" });
    assert.equal(duplicate.details.message.state, "settled");
    assert.equal(duplicate.details.generation, final.generation, "duplicate consumption acknowledgement cannot start new work");
    const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
    assert.equal(commands.filter((e: any) => e.args[0] === "split-window").length, 2, "only explicit authorization may launch the replacement writer");
  }, "pi-runtime.ts");
});

test("a demonstrably never-dispatched instruction is safely redelivered after a real child restart with its original id and order", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal }) => {
    process.env.SUBAGENT_TEST_CLOCK = String(Date.now()); // Freeze only the external child's receiver polling.
    const launched = await call("subagent", { agent: "echo", task });
    const message = "Return the exact phrase: safe queued redelivery.\n\nretain final newline\n";
    const queued = await call("subagent_message", { id: launched.details.id, message, messageId: "safe-redelivery" });
    assert.equal(queued.details.message.state, "queued");
    await waitFor(() => existsSync(join(terminal, "control-pid")) ? true : undefined, "child-control PID");
    process.kill(Number(readFileSync(join(terminal, "control-pid"), "utf8")), "SIGKILL");
    await waitFor(async () => (await call("subagent_status", { id: launched.details.id })).details.subagent.liveness.writer === "exited" ? true : undefined, "positive writer exit");
    delete process.env.SUBAGENT_TEST_CLOCK;
    rmSync(join(terminal, "received.json"), { force: true });
    const resent = await call("subagent_message", { id: launched.details.id, message, messageId: "safe-redelivery" });
    assert.equal(resent.details.message.id, "safe-redelivery");
    assert.equal(resent.details.message.sequence, 1);
    assert.equal(resent.details.generation, 2);
    const consumed = await waitFor(() => existsSync(join(terminal, "consumed.json")) ? JSON.parse(readFileSync(join(terminal, "consumed.json"), "utf8")) : undefined, "redelivery visible to child");
    assert.deepEqual(consumed.map((m: any) => [m.details.messageId, m.content]), [["safe-redelivery", message]]);
    writeFileSync(join(terminal, "finish"), "complete");
    const final = await waitFor(async () => {
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return status.messages[0].state === "settled" ? status : undefined;
    }, "redelivered message settlement");
    assert.equal(final.paused, false);
    assert.equal(final.messages.length, 1, "one logical instruction, not a fresh copy on retry");
  });
});

test("accepted memory-only delivery becomes uncertain after process loss and explicit reconciliation suppresses replay", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ call, terminal }) => {
    const launched = await call("subagent", { agent: "echo", task });
    await call("subagent_message", { id: launched.details.id, message: task, messageId: "accepted-gap", deliverAs: "followUp" });
    await waitFor(async () => {
      const message = (await call("subagent_status", { id: launched.details.id })).details.subagent.messages[0];
      return message?.state === "accepted" && message.evidence.dispatchIntent ? true : undefined;
    }, "memory-only Pi queue dispatch (not just pre-dispatch receiver acceptance)");
    process.kill(Number(readFileSync(join(terminal, "control-pid"), "utf8")), "SIGKILL");
    const paused = await waitFor(async () => {
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      return status.paused && status.liveness.writer === "exited" ? status : undefined;
    }, "uncertain memory queue after positive child exit");
    assert.equal(paused.messages[0].evidence.transcriptEntryId, null);
    assert.equal(paused.messages[0].delivery, "accepted");
    const ordinary = await call("subagent_message", { id: launched.details.id, message: "Return the exact phrase: reconciled next work.", messageId: "after-reconciliation" });
    assert.equal(ordinary.details.status, "paused-uncertain");
    assert.ok((await call("subagents_list", {})).details.agents.some((agent: any) => agent.name === "echo"), "independent parent work remains available");
    const actionId = paused.messages[0].uncertainty.actionId;
    await call("subagent_message", { id: launched.details.id, authorization: { actionId, decision: "confirm-completed", reason: "User reconciled the affected action and explicitly instructed us not to repeat it." } });
    const consumed = await waitFor(() => existsSync(join(terminal, "consumed.json")) ? JSON.parse(readFileSync(join(terminal, "consumed.json"), "utf8")) : undefined, "post-reconciliation child input");
    assert.deepEqual(consumed.map((m: any) => m.details.messageId), ["after-reconciliation"], "accepted-but-uncertain original must not be silently repeated");
    const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.paused, false);
    assert.equal(status.messages[0].resolution.actionId, actionId);
    assert.equal(status.messages[0].evidence.settled, false, "explicit reconciliation is not fabricated Pi settlement");
    writeFileSync(join(terminal, "finish"), "complete");
  });
});

test("revisited managed context is not a fresh reply and cannot settle work waiting on a question", { timeout: 30_000 }, async () => {
  await withIdentity(async ({ call, terminal, project, parent }) => {
    writeFileSync(join(project, ".pi/agents/resident.md"), "---\nname: resident\ntools: read\nauto-exit: false\n---\nStay available\n");
    const launched = await call("subagent", { agent: "resident", task });
    writeFileSync(join(terminal, "finish"), "complete initial task");
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "initial settlement");
    await waitFor(() => existsSync(join(terminal, "parked")) ? true : undefined, "resident initial boundary");
    for (const file of ["finish", "parked", "received.json"]) rmSync(join(terminal, file), { force: true });
    await call("subagent_message", { id: launched.details.id, message: "Return the exact phrase: waiting for parent.\nASK_AFTER_INPUT" });
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "managed task visible to child");
    writeFileSync(join(terminal, "finish"), "reach question boundary");
    await waitFor(() => existsSync(join(terminal, "parked")) ? true : undefined, "question task reached settlement boundary");
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_question"), "parent question notification");
    assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 1);
    const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.generation, 2);
    assert.equal(status.latestResult.generation, 1, "historical input in a retry context cannot answer a newer question");
  });
});

test("reload detaches observation without closing live work and reconnects result delivery without a UI", { timeout: 30_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx }) => {
    const launched = await call("subagent", { agent: "echo", task });
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "open");
    writeFileSync(join(terminal, "finish"), "complete while parent detached");
    await waitFor(() => existsSync(join(terminal, "control-pid")) && existsSync(`${launched.details.sessionFile}.process-exit-${JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")).env.PI_SUBAGENT_ID}`) ? true : undefined, "child exit after retained result");
    const replacement = createMockExtensionApi();
    subagents(replacement.api);
    const restored = { ...ctx, hasUI: false };
    try {
      await replacement.emit("session_start", { reason: "reload" }, restored);
      const notification = await waitFor(() => replacement.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "recovered result notification");
      assert.equal(notification.message.details.id, launched.details.id);
      assert.equal(typeof notification.message.details.eventId, "string");
      assert.match(notification.message.content, /identity retained\./);
      assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 0, "detached callbacks cannot send");
      const status = await replacement.tool("subagent_status").execute("restored", { id: launched.details.id }, undefined, undefined, restored);
      assert.equal(status.details.subagent.state, "completed");
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((e: any) => e.args[0] === "split-window").length, 1, "recovery never starts another writer");
    } finally { await replacement.emit("session_shutdown", { reason: "quit" }, restored); }
  });
});

test("detached cleanup cannot close a child or send into a replacement parent context", { timeout: 30_000 }, async () => {
  await withIdentity(async ({ call, terminal, parent, ctx, sessions }) => {
    writeFileSync(join(terminal, "hold-exit"), "retain a live writer after settlement");
    const launched = await call("subagent", { agent: "echo", task });
    writeFileSync(join(terminal, "finish"), "settle");
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "result before deferred cleanup");
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    const nextFile = join(sessions, "another-parent.jsonl");
    writeFileSync(nextFile, JSON.stringify({ type: "session", version: 3, id: "another-parent" }) + "\n");
    const next = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => nextFile, getSessionId: () => "another-parent" } };
    await parent.emit("session_start", { reason: "new" }, next);
    try {
      writeFileSync(join(terminal, "release-exit"), "positive exit");
      const executionId = JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")).env.PI_SUBAGENT_ID;
      await waitFor(() => existsSync(`${launched.details.sessionFile}.process-exit-${executionId}`) ? true : undefined, "writer exit after detachment");
      const listed = await parent.tool("subagent_status").execute("next", {}, undefined, undefined, next);
      assert.deepEqual(listed.details.subagents, []);
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((e: any) => e.args[0] === "kill-pane").length, 0, "old deferred cleanup has no surface authority after detach");
      assert.equal(parent.sentMessages.filter((e: any) => e.message.customType === "subagent_result").length, 1);
    } finally { await parent.emit("session_shutdown", { reason: "quit" }, next); }
  });
});

test("reconstruction reports confirmed-dead work without a result and retains unknown inventory without closing or restarting", { timeout: 30_000 }, async () => {
  await withIdentity(async ({ call, parent, ctx, terminal }) => {
    const launched = await call("subagent", { agent: "echo", task: `${task}\nEXIT_WITHOUT_RESULT` });
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    writeFileSync(join(terminal, "finish"), "exit without settlement");
    const executionId = JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")).env.PI_SUBAGENT_ID;
    await waitFor(() => existsSync(`${launched.details.sessionFile}.process-exit-${executionId}`) ? true : undefined, "positive child process exit");
    writeFileSync(join(terminal, "inventory-unknown"), "unavailable");
    await parent.emit("session_start", { reason: "reload" }, ctx);
    const event = await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "recovered interruption");
    assert.equal(event.message.details.outcome, "failed");
    assert.equal(event.message.details.source.kind, "process_exit");
    const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
    assert.equal(status.state, "failed");
    assert.equal(status.liveness.surface, "unknown");
    assert.equal(status.liveness.writer, "exited");
    const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
    assert.equal(commands.filter((e: any) => e.args[0] === "split-window").length, 1);
    assert.equal(commands.filter((e: any) => e.args[0] === "kill-pane").length, 0, "inventory uncertainty is not cleanup authority");
  });
});

test("a pending question survives a real parent crash before notification without relaunching its waiting child", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ root, parent, ctx, terminal }) => {
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    process.env.SUBAGENT_TEST_PARENT_HISTORY = "crash-before-send";
    const a = await controller(root);
    const launched = await a.call("subagent", { agent: "echo", task: `${task}\nASK_AFTER_INPUT` });
    const exited = new Promise<void>((resolve) => a.child.once("exit", () => resolve()));
    writeFileSync(join(terminal, "finish"), "ask and wait");
    await exited;
    process.env.SUBAGENT_TEST_PARENT_HISTORY = "persist";
    const b = await controller(root);
    try {
      const question = await waitFor(() => b.notifications.find((e: any) => e.message.customType === "subagent_question"), "recovered question");
      assert.equal(question.message.details.question, "Confirm the next step?");
      assert.equal(typeof question.message.details.eventId, "string");
      const status = (await b.call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(status.state, "running");
      assert.equal(status.liveness.surface, "present");
      assert.ok(status.notifications.some((e: any) => e.eventId === question.message.details.eventId && e.state === "persisted"));
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((e: any) => e.args[0] === "split-window").length, 1);
      assert.equal(commands.filter((e: any) => e.args[0] === "kill-pane").length, 0);
    } finally { b.child.kill("SIGKILL"); }
  });
});

test("reload does not create a second logical status notification for the same lost-liveness evidence", { timeout: 30_000 }, async (t) => {
  await withIdentity(async ({ call, parent, ctx }) => {
    process.env.SUBAGENT_TEST_CLOCK = String(Date.now());
    await call("subagent", { agent: "echo", task: `${task}\nLONG_PROVIDER` });
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() + 86_400_000 });
    try {
      await parent.emit("session_start", { reason: "reload" }, ctx);
      t.mock.timers.tick(1000);
      const statuses = () => parent.sentMessages.filter((event: any) => event.message.customType === "subagent_status" && event.message.content.includes("unresponsive"));
      assert.equal(statuses().length, 1);
      const eventId = statuses()[0].message.details.eventId;
      await parent.emit("session_shutdown", { reason: "reload" }, ctx);
      await parent.emit("session_start", { reason: "reload" }, ctx);
      t.mock.timers.tick(1000);
      assert.equal(statuses().length, 1, "unchanged retained heartbeat evidence identifies one logical status event across reload");
      assert.equal(statuses()[0].message.details.eventId, eventId);
    } finally { t.mock.timers.reset(); }
  });
});

test("invalid names and failed durable reservation fail before creating a surface", async () => {
  await withIdentity(async ({ call, terminal, sessions }) => {
    for (const name of ["", " ", "two\nlines", "escape\u001b", "a".repeat(65)]) {
      await assert.rejects(call("subagent", { agent: "echo", name, task }), /name.*(character|line|1–64)/i);
      assert.equal(existsSync(join(terminal, "surface")), false);
    }
    const artifacts = join(sessions, "artifacts");
    rmSync(artifacts, { recursive: true, force: true });
    writeFileSync(artifacts, "not a writable record directory");
    await assert.rejects(call("subagent", { agent: "echo", task }), /ENOTDIR|EEXIST/);
    assert.equal(existsSync(join(terminal, "surface")), false);
  });
});

test("legacy names remain inspectable but ambiguous aliases and unknown writers cannot be resumed", async () => {
  await withIdentity(async ({ call, sessions, terminal }) => {
    const artifacts = join(sessions, "artifacts/identity-parent");
    mkdirSync(artifacts, { recursive: true });
    const registry = join(artifacts, "subagent-registry.json");
    const a = join(sessions, "legacy-a.jsonl");
    const b = join(sessions, "legacy-b.jsonl");
    writeFileSync(registry, JSON.stringify({ Reviewer: { sessionFile: a, sessionId: "legacy-a" }, " Reviewer ": { sessionFile: b, sessionId: "legacy-b" } }));
    const listed = (await call("subagent_status", {})).details.subagents;
    assert.equal(listed.length, 2);
    await assert.rejects(call("subagent_message", { name: "Reviewer", message: task }), /ambiguous/i);
    const first = (await call("subagent_status", { id: listed[0].id })).details.subagent;
    assert.equal(first.sessionFile, a);
    assert.equal(first.state, "interrupted");
    await assert.rejects(call("subagent_message", { id: first.id, message: task }), /writer.*uncertain/i);
    assert.equal(existsSync(join(terminal, "surface")), false);
    writeFileSync(registry, "broken{");
    await assert.rejects(call("subagent", { agent: "echo", name: "Reviewer", task }), /JSON|legacy|registry/i);
    assert.equal(existsSync(join(terminal, "surface")), false, "corrupt names cannot be treated as an empty store");
  });
});

async function controller(root: string, parentId?: string) {
  const notifications: any[] = [];
  const child = fork(join(testDir, "fixtures/controller.ts"), [root, ...(parentId ? [parentId] : [])], { execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let sequence = 0;
  const pending = new Map<number, (message: any) => void>();
  let stderr = "";
  child.stderr!.on("data", (data) => { stderr += data; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Controller startup timeout: ${stderr}`)); }, 30_000);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Controller exited ${code}: ${stderr}`)); });
    child.on("message", (message: any) => {
      if (message.notification) notifications.push(message.notification);
      else if (message.ready) { clearTimeout(timeout); resolve(); }
      else { pending.get(message.sequence)?.(message); pending.delete(message.sequence); }
    });
  });
  return { child, notifications, lifecycle(lifecycle: string, params: any): Promise<any> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
      child.send({ sequence: id, lifecycle, params });
    });
  }, call(tool: string, params: any): Promise<any> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
      child.send({ sequence: id, tool, params });
    });
  } };
}

test("two real recovering parents automatically continue suspended work behind exactly one new writer", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ root, call, terminal, parent, ctx }) => {
    const first = await call("subagent", { agent: "echo", task });
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    assert.equal((await call("subagent_status", { id: first.details.id })).details.subagent.state, "suspended");
    const [a, b] = await Promise.all([controller(root), controller(root)]);
    try {
      const recovered = await waitFor(async () => {
        const status = (await b.call("subagent_status", { id: first.details.id })).details.subagent;
        return status.generation === 2 && status.state === "running" ? status : undefined;
      }, "one automatic recovery writer", 30_000);
      const other = (await a.call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(other.executionId, recovered.executionId);
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((event: any) => event.args[0] === "split-window").length, 2, "one initial writer plus one automatic continuation");
      const receipt = await waitFor(() => { const current = JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")); return current.env.PI_SUBAGENT_GENERATION === "2" ? current : undefined; }, "continuation actually starts work");
      assert.match(receipt.task, /new continuation/);
      assert.notEqual(receipt.task, task);
      writeFileSync(join(terminal, "finish"), "complete");
      await waitFor(async () => (await a.call("subagent_status", { id: first.details.id })).details.subagent.state === "completed" ? true : undefined, "continued completion");
    } finally {
      await Promise.all([a.lifecycle("session_shutdown", { reason: "reload" }), b.lifecycle("session_shutdown", { reason: "reload" })]);
      a.child.kill("SIGKILL"); b.child.kill("SIGKILL");
    }
  });
});

test("cross-process concurrent resume queues both instructions behind one writer and reconstructs scoped status", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ root, call, terminal, parent, ctx }) => {
    const first = await call("subagent", { agent: "echo", name: "Stable", task });
    writeFileSync(join(terminal, "finish"), "complete");
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "initial settlement");
    await waitFor(() => readFileSync(join(terminal, "surface"), "utf8") === "closed" ? true : undefined, "cleanup");
    rmSync(join(terminal, "finish"));
    rmSync(join(terminal, "received.json"));
    await assert.rejects(call("subagent_message", { id: first.details.id, name: "wrong", message: task }), /mismatch|No subagent named/);
    const stranger = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "another-parent" } };
    assert.deepEqual((await call("subagent_status", {}, stranger)).details.subagents, []);
    await assert.rejects(call("subagent_message", { id: first.details.id, message: task }, stranger), /owned|No subagent/);
    const a = await controller(root);
    const b = await controller(root);
    try {
      const raced = await Promise.allSettled([a.call("subagent_message", { id: first.details.id, message: task }), b.call("subagent_message", { id: first.details.id, message: task })]);
      const accepted = raced.filter((r) => r.status === "fulfilled");
      assert.equal(accepted.length, 2, "both instructions are retained behind the same writer reservation");
      assert.deepEqual(accepted.map((r) => (r as PromiseFulfilledResult<any>).value.details.message.sequence).sort(), [1, 2]);
      const winner = accepted.map((r) => (r as PromiseFulfilledResult<any>).value).find((r) => r.details.launchScriptFile)!;
      assert.equal(winner.details.id, first.details.id);
      assert.equal(winner.details.generation, 2);
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((event: any) => event.args[0] === "split-window").length, 2, "initial writer plus exactly one resumed writer");
      const recovered = (await b.call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(recovered.generation, 2);
      assert.equal(recovered.state, "running");
      assert.equal(recovered.loadout.model, "fixture/parent-model");
      assert.equal(recovered.liveness.surface, "present");
      const stale = spawnSync("bash", [first.details.launchScriptFile], { encoding: "utf8" });
      assert.notEqual(stale.status, 0);
      assert.match(stale.stderr, /stale.*writer/i, "old generation cannot reopen Pi even if its native command is replayed");
      const observer = b;
      const third = await observer.call("subagent_message", { id: first.details.id, message: task });
      assert.equal(third.details.message.sequence, 3);
      writeFileSync(join(terminal, "finish"), "complete");
      await waitFor(() => existsSync(`${winner.details.sessionFile}.process-exit-${recovered.executionId}`) ? true : undefined, "writer exit");
      const completed = (await observer.call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(completed.state, "completed");
      assert.equal(completed.latestResult.generation, 2);
      assert.equal(JSON.parse(readFileSync(completed.latestResult.resultFile, "utf8")).output, "identity retained.");
    } finally { a.child.kill("SIGKILL"); b.child.kill("SIGKILL"); }
  });
});

test("real parent process replacement replays a crash-before-send event and deduplicates persisted history after a lost receipt", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ root, parent, ctx, terminal, call }) => {
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    process.env.SUBAGENT_TEST_PARENT_HISTORY = "crash-before-send";
    const first = await controller(root);
    const launched = await first.call("subagent", { agent: "echo", task });
    const exited = new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
    writeFileSync(join(terminal, "finish"), "complete before parent notification");
    await exited;
    assert.equal(first.notifications.filter((e: any) => e.message.customType === "subagent_result").length, 0);
    process.env.SUBAGENT_TEST_PARENT_HISTORY = "crash-after-persist";
    // Startup itself may die after writing the recovered message, before ready.
    await assert.rejects(controller(root), /exited/);
    const history = () => readFileSync(ctx.sessionManager.getSessionFile(), "utf8").trim().split("\n").map((line: string) => JSON.parse(line)).filter((entry: any) => entry.type === "custom_message" && entry.customType === "subagent_result");
    assert.equal(history().length, 1, "the pre-notification crash is repaired by a real replacement controller");
    assert.equal(typeof history()[0].details.eventId, "string");
    process.env.SUBAGENT_TEST_PARENT_HISTORY = "persist";
    const final = await controller(root);
    try {
      const recovered = (await final.call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(recovered.state, "completed");
      assert.equal(recovered.notifications.find((e: any) => e.eventId === history()[0].details.eventId).state, "persisted");
      assert.equal(final.notifications.filter((e: any) => e.message.customType === "subagent_result").length, 0, "persisted message wins over a missing notification receipt");
      assert.equal(history().length, 1);
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((e: any) => e.args[0] === "split-window").length, 1);
    } finally { final.child.kill("SIGKILL"); }
  });
});

test("only one live parent observer delivers, and a passive controller takes over after positive parent exit", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ root, parent, ctx, terminal, project }) => {
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    delete process.env.SUBAGENT_TEST_PARENT_HISTORY; // No persistence receipt: a second live observer must still not send.
    writeFileSync(join(project, ".pi/agents/resident.md"), "---\nname: resident\ntools: read\nauto-exit: false\n---\nStay available\n");
    const a = await controller(root);
    const first = await a.call("subagent", { agent: "resident", task });
    const b = await controller(root);
    try {
      writeFileSync(join(terminal, "finish"), "settle once with two live controllers");
      await waitFor(() => a.notifications.find((e: any) => e.message.customType === "subagent_result"), "authoritative observer delivery");
      await b.lifecycle("session_shutdown", { reason: "reload" });
      await b.lifecycle("session_start", { reason: "reload" });
      // Reconstruction must not make the passive runtime a second sender.
      const passive = await b.call("subagent_status", { id: first.details.id });
      assert.equal(passive.details.subagent.state, "completed");
      assert.equal(b.notifications.filter((e: any) => e.message.customType === "subagent_result").length, 0, "another live controller cannot become a second sender/cleanup owner");
      await waitFor(() => existsSync(join(terminal, "parked")) ? true : undefined, "resident boundary");
      for (const file of ["finish", "parked", "received.json"]) rmSync(join(terminal, file), { force: true });
      const exit = new Promise<void>((resolve) => a.child.once("exit", () => resolve()));
      a.child.kill("SIGKILL");
      await exit;
      await b.call("subagent_message", { id: first.details.id, message: "Return the exact phrase: same live writer after parent loss." });
      await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "same writer input after takeover");
      writeFileSync(join(terminal, "finish"), "complete followup");
      const result = await waitFor(() => b.notifications.find((e: any) => e.message.customType === "subagent_result" && e.message.details.generation === 2), "new observer after positive parent death");
      assert.match(result.message.content, /same live writer after parent loss\./);
      const status = (await b.call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(status.liveness.surface, "present");
      assert.equal(status.executionId, passive.details.subagent.executionId);
      const commands = readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
      assert.equal(commands.filter((e: any) => e.args[0] === "split-window").length, 1, "observation takeover does not relaunch the resident writer");
      assert.equal(commands.filter((e: any) => e.args[0] === "kill-pane").length, 0);
    } finally { a.child.kill("SIGKILL"); b.child.kill("SIGKILL"); }
  });
});

test("concurrent controllers allocate default and explicit names without losing unrelated records", { timeout: 90_000 }, async () => {
  await withIdentity(async ({ root, call, terminal }) => {
    process.env.SUBAGENT_TEST_MULTI = "1";
    const a = await controller(root);
    const b = await controller(root);
    try {
      for (const name of [undefined, "x".repeat(64)]) {
        const launched = await Promise.all([a.call("subagent", { agent: "echo", name, task }), b.call("subagent", { agent: "echo", name, task })]);
        assert.deepEqual(launched.map((r) => r.details.name).sort(), name ? ["x".repeat(62) + "-2", name].sort() : ["echo", "echo-2"]);
        assert.notEqual(launched[0].details.id, launched[1].details.id);
        assert.notEqual(launched[0].details.surface, launched[1].details.surface);
      }
      const listed = (await call("subagent_status", {})).details.subagents;
      assert.equal(listed.length, 4);
      assert.equal(new Set(listed.map((r: any) => r.id)).size, 4);
      assert.ok(listed.every((r: any) => r.generation === 1 && r.state === "running" && r.liveness.surface === "present"));
      await Promise.all(listed.map((run: any, index: number) => call("subagent_message", { id: run.id, messageId: `target-${index}`, message: `Return the exact phrase: target ${index}.\nOnly for ${run.name}`, deliverAs: "followUp" })));
      for (const run of listed) writeFileSync(join(terminal, "surfaces", run.surface, "finish"), "complete");
      for (const [index, run] of listed.entries()) {
        const input = await waitFor(() => {
          const file = join(terminal, "surfaces", run.surface, "consumed.json");
          return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
        }, "correct child's managed input");
        assert.deepEqual(input.map((message: any) => [message.details.messageId, message.content]), [[`target-${index}`, `Return the exact phrase: target ${index}.\nOnly for ${run.name}`]]);
      }
    } finally { a.child.kill("SIGKILL"); b.child.kill("SIGKILL"); }
  });
});

test("an old generation's delayed closure cannot overwrite or close its replacement", { timeout: 60_000 }, async () => {
  await withIdentity(async ({ root, call, terminal }) => {
    process.env.SUBAGENT_TEST_MULTI = "1";
    const a = await controller(root);
    const b = await controller(root);
    try {
      const first = await a.call("subagent", { agent: "echo", name: "Generation", task });
      writeFileSync(join(terminal, "pause-close"), "hold external close receipt");
      writeFileSync(join(terminal, "surfaces", first.details.surface, "finish"), "complete");
      await waitFor(() => existsSync(join(terminal, "close-waiting")) ? true : undefined, "old cleanup in flight");
      const next = await b.call("subagent_message", { id: first.details.id, message: task });
      assert.equal(next.details.generation, 2);
      rmSync(join(terminal, "pause-close"));
      const record = (await a.call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(record.generation, 2);
      assert.equal(record.state, "running");
      assert.equal(record.surface, next.details.surface);
      assert.equal(record.liveness.surface, "present");
      assert.equal(record.closure, undefined, "old closure cannot mark the replacement closed");
      writeFileSync(join(terminal, "surfaces", next.details.surface, "finish"), "complete");
      await waitFor(() => readFileSync(join(terminal, "surfaces", next.details.surface, "surface"), "utf8") === "closed" ? true : undefined, "new cleanup");
      const result = (await call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(result.latestResult.generation, 2);
      assert.equal(result.state, "completed");
    } finally {
      rmSync(join(terminal, "pause-close"), { force: true });
      a.child.kill("SIGKILL"); b.child.kill("SIGKILL");
    }
  });
});

test("the pre-Pi gate rejects duplicate startup and a replacement runtime cannot reclaim a live writer by age", { timeout: 60_000 }, async (t) => {
  await withIdentity(async ({ root, call, terminal, parent, ctx, widgets }) => {
    writeFileSync(join(root, "project/.pi/agents/resident.md"), "---\nname: resident\ntools: read\nauto-exit: false\n---\nStay available\n");
    const launched = await call("subagent", { agent: "resident", task });
    const transcript = readFileSync(launched.details.sessionFile, "utf8");
    const duplicate = spawnSync("bash", [launched.details.launchScriptFile], { encoding: "utf8" });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /EEXIST/);
    assert.equal(readFileSync(launched.details.sessionFile, "utf8"), transcript, "duplicate gate fails before even opening Pi's session");
    const c = await controller(root);
    try {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 86_400_000 });
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(status.liveness.responsive, "unresponsive");
      assert.equal(status.state, "running");
      const queued = await c.call("subagent_message", { id: launched.details.id, message: task });
      assert.equal(queued.details.status, "queued", "existing fenced receiver can accept without writer takeover");
    } finally { t.mock.timers.reset(); c.child.kill("SIGKILL"); }
    writeFileSync(join(terminal, "finish"), "complete");
    await waitFor(() => parent.sentMessages.find((e: any) => e.message.customType === "subagent_result"), "resident settlement");
    await waitFor(() => widgets.at(-1)?.includes("completed") ? true : undefined, "completed resident widget");
    assert.match(widgets.at(-1), /0 running/);
    rmSync(join(terminal, "finish"));
    const next = await call("subagent_message", { id: launched.details.id, name: launched.details.name, message: task });
    assert.equal(next.details.id, launched.details.id);
    assert.equal(next.details.generation, 2, "new resident task changes work generation without a second writer");
    assert.equal((await call("subagent_status", { id: launched.details.id })).details.subagent.state, "running", "old result cannot complete a new task");
    const steering = await call("subagent_message", { id: launched.details.id, message: "steering current task" });
    assert.equal(steering.details.generation, 2);
    await parent.emit("session_shutdown", { reason: "reload" }, ctx);
    widgets.length = 0;
    await parent.emit("session_start", { reason: "reload" }, ctx);
    assert.ok(widgets.length > 0, "a recreated widget projects recorded children without taking over their execution");
    assert.match(widgets.at(-1), /1 running/);
    const recreated = await controller(root);
    try {
      const recovered = (await recreated.call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(recovered.id, launched.details.id);
      assert.equal(recovered.generation, 2);
      assert.equal(recovered.state, "running");
      const queued = await recreated.call("subagent_message", { id: launched.details.id, message: task });
      assert.equal(queued.details.status, "queued");
    } finally { recreated.child.kill("SIGKILL"); }
  });
});
