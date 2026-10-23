import { test } from "node:test";
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
async function withIdentity(run: (h: any) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-identity-")));
  const env = { ...process.env };
  const terminal = join(root, "terminal");
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const bin = join(root, "bin");
  for (const dir of [join(project, ".pi/agents"), terminal, sessions, bin]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(testDir, "fixtures/terminal.mjs"), join(bin, "tmux"));
  const command = [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), join(testDir, "fixtures/runtime.ts")].map(shellEscape).join(" ");
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
  try {
    subagents(parent.api);
    await parent.emit("session_start", {}, ctx);
    await run({ root, parent, ctx, call, terminal, sessions, project, widgets });
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
  const child = fork(join(testDir, "fixtures/controller.ts"), [root, ...(parentId ? [parentId] : [])], { execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let sequence = 0;
  const pending = new Map<number, (message: any) => void>();
  let stderr = "";
  child.stderr!.on("data", (data) => { stderr += data; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Controller startup timeout: ${stderr}`)); }, 30_000);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Controller exited ${code}: ${stderr}`)); });
    child.on("message", (message: any) => {
      if (message.ready) { clearTimeout(timeout); resolve(); }
      else { pending.get(message.sequence)?.(message); pending.delete(message.sequence); }
    });
  });
  return { child, call(tool: string, params: any): Promise<any> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
      child.send({ sequence: id, tool, params });
    });
  } };
}

test("cross-process double resume admits one writer, retains id and generation, and reconstructs scoped status", { timeout: 60_000 }, async () => {
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
      assert.equal(accepted.length, 1, "the other request must explicitly fail, not falsely acknowledge discarded input");
      const winner = (accepted[0] as PromiseFulfilledResult<any>).value;
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
      const observer = raced[0].status === "rejected" ? a : b;
      await assert.rejects(observer.call("subagent_message", { id: first.details.id, message: task }), /writer|owned|active|uncertain|busy/i);
      writeFileSync(join(terminal, "finish"), "complete");
      await waitFor(() => existsSync(`${winner.details.sessionFile}.process-exit-${recovered.executionId}`) ? true : undefined, "writer exit");
      const completed = (await observer.call("subagent_status", { id: first.details.id })).details.subagent;
      assert.equal(completed.state, "completed");
      assert.equal(completed.latestResult.generation, 2);
      assert.equal(JSON.parse(readFileSync(completed.latestResult.resultFile, "utf8")).output, "identity retained.");
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
      await assert.rejects(c.call("subagent_message", { id: launched.details.id, message: task }), /writer.*(active|uncertain)/i);
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
      await assert.rejects(recreated.call("subagent_message", { id: launched.details.id, message: task }), /writer.*(active|uncertain)/i);
    } finally { recreated.child.kill("SIGKILL"); }
  });
});
