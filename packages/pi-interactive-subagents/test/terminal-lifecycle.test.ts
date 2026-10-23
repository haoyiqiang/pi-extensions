import { test } from "node:test";
import { setTimeout as yieldToFixture } from "node:timers/promises";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockExtensionApi, plainTheme, waitFor } from "./harness.ts";

// Orca captures the caller at module load, just as it does in a real terminal.
process.env.ORCA_TERMINAL_HANDLE = "term_fixture_parent";
const { default: subagents } = await import("../pi-extension/subagents/index.ts");
const { shellEscape } = await import("@kevinhao/pi-terminal-mux");
const testDir = dirname(fileURLToPath(import.meta.url));

async function withTerminal(backend: "tmux" | "orca" | "unsupported", run: (h: any) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-terminal-")));
  const env = { ...process.env };
  const project = join(root, "project ' ; $not_a_command");
  const terminal = join(root, "terminal");
  const bin = join(root, "bin");
  const sessions = join(root, "sessions");
  for (const dir of [join(project, ".pi/agents"), terminal, bin, sessions]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(testDir, "fixtures/terminal.mjs"), join(bin, "tmux"));
  copyFileSync(join(testDir, "fixtures/terminal.mjs"), join(bin, "orca-runtime.mjs"));
  // Runtime probing has a 1.5s production bound. Keep this cheap probe free of
  // Node startup/disk contention; native terminal operations still use the real
  // executable fixture below, not a mocked controller or mux implementation.
  writeFileSync(join(bin, "orca"), `#!/bin/sh\nif [ "$1" = status ]; then printf '%s\\n' '{"ok":true,"result":{}}'; else exec ${shellEscape(process.execPath)} ${shellEscape(join(bin, "orca-runtime.mjs"))} "$@"; fi\n`, { mode: 0o755 });
  const runtime = [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), join(testDir, "fixtures/runtime.ts")].map(shellEscape).join(" ");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${runtime} "$@"\n`, { mode: 0o755 });
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  Object.assign(process.env, { PATH: `${bin}:${env.PATH}`, PI_CODING_AGENT_DIR: join(root, "config"), SUBAGENT_TEST_TERMINAL: terminal, TMUX_PANE: "%fixture-parent", ORCA_TERMINAL_HANDLE: "term_fixture_parent" });
  if (backend === "unsupported") {
    delete process.env.TMUX; delete process.env.TERM_PROGRAM; delete process.env.PI_TERMINAL_MUX;
  } else {
    process.env.PI_TERMINAL_MUX = backend;
    process.env.TMUX = "fixture";
    process.env.TERM_PROGRAM = "Orca";
  }
  writeFileSync(join(project, ".pi/agents/echo.md"), "---\nname: echo\ntools: read\n---\nDeterministic role\n");
  const parentFile = join(sessions, "parent.jsonl");
  writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "terminal-parent", cwd: project }) + "\n");
  const parent = createMockExtensionApi();
  parent.api.getThinkingLevel = () => "off";
  const widgets: string[] = [];
  const ctx = {
    cwd: project, hasUI: false, model: { provider: "fixture", id: "parent-model" },
    modelRegistry: { getAll: () => [{ provider: "fixture", id: "parent-model" }] },
    sessionManager: { getSessionFile: () => parentFile, getSessionId: () => "terminal-parent", getSessionDir: () => sessions },
    ui: { setWidget(_name: string, factory: any) { if (typeof factory === "function") widgets.push(factory({}, plainTheme).render(100).join("\n")); } },
  };
  const call = (tool: string, params: any) => parent.tool(tool).execute("terminal-test", params, undefined, undefined, ctx);
  const commands = () => existsSync(join(terminal, "commands.jsonl")) ? readFileSync(join(terminal, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const results = () => parent.sentMessages.filter((event) => event.message.customType === "subagent_result");
  try {
    subagents(parent.api);
    await parent.emit("session_start", {}, ctx);
    await run({ root, terminal, project, parent, ctx, widgets, call, commands, results });
  } finally {
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    if (existsSync(join(terminal, "pid"))) { try { process.kill(-Number(readFileSync(join(terminal, "pid"), "utf8")), "SIGKILL"); } catch {} }
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  }
}
const task = "Return the exact phrase: native startup complete.";

async function refusal(operation: Promise<any>): Promise<Error> {
  let failure: Error | undefined;
  await assert.rejects(operation, (error) => {
    if (!(error instanceof Error)) return false;
    failure = error;
    return true;
  });
  return failure!;
}

function terminalDiagnostic(failure: Error) {
  const reference = failure.message.match(/(?:Diagnostic: |inspect )([^\n]+\.json)\.?$/)?.[1];
  assert.ok(reference, "tool failures must expose their inspectable artifact reference");
  return JSON.parse(readFileSync(reference, "utf8"));
}

test("unsupported environments refuse native delegation without promising headless support", async () => {
  await withTerminal("unsupported", async ({ call, terminal }) => {
    const result = await refusal(call("subagent", { agent: "echo", task }));
    assert.match(result.message, /tmux.*Orca/i);
    assert.match(result.message, /headless.*not supported/i);
    assert.equal(existsSync(join(terminal, "surface")), false);
  });
});

test("a supported backend without the parent terminal identity cannot launch against current focus", async () => {
  await withTerminal("tmux", async ({ call, terminal }) => {
    delete process.env.TMUX_PANE;
    await assert.rejects(call("subagent", { agent: "echo", task }), /parent terminal/i);
    assert.equal(existsSync(join(terminal, "surface")), false);
  });
});

async function advanceUntil(t: any, read: () => any, milliseconds = 40_000) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) {
    t.mock.timers.tick(250);
    // Let the external runtime and any already-scheduled real timer progress.
    // Deadlines themselves use the controlled clock, not wall-clock sleeps.
    await yieldToFixture(10);
    const value = read();
    if (value !== undefined) return value;
  }
  assert.fail("operation did not converge within its bounded deadline");
}

test("native creation failure is not retried and retains inspectable launch diagnostics", async () => {
  await withTerminal("tmux", async ({ terminal, call, commands }) => {
    writeFileSync(join(terminal, "create-fails"), "backend failure");
    const failed = await refusal(call("subagent", { agent: "echo", task }));
    assert.match(failed.message, /creation failed/i);
    assert.equal(commands().filter((event: any) => event.args[0] === "split-window").length, 1);
    const diagnostic = terminalDiagnostic(failed);
    assert.equal(existsSync(diagnostic.launchScriptFile), true);
    assert.equal(diagnostic.phase, "create-failed");
    assert.equal(diagnostic.inventory, "unknown", "a failed create receipt cannot prove absence");
    assert.equal(diagnostic.closure, "unconfirmed");
  });
});

for (const inventory of ["present", "absent"]) {
  test(`fast completion during startup inventory is accepted when the surface is ${inventory} and delivers a retained result`, { timeout: 30_000 }, async () => {
    await withTerminal("tmux", async ({ terminal, call, results }) => {
      writeFileSync(join(terminal, "complete-during-inventory"), inventory);
      writeFileSync(join(terminal, "finish"), "complete immediately");
      const launched = await call("subagent", { agent: "echo", name: "Fast", task });
      assert.equal(existsSync(join(terminal, "inventory-timed-out")), false, "the external fixture must finish inside inventory, not on a later poll");
      assert.equal(existsSync(join(terminal, "startup-exited")), true);
      assert.equal(launched.details.status, "started", "acknowledgement accepts launch rather than returning task output");
      const result = await waitFor(() => results()[0], "automatic fast result");
      assert.equal(result.message.details.outcome, "succeeded");
      assert.match(result.message.content, /native startup complete/);
      const status = (await call("subagent_status", { id: launched.details.id })).details.subagent;
      assert.equal(status.state, "completed");
      assert.equal(status.latestResult.outcome, "succeeded");
      assert.equal(JSON.parse(readFileSync(status.latestResult.resultFile, "utf8")).output, "native startup complete.");
    });
  });
}

test("a real child exit before readiness still fails finitely and retains launch diagnostics", { timeout: 30_000 }, async () => {
  await withTerminal("tmux", async ({ root, terminal, call }) => {
    writeFileSync(join(root, "bin/pi"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    writeFileSync(join(terminal, "complete-during-inventory"), "present");
    const failed = await refusal(call("subagent", { agent: "echo", name: "Crash", task }));
    assert.equal(existsSync(join(terminal, "inventory-timed-out")), false);
    assert.match(failed.message, /process exited before its ready signal/i);
    assert.equal(terminalDiagnostic(failed).closure, "confirmed");
    const status = (await call("subagent_status", { name: "Crash" })).details.subagent;
    assert.equal(status.state, "failed");
    assert.match(status.diagnostic, /process exited before its ready signal/i);
  });
});

test("missing child readiness fails finitely and confirms owned startup cleanup", async (t) => {
  await withTerminal("tmux", async ({ terminal, call }) => {
    writeFileSync(join(terminal, "no-runtime"), "never starts the bridge");
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    try {
      let result: any;
      void refusal(call("subagent", { agent: "echo", task })).then((value) => { result = value; });
      const failed = await advanceUntil(t, () => result);
      assert.match(failed.message, /ready|readiness/i);
      assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "closed");
      assert.equal(terminalDiagnostic(failed).closure, "confirmed");
    } finally { t.mock.timers.reset(); }
  });
});

test("startup cleanup uncertainty retains an inspectable record and blocks a replacement", async (t) => {
  await withTerminal("tmux", async ({ terminal, call }) => {
    for (const flag of ["no-runtime", "inventory-unknown", "close-fails"]) writeFileSync(join(terminal, flag), "unavailable");
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    try {
      let result: any;
      void refusal(call("subagent", { agent: "echo", name: "Not ready", task })).then((value) => { result = value; });
      const failed = await advanceUntil(t, () => result);
      const record = terminalDiagnostic(failed);
      assert.equal(record.inventory, "unknown");
      assert.equal(record.closure, "unconfirmed");
      await assert.rejects(call("subagent_message", { name: "Not ready", message: task }), /uncertain/i);
    } finally { t.mock.timers.reset(); }
  });
});

test("a present surface after failed closure retains success and reports unconfirmed cleanup", async (t) => {
  await withTerminal("tmux", async ({ terminal, call, parent, results }) => {
    await call("subagent", { agent: "echo", name: "Close failure", task });
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "child receipt");
    writeFileSync(join(terminal, "close-fails"), "cannot close");
    writeFileSync(join(terminal, "finish"), "release");
    const result = await waitFor(() => results()[0], "settled success");
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    try {
      const cleanup = await advanceUntil(t, () => parent.sentMessages.find((event: any) => event.message.details?.closure === "unconfirmed"));
      const record = JSON.parse(readFileSync(cleanup.message.details.terminalRecordFile, "utf8"));
      assert.equal(record.inventory, "present");
      assert.equal(record.closure, "unconfirmed");
      assert.equal(JSON.parse(readFileSync(result.message.details.resultFile, "utf8")).outcome, "succeeded");
      await assert.rejects(call("subagent_message", { name: "Close failure", message: task }), /uncertain/i);
    } finally { t.mock.timers.reset(); }
  });
});

test("confirmed surface loss without settlement produces a durable interruption instead of waiting forever", async (t) => {
  await withTerminal("tmux", async ({ call, terminal, results }) => {
    const launched = await call("subagent", { agent: "echo", name: "Lost", task });
    assert.equal(launched.details.status, "started");
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "child receipt");
    process.kill(-Number(readFileSync(join(terminal, "pid"), "utf8")), "SIGKILL");
    writeFileSync(join(terminal, "surface"), "gone");
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    try {
      const result = await advanceUntil(t, () => results()[0]);
      assert.equal(result.message.details.outcome, "failed");
      assert.match(result.message.content, /surface.*absent|surface.*disappeared/i);
      assert.match(result.message.content, /interrupt/i);
      const retained = JSON.parse(readFileSync(result.message.details.resultFile, "utf8"));
      assert.equal(retained.source.kind, "surface_absent");
      assert.equal(existsSync(launched.details.sessionFile), true);
    } finally { t.mock.timers.reset(); }
  });
});

test("unknown inventory and failed capture retain work, refuse unsafe delivery, and cannot reverse a durable result", async (t) => {
  await withTerminal("tmux", async ({ call, terminal, parent, results, commands }) => {
    const launched = await call("subagent", { agent: "echo", name: "Uncertain", task });
    assert.equal(launched.details.status, "started");
    await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "child receipt");
    writeFileSync(join(terminal, "diagnostics-unavailable"), "capture is not inventory");
    writeFileSync(join(terminal, "inventory-unknown"), "inventory unavailable");
    const uncertain = await waitFor(() => parent.sentMessages.find((event: any) => event.message.details?.inventory === "unknown"), "inventory uncertainty feedback");
    assert.match(uncertain.message.content, /unknown/);
    assert.equal(results().length, 0);
    await assert.rejects(call("subagent_message", { name: "Uncertain", message: "Do not launch a replacement" }), /unknown|uncertain/i);
    assert.equal(commands().filter((event: any) => event.args[0] === "split-window").length, 1);
    writeFileSync(join(terminal, "finish"), "release");
    const result = await waitFor(() => results()[0], "durable success despite inventory loss");
    assert.equal(result.message.details.outcome, "succeeded");
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    try {
      const cleanup = await advanceUntil(t, () => parent.sentMessages.find((event: any) => event.message.details?.closure === "unconfirmed"));
      assert.match(cleanup.message.content, /retained/);
      const evidence = JSON.parse(readFileSync(cleanup.message.details.terminalRecordFile, "utf8"));
      assert.equal(evidence.inventory, "unknown");
      assert.equal(evidence.closure, "unconfirmed");
      assert.equal(JSON.parse(readFileSync(result.message.details.resultFile, "utf8")).outcome, "succeeded");
      await assert.rejects(call("subagent_message", { name: "Uncertain", message: task }), /uncertain/i,
        "unconfirmed cleanup cannot free the session for a new writer");
    } finally { t.mock.timers.reset(); }
  });
});

for (const activity of ["LONG_PROVIDER", "LONG_TOOL"]) {
  test(`${activity} remains healthy without business events, but a frozen heartbeat becomes unresponsive without killing work`, async (t) => {
    await withTerminal("tmux", async ({ call, terminal, parent, ctx, widgets, results, commands }) => {
      const base = Date.now();
      process.env.SUBAGENT_TEST_CLOCK = String(base);
      ctx.hasUI = true;
      const launched = await call("subagent", { agent: "echo", name: "Long work", task: `${task}\n${activity}` });
      assert.equal(launched.details.status, "started");
      await waitFor(() => existsSync(join(terminal, "received.json")) ? true : undefined, "long work receipt");
      t.mock.timers.enable({ apis: ["Date"], now: base });
      try {
        // No token/tool updates for two minutes, but the child loop still pulses.
        writeFileSync(join(terminal, "clock"), String(base + 120_000));
        await waitFor(() => existsSync(join(terminal, "clock-applied")) && Number(readFileSync(join(terminal, "clock-applied"), "utf8")) === base + 120_000 ? true : undefined, "independent child heartbeat");
        t.mock.timers.tick(120_000);
        await waitFor(() => /active/.test(widgets.at(-1) ?? "") ? true : undefined, "healthy long work display");
        assert.equal(parent.sentMessages.some((event: any) => /unresponsive|stalled/.test(event.message.content)), false);
        assert.match(widgets.at(-1)!, activity === "LONG_TOOL" ? /active.*bash/ : /active.*provider/);
        // The same activity snapshot cannot prove responsiveness forever.
        t.mock.timers.tick(21_000);
        const lost = await waitFor(() => parent.sentMessages.find((event: any) => /unresponsive/.test(event.message.content)), "unresponsive feedback");
        assert.match(lost.message.content, /uncertain|unresponsive/);
        assert.equal(results().length, 0);
        assert.equal(commands().some((event: any) => event.args[0] === "kill-pane"), false);
        // A fresh heartbeat recovers even though business activity never changed.
        const at = Date.now() + 1_000;
        writeFileSync(join(terminal, "clock"), String(at));
        await waitFor(() => Number(readFileSync(join(terminal, "clock-applied"), "utf8")) === at ? true : undefined, "heartbeat recovery");
        t.mock.timers.tick(1_000);
        await waitFor(() => parent.sentMessages.find((event: any) => /recovered/.test(event.message.content)), "responsive recovery");
        assert.equal(results().length, 0);
      } finally { t.mock.timers.reset(); }
      writeFileSync(join(terminal, "finish"), "release");
      const result = await waitFor(() => results()[0], "long work settlement");
      assert.equal(result.message.details.outcome, "succeeded");
    });
  });
}

for (const backend of ["tmux", "orca"] as const) {
  test(`${backend} native launch starts the full command on the parent surface without focus or key injection`, { timeout: 30_000 }, async () => {
    await withTerminal(backend, async ({ call, terminal, project, commands, results }) => {
      // Inherited parent rename authority must not reach a child.
      process.env.PI_TERMINAL_RENAME_CONTEXT = JSON.stringify({ parent: "unrestricted" });
      const launched = await call("subagent", { agent: "echo", name: "Echo ' ; $(touch NOT_EXECUTED)", task });
      assert.equal(launched.details.status, "started");
      const created = commands().find((event: any) => event.args[0] === "split-window" || event.args[1] === "split");
      assert.ok(created, "launch uses the selected backend");
      assert.ok(created.args.includes(backend === "tmux" ? "--" : "--command"), "complete command is submitted during creation");
      assert.ok(created.args.includes(backend === "tmux" ? "%fixture-parent" : "term_fixture_parent"));
      if (backend === "tmux") assert.ok(created.args.includes("-d"), "parent retains focus");
      assert.equal(commands().some((event: any) => event.args[0] === "send-keys" || event.args[1] === "send"), false);
      const child = await waitFor(() => existsSync(join(terminal, "received.json")) ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "native child receipt");
      assert.equal(child.cwd, project);
      assert.equal(child.env.PI_SUBAGENT_NAME, "Echo ' ; $(touch NOT_EXECUTED)");
      assert.deepEqual(JSON.parse(child.env.PI_TERMINAL_RENAME_CONTEXT).ownedTarget, null);
      assert.equal(existsSync(join(project, "NOT_EXECUTED")), false);
      assert.equal(results().length, 0, "launch acceptance is not completion");
      writeFileSync(join(terminal, "finish"), "release");
      const result = await waitFor(() => results()[0], "automatic no-UI result");
      assert.equal(result.message.details.outcome, "succeeded");
      assert.match(result.message.content, /native startup complete/);
    });
  });
}
