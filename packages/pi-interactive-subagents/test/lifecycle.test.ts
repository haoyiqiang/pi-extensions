import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import subagents, { registerToolExtension } from "../pi-extension/subagents/index.ts";
import { createMockExtensionApi, plainTheme, waitFor } from "./harness.ts";
import { shellEscape } from "../pi-extension/subagents/tmux.ts";

const testDir = dirname(fileURLToPath(import.meta.url));

test("native delegation acknowledges launch before child completion and automatically returns its result", { timeout: 20_000 }, async () => {
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
  process.env.TMUX_PANE = "%isolated-parent";
  process.env.SUBAGENT_TEST_TERMINAL = terminal;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-config");
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_SUBAGENT_") && key !== "PI_SUBAGENT_SHELL_READY_DELAY_MS") delete process.env[key];
  }
  process.chdir(project);
  const webExtension = join(root, "web-extension.ts");
  writeFileSync(webExtension, "export default function () {}\n");
  registerToolExtension("web_search", webExtension);
  writeFileSync(join(agents, "echo.md"), "---\nname: echo\ntools: read,web_search\nauto-exit: true\nsystem-prompt: append\n---\nYou are the deterministic echo role.\n");
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
    assert.equal(launched.details.status, "started");
    assert.match(launched.content[0].text, /running in the background/);
    assert.equal(parent.sentMessages.length, 0, "launch acceptance is not task completion");
    const received = await waitFor(() => existsSync(join(terminal, "received.json"))
      ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "child task receipt");
    assert.match(received.task, /Return the exact phrase: deterministic task complete\./);
    assert.deepEqual(received.tools, ["ask_question"]);
    assert.match(received.widgets.join("\n"), /echo/);
    assert.ok(received.args.includes(webExtension), "registered tool extensions do not depend on a personal install");
    const identityFile = received.args[received.args.indexOf("--append-system-prompt") + 1];
    assert.equal(readFileSync(identityFile, "utf8"), "You are the deterministic echo role.");
    assert.ok(widgets.some((text) => text.includes("Echo")), "parent shows the delegated child");
    assert.equal(parent.sentMessages.length, 0, "child remains active until explicitly released");
    writeFileSync(join(terminal, "finish"), "release");
    const delivered = await waitFor(() => parent.sentMessages.find((event) => event.message.customType === "subagent_result"), "automatic parent result");
    assert.match(delivered.message.content, /deterministic task complete\./);
    assert.equal(delivered.message.details.name, "Echo");
    assert.equal(delivered.message.details.exitCode, 0);
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
  } finally {
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    if (existsSync(join(terminal, "pid"))) {
      try { process.kill(-Number(readFileSync(join(terminal, "pid"), "utf8")), "SIGKILL"); } catch {}
    }
    // Drain the adapter's debounced layout operation before restoring PATH.
    // Otherwise a delayed callback could accidentally reach a real tmux.
    if (existsSync(join(terminal, "surface"))) {
      await waitFor(() => existsSync(join(terminal, "layout")) &&
        readFileSync(join(terminal, "layout"), "utf8") === "closed" ? true : undefined, "fixture terminal cleanup");
    }
    process.chdir(previousCwd);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
