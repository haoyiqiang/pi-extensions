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
  Object.assign(process.env, { PATH: `${bin}:${env.PATH}`, PI_TERMINAL_MUX: "tmux", TMUX: "fixture", TMUX_PANE: "%fixture-parent", PI_CODING_AGENT_DIR: join(root, "config"), SUBAGENT_TEST_TERMINAL: terminal });
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
    if (existsSync(join(terminal, "screen"))) console.error(readFileSync(join(terminal, "screen"), "utf8"));
    throw error;
  } finally {
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    const terminals = [terminal, ...(existsSync(join(terminal, "surfaces")) ? readdirSync(join(terminal, "surfaces")).map((id) => join(terminal, "surfaces", id)) : [])];
    for (const directory of terminals) if (existsSync(join(directory, "pid"))) { try { process.kill(-Number(readFileSync(join(directory, "pid"), "utf8")), "SIGKILL"); } catch {} }
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
}

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
