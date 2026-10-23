import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import subagents, { registerToolExtension } from "../pi-extension/subagents/index.ts";
import subagentDone from "../pi-extension/subagents/subagent-done.ts";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockExtensionApi, plainTheme, waitFor } from "./harness.ts";
import { closeSurface, shellEscape } from "../pi-extension/subagents/tmux.ts";

const testDir = dirname(fileURLToPath(import.meta.url));

// Older synthetic event cases use a linear entry stream; interpret that stream
// with Pi rather than replacing the projection/context-edit behavior in mocks.
function lifecycleSession(branch: any[], id: string) {
  return {
    getBranch: () => branch,
    getEntries: () => branch,
    getSessionId: () => id,
    getLeafId: () => branch.at(-1)?.id ?? null,
    buildSessionProjection: () => buildSessionProjection(branch.map((entry, index) => ({ ...entry, parentId: branch[index - 1]?.id ?? null }))),
  };
}

// Confirmed seam: registered child control tools and Pi lifecycle events.
test("retry, queued and recovery runs cannot terminate delegated work before final settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-settlement-"));
  const previousEnv = { ...process.env };
  process.env.PI_SUBAGENT_SESSION = join(root, "child.jsonl");
  process.env.PI_SUBAGENT_ID = "settlement-child";
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  const child = createMockExtensionApi();
  let shutdown = false;
  const branch: any[] = [];
  const ctx = {
    hasUI: false, ui: { setWidget() {} },
    sessionManager: lifecycleSession(branch, "child-session"),
    shutdown() { shutdown = true; },
  };
  try {
    subagentDone(child.api);
    await child.emit("session_start", {}, ctx);
    await child.emit("input", { text: "Do the task" }, ctx);
    await child.emit("agent_start", {}, ctx);
    const error = { role: "assistant", stopReason: "error", errorMessage: "temporary overload", content: [] };
    branch.push({ type: "message", id: "retryable-error", message: error });
    await child.emit("agent_end", { messages: [error] }, ctx);
    assert.equal(shutdown, false, "agent_end is activity, not exhausted retry evidence");
    assert.equal(existsSync(`${process.env.PI_SUBAGENT_SESSION}.exit`), false);
    await child.emit("agent_start", {}, ctx);
    const interim = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "First run finished, queued work remains." }] };
    branch.push({ type: "message", id: "interim-answer", message: interim });
    await child.emit("agent_end", { messages: [interim] }, ctx);
    await child.emit("agent_before_settle", { outcome: "completed", continue: true }, ctx);
    assert.equal(shutdown, false, "pre-settlement continuation cannot publish/exit");
    branch.push({ type: "compaction", id: "recovery-compaction", summary: "Continue after recovery." });
    await child.emit("agent_start", {}, ctx);
    await child.emit("input", { text: "Human clarification while working", source: "interactive" }, ctx);
    const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered successfully." }] };
    branch.push({ type: "message", id: "final-answer", message: success });
    await child.emit("agent_end", { messages: [success] }, ctx);
    assert.equal(shutdown, false, "even a successful low-level end can have queued work");
    await child.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await child.emit("agent_settled", {}, ctx);
    assert.equal(shutdown, true, "autonomous work exits only after settlement");
  } finally {
    await child.emit("session_shutdown", { reason: "quit" }, ctx);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending questions survive automatic restarts until actual reply input arrives", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-question-settlement-"));
  const previousEnv = { ...process.env };
  process.env.PI_SUBAGENT_SESSION = join(root, "child.jsonl");
  process.env.PI_SUBAGENT_ID = "question-child";
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  const child = createMockExtensionApi();
  let shutdown = false;
  const branch: any[] = [];
  const ctx = {
    hasUI: false, ui: { setWidget() {} },
    sessionManager: lifecycleSession(branch, "question-session"),
    shutdown() { shutdown = true; },
  };
  try {
    subagentDone(child.api);
    await child.emit("session_start", {}, ctx);
    await child.emit("agent_start", {}, ctx);
    await child.tool("ask_question").execute("question-1", { question: "Which API version?" }, undefined, undefined, ctx);
    await child.emit("agent_end", { messages: [] }, ctx);
    // An automatic recovery run is not a reply from the parent.
    await child.emit("agent_start", {}, ctx);
    await child.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await child.emit("agent_settled", {}, ctx);
    assert.equal(shutdown, false, "an unanswered question suppresses finalization");
    await child.emit("input", { text: "Use v2", source: "interactive" }, ctx);
    await child.emit("agent_start", {}, ctx);
    branch.push({ type: "message", id: "reply-result", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Used v2." }],
    } });
    await child.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await child.emit("agent_settled", {}, ctx);
    assert.equal(shutdown, true);
  } finally {
    await child.emit("session_shutdown", { reason: "quit" }, ctx);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("result persistence failure prevents autonomous exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-persist-failure-"));
  const previousEnv = { ...process.env };
  process.env.PI_SUBAGENT_SESSION = join(root, "child.jsonl");
  writeFileSync(`${process.env.PI_SUBAGENT_SESSION}.results`, "not a directory");
  process.env.PI_SUBAGENT_ID = "persistence-child";
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  const child = createMockExtensionApi();
  const branch: any[] = [];
  let shutdown = false;
  const ctx = {
    hasUI: false, ui: { setWidget() {} },
    sessionManager: lifecycleSession(branch, "persistence-session"),
    shutdown() { shutdown = true; },
  };
  try {
    subagentDone(child.api);
    await child.emit("session_start", {}, ctx);
    branch.push({ type: "message", id: "answer", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Must not be lost." }],
    } });
    await child.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await assert.rejects(child.emit("agent_settled", {}, ctx), /ENOTDIR|EEXIST/);
    assert.equal(shutdown, false, "a failed result write cannot be reported as completed exit");
  } finally {
    await child.emit("session_shutdown", { reason: "quit" }, ctx);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native delegation acknowledges launch before child completion and automatically returns its result", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-lifecycle-"));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const bin = join(root, "bin");
  const terminal = join(root, "terminal");
  const project = join(root, "project");
  const agents = join(project, ".pi", "agents");
  const sessions = join(root, "sessions");
  for (const dir of [bin, terminal, agents, sessions]) mkdirSync(dir, { recursive: true });
  // Only these executables are used: never contact an existing terminal or model.
  const terminalFixture = join(testDir, "fixtures", "terminal.mjs");
  copyFileSync(terminalFixture, join(bin, "tmux"));
  const runtimeCommand = [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), join(testDir, "fixtures", "runtime.ts")]
    .map(shellEscape).join(" ");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${runtimeCommand} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.TMUX = "isolated-fixture";
  process.env.PI_TERMINAL_MUX = "tmux";
  process.env.TMUX_PANE = "%isolated-parent";
  process.env.SUBAGENT_TEST_TERMINAL = terminal;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-config");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  }
  process.chdir(project);
  const webExtension = join(root, "web-extension.ts");
  writeFileSync(webExtension, "export default function () {}\n");
  registerToolExtension("web_search", webExtension);
  writeFileSync(join(agents, "echo.md"), "---\nname: echo\ntools: read,web_search\nsystem-prompt: append\n---\nYou are the deterministic echo role.\n");
  const parentFile = join(sessions, "parent.jsonl");
  writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "fixture-parent" }) + "\n");
  const parent = createMockExtensionApi();
  const widgets: string[] = [];
  const ctx = {
    cwd: project, hasUI: true, model: { provider: "fixture", id: "parent-model" },
    modelRegistry: { getAll: () => [{ provider: "fixture", id: "parent-model" }] },
    sessionManager: {
      getSessionFile: () => parentFile,
      getSessionId: () => "fixture-parent",
      getSessionDir: () => sessions,
    },
    ui: {
      setWidget(_name: string, widget: any) {
        if (typeof widget === "function") widgets.push(widget({}, plainTheme).render(100).join("\n"));
      },
    },
  };
  parent.api.getThinkingLevel = () => "off";
  try {
    subagents(parent.api);
    await parent.emit("session_start", {}, ctx);
    const definitions = await parent.tool("subagents_list").execute();
    assert.ok(definitions.details.agents.some((agent: any) => agent.name === "echo"));
    const toolAbort = new AbortController();
    const launched = await parent.tool("subagent").execute("spawn-1", {
      agent: "echo", name: "Echo", task: "Return the exact phrase: deterministic task complete.",
    }, toolAbort.signal, undefined, ctx);
    toolAbort.abort(); // Returning/ending the native tool must not cancel delegated work.

    // This controller is itself a child with owned descendant work. Its bridge
    // must wait until the last descendant result has actually reached Pi.
    const envBeforeBridge = { ...process.env };
    process.env.PI_SUBAGENT_SESSION = parentFile;
    process.env.PI_SUBAGENT_ID = "delegating-parent";
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    const bridge = createMockExtensionApi();
    subagentDone(bridge.api);
    process.env = envBeforeBridge;
    let delegatorShutdown = false;
    const delegatorBranch: any[] = [];
    const delegatorCtx = {
      hasUI: false, ui: { setWidget() {} },
      sessionManager: lifecycleSession(delegatorBranch, "fixture-parent"),
      shutdown() { delegatorShutdown = true; },
    };
    await bridge.emit("session_start", {}, delegatorCtx);
    delegatorBranch.push({ type: "message", id: "waiting-for-child", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting for descendant." }],
    } });
    await bridge.emit("agent_before_settle", { outcome: "completed" }, delegatorCtx);
    await bridge.emit("agent_settled", {}, delegatorCtx);
    assert.equal(delegatorShutdown, false);
    const acceptMessage = parent.api.sendMessage;
    parent.api.sendMessage = (message: any, options: any) => {
      if (message.customType === "subagent_result") {
        void bridge.emit("agent_settled", {}, delegatorCtx);
        assert.equal(delegatorShutdown, false, "descendant remains outstanding while its result is accepted");
      }
      acceptMessage(message, options);
    };
    assert.equal(launched.details.status, "started");
    assert.match(launched.content[0].text, /running in the background/);
    assert.equal(parent.sentMessages.length, 0, "launch acceptance is not task completion");
    const received = await waitFor(() => existsSync(join(terminal, "received.json"))
      ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "child task receipt");
    assert.match(received.task, /Return the exact phrase: deterministic task complete\./);
    assert.deepEqual(received.tools, ["ask_question"]);
    assert.equal(received.autoExit, "1", "omitted role policy is explicitly autonomous");
    assert.match(received.widgets.join("\n"), /echo/);
    assert.ok(received.args.includes(webExtension), "registered tool extensions do not depend on a personal install");
    const identityFile = received.args[received.args.indexOf("--append-system-prompt") + 1];
    assert.equal(readFileSync(identityFile, "utf8"), "You are the deterministic echo role.");
    assert.ok(widgets.some((text) => text.includes("Echo")), "parent shows the delegated child");
    assert.equal(parent.sentMessages.length, 0, "child remains active until explicitly released");
    writeFileSync(join(terminal, "finish"), "release");
    const delivered = await waitFor(() => parent.sentMessages.find((event) => event.message.customType === "subagent_result"), "automatic parent result");
    assert.match(delivered.message.content, /deterministic task complete\./);
    parent.api.sendMessage = acceptMessage;
    await bridge.emit("input", { text: "Descendant result accepted" }, delegatorCtx);
    delegatorBranch.push({ type: "message", id: "incorporated-child", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Incorporated descendant result." }],
    } });
    await bridge.emit("agent_before_settle", { outcome: "completed" }, delegatorCtx);
    await bridge.emit("agent_settled", {}, delegatorCtx);
    assert.equal(delegatorShutdown, true, "delegator may finish after incorporating its last child");
    await bridge.emit("session_shutdown", { reason: "quit" }, delegatorCtx);
    assert.equal(delivered.message.details.name, "Echo");
    assert.equal(delivered.message.details.exitCode, 0);
    assert.equal(delivered.message.details.outcome, "succeeded");
    assert.equal(delivered.message.details.usage.generation.inputTokens, 10);
    assert.equal(delivered.message.details.usage.generation.contextWindow, 64_000);
    assert.equal(delivered.message.details.usage.session.inputTokens, 10);
    const durable = JSON.parse(readFileSync(delivered.message.details.resultFile, "utf8"));
    assert.equal(durable.output, "deterministic task complete.");
    assert.equal(durable.outcome, "succeeded");
    assert.equal(durable.generation, delivered.message.details.generation);
    assert.equal(durable.subagentId, launched.details.id);
    assert.equal(durable.source.startLeafId, null);
    assert.equal(durable.source.entryId, "fixture-answer-0");
    assert.equal(durable.source.stopReason, "stop");
    assert.equal(delivered.message.display, true);
    assert.deepEqual(delivered.options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "closed");
    const renderer = parent.registeredMessageRenderers.find((renderer) => renderer.name === "subagent_result");
    const rendered = renderer.renderer(delivered.message, { expanded: true }, plainTheme).render(100).join("\n");
    assert.match(rendered, /Echo/);
    assert.match(rendered, /deterministic task complete\./);

    // Follow up through the same native name-based interface after completion.
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    const resumed = await parent.tool("subagent_message").execute("resume-1", {
      name: "Echo", message: "Return the exact phrase: follow-up task complete.",
    }, undefined, undefined, ctx);
    assert.equal(resumed.details.status, "started");
    assert.equal(resumed.details.sessionFile, launched.details.sessionFile);
    assert.equal(parent.sentMessages.length, 1, "resume also acknowledges before completion");
    const followUp = await waitFor(() => existsSync(join(terminal, "received.json"))
      ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "follow-up task receipt");
    assert.equal(followUp.task, "Return the exact phrase: follow-up task complete.");
    assert.ok(followUp.args.includes(webExtension));
    assert.ok(followUp.args.includes("--append-system-prompt"));
    writeFileSync(join(terminal, "finish"), "release");
    const followUpResult = await waitFor(() => parent.sentMessages[1], "automatic follow-up result");
    assert.match(followUpResult.message.content, /follow-up task complete\./);
    assert.doesNotMatch(followUpResult.message.content, /deterministic task complete/);
    assert.deepEqual(followUpResult.options, { triggerTurn: true, deliverAs: "steer" });

    // Exhausted failure is a settled outcome, and useful partial output survives.
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    await parent.tool("subagent_message").execute("resume-error", {
      name: "Echo", message: "Return the exact phrase: partial work retained.\nFINAL_ERROR",
    }, undefined, undefined, ctx);
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "failing task receipt");
    assert.equal(parent.sentMessages.length, 2);
    writeFileSync(join(terminal, "finish"), "release");
    const failed = await waitFor(() => parent.sentMessages[2], "settled failure result");
    assert.equal(failed.message.details.outcome, "failed");
    assert.equal(failed.message.details.exitCode, 1);
    assert.match(failed.message.content, /partial work retained/);
    assert.match(failed.message.content, /529 overloaded/);
    assert.doesNotMatch(failed.message.content, /did not produce a result/);
    const failureEvidence = JSON.parse(readFileSync(failed.message.details.resultFile, "utf8"));
    assert.equal(failureEvidence.source.entryId, "fixture-answer-3");
    assert.deepEqual(failureEvidence.source.outputEntryIds, ["fixture-partial-2"]);
    const failureView = renderer.renderer(failed.message, { expanded: true }, plainTheme).render(100).join("\n");
    assert.match(failureView, /✗/);
    assert.doesNotMatch(failureView, /✓/);

    for (const [marker, outcome, partial] of [
      ["TRUNCATED", "truncated", "useful but unfinished"],
      ["NO_OUTPUT", "no-output", "must not reuse earlier answers"],
      ["ABANDONED_BRANCH_NO_OUTPUT", "no-output", "must not resurrect an abandoned answer"],
      ["OMITTED_FINAL", "no-output", "must not substitute an intermediate response"],
      ["FOLLOWUP_WITHOUT_ANSWER", "no-output", "must not complete an unanswered instruction"],
      ["EXIT_WITHOUT_RESULT", "failed", "must not turn process exit into success"],
    ]) {
      rmSync(join(terminal, "received.json"));
      rmSync(join(terminal, "finish"));
      const count = parent.sentMessages.length;
      await parent.tool("subagent_message").execute(`resume-${marker}`, {
        name: "Echo", message: `Return the exact phrase: ${partial}\n${marker}`,
      }, undefined, undefined, ctx);
      await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, `${marker} receipt`);
      writeFileSync(join(terminal, "finish"), "release");
      const event = await waitFor(() => parent.sentMessages[count], `${outcome} result`);
      assert.equal(event.message.details.outcome, outcome);
      assert.equal(event.message.details.exitCode, 1);
      const evidence = JSON.parse(readFileSync(event.message.details.resultFile, "utf8"));
      assert.equal(evidence.output, marker.includes("NO_OUTPUT") || marker === "EXIT_WITHOUT_RESULT" || marker === "OMITTED_FINAL" || marker === "FOLLOWUP_WITHOUT_ANSWER" ? "" : partial);
      assert.doesNotMatch(event.message.content, /completed \(/);
      const view = renderer.renderer(event.message, { expanded: true }, plainTheme).render(100).join("\n");
      assert.match(view, /✗/);
      assert.doesNotMatch(view, /✓/);
    }

    // Aborting an autonomous task reports abort without converting the role
    // into a resident: its next normal task still exits automatically.
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    const beforeAbort = parent.sentMessages.length;
    await parent.tool("subagent").execute("spawn-aborted", {
      agent: "echo", name: "Aborted", task: "Return the exact phrase: partial before abort.\nABORTED",
    }, undefined, undefined, ctx);
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "autonomous abort receipt");
    writeFileSync(join(terminal, "finish"), "release");
    const aborted = await waitFor(() => parent.sentMessages[beforeAbort], "autonomous aborted result");
    assert.equal(aborted.message.details.outcome, "aborted");
    assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "open");
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    await parent.tool("subagent_message").execute("continue-aborted", {
      name: "Aborted", message: "Return the exact phrase: continued autonomous task.",
    }, undefined, undefined, ctx);
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "continued autonomous receipt");
    writeFileSync(join(terminal, "finish"), "release");
    const continued = await waitFor(() => parent.sentMessages[beforeAbort + 1], "continued autonomous result");
    assert.equal(continued.message.details.outcome, "succeeded");
    assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "closed");

    // Resident task completion is not process termination. Manual/parent input
    // adds another task without changing the recorded lifetime policy.
    writeFileSync(join(agents, "resident.md"), "---\nname: resident\ntools: read\nauto-exit: false\n---\nStay available for follow-ups.\n");
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    const count = parent.sentMessages.length;
    await parent.tool("subagent").execute("spawn-resident", {
      agent: "resident", name: "Resident", task: "Return the exact phrase: resident first result.",
    }, undefined, undefined, ctx);
    const resident = await waitFor(() => existsSync(join(terminal, "received.json"))
      ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "resident receipt");
    assert.equal(resident.autoExit, "0");
    const residentPid = readFileSync(join(terminal, "pid"), "utf8");
    writeFileSync(join(terminal, "finish"), "release");
    const residentResult = await waitFor(() => parent.sentMessages[count], "resident result without exit");
    assert.equal(residentResult.message.details.outcome, "succeeded");
    assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "open");
    for (const [marker, outcome] of [["ABORTED", "aborted"], ["", "succeeded"]]) {
      rmSync(join(terminal, "received.json"));
      rmSync(join(terminal, "finish"));
      const next = parent.sentMessages.length;
      const steered = await parent.tool("subagent_message").execute("resident-followup", {
        name: "Resident", message: `Return the exact phrase: resident follow-up.\n${marker}`,
      }, undefined, undefined, ctx);
      assert.equal(steered.details.status, "steered");
      const task = await waitFor(() => existsSync(join(terminal, "received.json"))
        ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "resident next receipt");
      assert.match(task.task, /resident follow-up/);
      writeFileSync(join(terminal, "finish"), "release");
      const event = await waitFor(() => parent.sentMessages[next], "resident next result");
      assert.equal(event.message.details.outcome, outcome);
      assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "open");
      assert.equal(readFileSync(join(terminal, "pid"), "utf8"), residentPid, "follow-up uses the same live process");
    }

    ctx.hasUI = false; // Delivery does not depend on widgets or terminal UI.
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    const beforeLongResult = parent.sentMessages.length;
    await parent.tool("subagent_message").execute("resident-long", {
      name: "Resident", message: "Return the exact phrase: long result.\nLONG_OUTPUT",
    }, undefined, undefined, ctx);
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "long task receipt");
    writeFileSync(join(terminal, "finish"), "release");
    const longResult = await waitFor(() => parent.sentMessages[beforeLongResult], "bounded automatic result");
    assert.equal(longResult.message.details.outcome, "succeeded");
    assert.ok(longResult.message.content.length < 10_000, "automatic parent context is bounded");
    assert.ok(longResult.message.content.includes(longResult.message.details.resultFile), "full result is directly addressable");
    await waitFor(() => existsSync(join(terminal, "diagnostics-unavailable")) ? true : undefined, "process/surface exit");
    const fullResult = JSON.parse(readFileSync(longResult.message.details.resultFile, "utf8"));
    assert.ok(fullResult.output.length > 40_000);
    assert.match(fullResult.output, /complete output end$/);
    assert.equal(fullResult.outcome, "succeeded", "terminal diagnostic loss cannot reverse persisted success");
    await waitFor(() => readFileSync(join(terminal, "surface"), "utf8") !== "open" ? true : undefined, "confirmed surface absence");

    // Editing the role cannot silently change a completed child's saved policy.
    writeFileSync(join(agents, "resident.md"), "---\nname: resident\ntools: read\nauto-exit: true\n---\nChanged role definition.\n");
    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    const beforeResidentResume = parent.sentMessages.length;
    const residentResume = await parent.tool("subagent_message").execute("resident-resume", {
      name: "Resident", message: "Return the exact phrase: snapshot policy restored.",
    }, undefined, undefined, ctx);
    assert.equal(residentResume.details.status, "started");
    const restored = await waitFor(() => existsSync(join(terminal, "received.json"))
      ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "resident resume receipt");
    assert.equal(restored.autoExit, "0");
    writeFileSync(join(terminal, "finish"), "release");
    const restoredResult = await waitFor(() => parent.sentMessages[beforeResidentResume], "restored resident result");
    assert.equal(restoredResult.message.details.outcome, "succeeded");
    assert.match(restoredResult.message.content, /snapshot policy restored/);
    assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "open");

    rmSync(join(terminal, "received.json"));
    rmSync(join(terminal, "finish"));
    const beforeEdited = parent.sentMessages.length;
    await parent.tool("subagent_message").execute("effective-result", {
      name: "Resident", message: "Return the exact phrase: obsolete raw answer.\nCONTEXT_EDIT\nPARTIAL_TAIL\nUNKNOWN_CAPACITY\nUSAGE_EVENTS",
    }, undefined, undefined, ctx);
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "effective-context result receipt");
    writeFileSync(join(terminal, "finish"), "release");
    const edited = await waitFor(() => parent.sentMessages[beforeEdited], "result despite unfinished trailing record");
    assert.equal(edited.message.details.outcome, "succeeded");
    assert.match(edited.message.content, /The effective revised answer\./);
    assert.doesNotMatch(edited.message.content, /obsolete raw answer\./);
    const editedEvidence = JSON.parse(readFileSync(edited.message.details.resultFile, "utf8"));
    assert.equal(editedEvidence.output, "The effective revised answer.");
    assert.equal(editedEvidence.source.outputEntryIds.length, 1);
    assert.equal(editedEvidence.usage.generation.inputTokens, 20, "this work includes assistant, compaction and standalone usage entries");
    assert.equal(editedEvidence.usage.generation.outputTokens, 10);
    assert.ok(Math.abs(editedEvidence.usage.generation.cost - 0.06) < 1e-9);
    assert.ok(editedEvidence.usage.session.inputTokens > 20, "whole-session usage retains prior work separately");
    assert.equal(edited.message.details.usage.generation.contextWindow, undefined);
    const usageView = renderer.renderer(edited.message, { expanded: true }, plainTheme).render(100).join("\n");
    assert.match(usageView, /generation/);
    assert.match(usageView, /session/);
    assert.match(usageView, /capacity unknown/);
    assert.doesNotMatch(usageView, /%/);
    for (const width of [12, 28]) {
      const lines = renderer.renderer(edited.message, { expanded: true }, plainTheme).render(width);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `usage/result rendering respects width ${width}`);
    }
  } finally {
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    if (existsSync(join(terminal, "pid"))) {
      try { process.kill(-Number(readFileSync(join(terminal, "pid"), "utf8")), "SIGKILL"); } catch {}
    }
    // Explicitly release the isolated fixture; detaching a watcher no longer
    // closes a surface or infers process termination.
    if (existsSync(join(terminal, "surface"))) {
      closeSurface("%fixture");
      await waitFor(() => existsSync(join(terminal, "layout")) &&
        readFileSync(join(terminal, "layout"), "utf8") === "closed" ? true : undefined, "fixture terminal cleanup");
    }
    process.chdir(previousCwd);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
