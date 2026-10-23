import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import subagents, { registerToolExtension } from "../pi-extension/subagents/index.ts";
import { createMockExtensionApi, waitFor } from "./harness.ts";
import { shellEscape } from "../pi-extension/subagents/tmux.ts";

const testDir = dirname(fileURLToPath(import.meta.url));

// The approved registered-tool/lifecycle seam, with real files and a process-boundary terminal fixture.
async function withRoles(run: (h: any) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-roles-")));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const project = join(root, "project");
  const config = join(root, "config");
  const terminal = join(root, "terminal");
  const sessions = join(root, "sessions");
  const bin = join(root, "bin");
  for (const dir of [project, config, terminal, sessions, bin]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(testDir, "fixtures/terminal.mjs"), join(bin, "tmux"));
  const command = [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), join(testDir, "fixtures/runtime.ts")].map(shellEscape).join(" ");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, TMUX: "fixture", TMUX_PANE: "%fixture-parent", SUBAGENT_TEST_TERMINAL: terminal, PI_CODING_AGENT_DIR: config, PI_SUBAGENT_SHELL_READY_DELAY_MS: "0" });
  process.chdir(project);
  const parentFile = join(sessions, "parent.jsonl");
  writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "roles-parent", cwd: project }) + "\n");
  const parent = createMockExtensionApi();
  const ctx = {
    cwd: project, hasUI: true, model: { provider: "fixture", id: "parent-model" },
    modelRegistry: { getAll: () => ["parent-model", "role-model", "call-model"].map((id) => ({ provider: "fixture", id })) },
    sessionManager: { getSessionFile: () => parentFile, getSessionId: () => "roles-parent", getSessionDir: () => sessions },
    ui: { setWidget() {} },
  };
  parent.api.getThinkingLevel = () => "low";
  const role = (file: string, fields: string, body = "Original identity", scope = "project") => {
    const dir = scope === "project" ? join(project, ".pi/agents") : join(config, "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${file}.md`);
    writeFileSync(path, `---\n${fields}\n---\n${body}\n`);
    return path;
  };
  const call = async (tool: string, params: any) => parent.tool(tool).execute("test", params, undefined, undefined, ctx);
  const received = () => waitFor(() => existsSync(join(terminal, "received.json")) ? JSON.parse(readFileSync(join(terminal, "received.json"), "utf8")) : undefined, "child receipt");
  const finish = async () => {
    const count = parent.sentMessages.filter((e) => e.message.customType === "subagent_result").length;
    writeFileSync(join(terminal, "finish"), "release");
    await waitFor(() => parent.sentMessages.filter((e) => e.message.customType === "subagent_result").length > count ? true : undefined, "child result");
    rmSync(join(terminal, "finish"), { force: true });
    rmSync(join(terminal, "received.json"), { force: true });
  };
  try {
    subagents(parent.api);
    await parent.emit("session_start", {}, ctx);
    await run({ root, project, config, terminal, parent, ctx, role, call, received, finish });
  } finally {
    await parent.emit("session_shutdown", { reason: "quit" }, ctx);
    if (existsSync(join(terminal, "pid"))) {
      try { process.kill(-Number(readFileSync(join(terminal, "pid"), "utf8")), "SIGKILL"); } catch {}
    }
    if (existsSync(join(terminal, "surface"))) await waitFor(() => existsSync(join(terminal, "layout")) && readFileSync(join(terminal, "layout"), "utf8") === "closed" ? true : undefined, "terminal cleanup");
    process.chdir(previousCwd);
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
}

const task = "Return the exact phrase: loadout verified.";

test("omitted tools fail before launch while an explicit empty set keeps only control tools", { timeout: 30_000 }, async () => {
  await withRoles(async ({ role, call, terminal, received, finish }) => {
    role("missing-tools", "name: missing-tools\nauto-exit: true");
    await assert.rejects(() => call("subagent", { agent: "missing-tools", task }), /explicitly declare tools/);
    assert.equal(existsSync(join(terminal, "surface")), false);
    role("empty-tools", "name: empty-tools\ntools:\nauto-exit: true");
    const launched = await call("subagent", { agent: "empty-tools", task });
    assert.equal(launched.details.status, "started");
    const child = await received();
    assert.equal(child.args[child.args.indexOf("--tools") + 1], "ask_question");
    assert.ok(child.args.includes("--no-extensions"));
    await finish();
  });
});

test("unknown tools, missing backing extensions and ungranted delegation tools fail closed", { timeout: 30_000 }, async () => {
  await withRoles(async ({ role, call, terminal, root }) => {
    registerToolExtension("missing_fixture_tool", join(root, "not-installed.ts"));
    for (const tools of ["made_up_tool", "*", "+bash", "missing_fixture_tool", "subagent", "ask_question,bash,*"]) {
      role("unsafe", `name: unsafe\ntools: ${tools}\nauto-exit: true`);
      await assert.rejects(() => call("subagent", { agent: "unsafe", task }), Error, tools);
      assert.equal(existsSync(join(terminal, "surface")), false, tools);
    }
  });
});

test("resume replays resolved model, cwd, identity, skills, isolation and lifetime after a role is moved", { timeout: 45_000 }, async () => {
  await withRoles(async ({ role, call, root, project, config, ctx, received, finish }) => {
    const target = join(project, "workspace");
    mkdirSync(target);
    const skill = join(config, "skills", "fixture-skill", "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, "---\nname: fixture-skill\ndescription: A fixture skill\n---\nSkill identity");
    const extension = join(config, "extensions/web-fetch/index.ts");
    mkdirSync(dirname(extension), { recursive: true });
    writeFileSync(extension, "export default function () {}\n");
    const path = role("original", "name: pinned\ntools: read,web_fetch\ncwd: workspace\nskills: fixture-skill\nno-skills: true\nno-prompt-templates: true\nno-context-files: true\nsystem-prompt: replace");
    const launched = await call("subagent", { agent: "pinned", task });
    assert.equal(launched.details.status, "started");
    const first = await received();
    assert.equal(first.cwd, target);
    assert.equal(first.args[first.args.indexOf("--model") + 1], "fixture/parent-model");
    assert.equal(first.args[first.args.indexOf("--thinking") + 1], "low");
    assert.equal(first.env.PI_SUBAGENT_AUTO_EXIT, "1");
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) assert.ok(first.args.includes(flag), flag);
    assert.equal(first.args[first.args.indexOf("--skill") + 1], skill);
    await finish();
    renameSync(path, join(root, "moved-role.md"));
    ctx.cwd = root;
    ctx.model = { provider: "changed", id: "changed-parent" };
    const changedConfig = join(root, "changed-config");
    const replacement = join(changedConfig, "extensions/web-fetch/index.ts");
    mkdirSync(dirname(replacement), { recursive: true });
    writeFileSync(replacement, "export default function () {}\n");
    process.env.PI_CODING_AGENT_DIR = changedConfig;
    process.env.PI_SUBAGENT_AUTO_EXIT = "0";
    process.env.PI_SUBAGENT_ALLOWED = "worker";
    const resumed = await call("subagent_message", { name: launched.details.name, message: task });
    assert.equal(resumed.details.status, "started");
    const second = await received();
    assert.equal(second.cwd, target);
    assert.equal(second.args[second.args.indexOf("--model") + 1], "fixture/parent-model");
    assert.equal(second.args[second.args.indexOf("--thinking") + 1], "low");
    assert.equal(second.env.PI_CODING_AGENT_DIR, config);
    assert.equal(second.env.PI_SUBAGENT_AUTO_EXIT, "1");
    assert.equal(second.env.PI_SUBAGENT_ALLOWED, "");
    assert.equal(readFileSync(second.args[second.args.indexOf("--system-prompt") + 1], "utf8"), "Original identity");
    assert.equal(second.args[second.args.indexOf("--skill") + 1], skill);
    assert.ok(second.args.includes(extension));
    assert.ok(!second.args.includes(replacement), "resume cannot rediscover a different backing extension");
    await finish();
    rmSync(extension);
    await assert.rejects(() => call("subagent_message", { name: launched.details.name, message: task }), /Cannot safely resume/, "a missing pinned extension cannot fall back to the replacement");
  });
});

test("resume refuses empty, partial, unknown-version and unavailable-resource snapshots without losing history", { timeout: 45_000 }, async () => {
  await withRoles(async ({ role, call, received, finish, terminal }) => {
    role("restricted", "name: restricted\ntools: read\nauto-exit: true");
    const launched = await call("subagent", { agent: "restricted", task });
    await received();
    await finish();
    const path = `${launched.details.sessionFile}.loadout.json`;
    const original = JSON.parse(readFileSync(path, "utf8"));
    const history = readFileSync(launched.details.sessionFile, "utf8");
    const invalid = [{}, { agent: "restricted" }, { ...original, version: 999 }, { ...original, toolAllowlist: null },
      { ...original, thinking: null }, { ...original, model: null }, { ...original, cwd: null },
      { ...original, model: "fixture/no-such-model" },
      { ...original, extensions: {} }, { ...original, extensions: { ask_question: "/missing/control.ts" } },
      { ...original, skills: [{ name: "gone", path: "/missing/SKILL.md" }] }];
    for (const snapshot of invalid) {
      writeFileSync(path, JSON.stringify(snapshot));
      await assert.rejects(() => call("subagent_message", { name: launched.details.name, message: task }), /fresh|re-delegat/i, JSON.stringify(snapshot));
      assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "closed");
      assert.equal(readFileSync(launched.details.sessionFile, "utf8"), history);
    }
  });
});

test("nested launch, steering and resume use the pinned role policy, not ambient allowlist variables", { timeout: 45_000 }, async () => {
  await withRoles(async ({ role, call, received, finish, terminal }) => {
    role("manager", "name: manager\ntools: read\nsubagent_agents: allowed\nauto-exit: true");
    role("allowed", "name: allowed\ntools: read\nauto-exit: true");
    role("forbidden", "name: forbidden\ntools: read\nauto-exit: true");
    const managed = await call("subagent", { agent: "manager", task });
    await received();
    await finish();
    const forbidden = await call("subagent", { agent: "forbidden", task });
    await received();
    process.env.PI_SUBAGENT_SESSION = managed.details.sessionFile;
    process.env.PI_SUBAGENT_ALLOWED = "forbidden";
    await assert.rejects(() => call("subagent_message", { name: forbidden.details.name, message: task }), /allowlist/, "running targets obey the same pinned policy");
    delete process.env.PI_SUBAGENT_SESSION;
    await finish();
    process.env.PI_SUBAGENT_SESSION = managed.details.sessionFile;
    process.env.PI_SUBAGENT_ALLOWED = "manager,forbidden";
    process.env.PI_SUBAGENT_AGENT = "forged-identity";
    for (const agent of ["manager", "forbidden", "unknown", ""]) {
      await assert.rejects(() => call("subagent", { agent, task }), Error, agent);
      assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "closed");
    }
    await assert.rejects(() => call("subagent_message", { name: forbidden.details.name, message: task }), /allowlist/);
    const listed = await call("subagents_list", {});
    assert.deepEqual(listed.details.agents.map((a: any) => a.name), ["allowed"]);
    const allowed = await call("subagent", { agent: "allowed", task });
    assert.equal(allowed.details.status, "started");
    const child = await received();
    assert.equal(child.env.PI_SUBAGENT_ALLOWED, "");
    assert.equal(child.env.PI_SUBAGENT_AGENT, "allowed");
    await finish();
    const noGrantSession = allowed.details.sessionFile;
    process.env.PI_SUBAGENT_SESSION = noGrantSession;
    process.env.PI_SUBAGENT_ALLOWED = "manager,forbidden";
    await assert.rejects(() => call("subagent", { agent: "forbidden", task }), /allowlist/, "absence of a delegation grant is deny-all even if this extension is explicitly loaded");
  });
});

test("project/global/package precedence, hidden roles and call/role models resolve through the native tools", { timeout: 60_000 }, async () => {
  await withRoles(async ({ role, call, project, config, received, finish }) => {
    for (const base of [project, config]) mkdirSync(join(base, "relative"));
    const global = role("global-alias", "name: scout\ntools: read\nmodel: fixture/role-model\ncwd: relative\nsystem-prompt: append", "Global identity", "global");
    const local = role("project-alias", "name: scout\ntools: read\nmodel: fixture/role-model\ncwd: relative\nsystem-prompt: append\ndisable-model-invocation: true", "Project identity");
    const listed = await call("subagents_list", {});
    assert.ok(!listed.details.agents.some((a: any) => a.name === "scout"), "hidden project role shadows visible global and bundled roles");
    const hidden = await call("subagent", { agent: "scout", model: "fixture/call-model", task });
    assert.equal(hidden.details.status, "started");
    const first = await received();
    assert.equal(first.cwd, join(project, "relative"));
    assert.equal(first.args[first.args.indexOf("--model") + 1], "fixture/call-model");
    assert.equal(readFileSync(first.args[first.args.indexOf("--append-system-prompt") + 1], "utf8"), "Project identity");
    await finish();
    rmSync(local);
    const globalList = await call("subagents_list", {});
    assert.equal(globalList.details.agents.find((a: any) => a.name === "scout").source, "global");
    await call("subagent", { agent: "scout", task });
    const second = await received();
    assert.equal(second.cwd, join(config, "relative"));
    assert.equal(second.args[second.args.indexOf("--model") + 1], "fixture/role-model");
    assert.equal(readFileSync(second.args[second.args.indexOf("--append-system-prompt") + 1], "utf8"), "Global identity");
    await finish();
    rmSync(global);
    const bundled = await call("subagents_list", {});
    assert.equal(bundled.details.agents.find((a: any) => a.name === "scout").source, "package");
    await call("subagent", { agent: "scout", model: "fixture/call-model", cwd: "relative", task });
    const third = await received();
    assert.equal(third.cwd, join(project, "relative"), "call cwd is relative to the parent context");
    assert.equal(third.args[third.args.indexOf("--tools") + 1], "read,grep,find,ls,ask_question");
    await finish();
  });
});

test("invalid profile values and missing selected skills fail before launch", { timeout: 30_000 }, async () => {
  await withRoles(async ({ role, call, terminal }) => {
    for (const field of ["thinking: invalid", "auto-exit: maybe", "no-skills: maybe", "session-mode: unknown", "system-prompt: unknown", "skills: not-installed", "model: fixture/not-installed", "cli: unknown"]) {
      role("invalid", `name: invalid\ntools: read\n${field}`);
      await assert.rejects(() => call("subagent", { agent: "invalid", task }), Error, field);
      assert.equal(existsSync(join(terminal, "surface")), false, field);
    }
  });
});

test("only fully pinned restrictive legacy loadouts can resume", { timeout: 45_000 }, async () => {
  await withRoles(async ({ role, call, received, finish, terminal }) => {
    role("legacy", "name: legacy\ntools: read\nauto-exit: true\nsystem-prompt: append");
    const launched = await call("subagent", { agent: "legacy", task });
    await received();
    await finish();
    const path = `${launched.details.sessionFile}.loadout.json`;
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    const legacy = Object.fromEntries(["agent", "toolAllowlist", "model", "thinking", "systemPromptMode", "identity", "spawnable", "autoExit", "cwd", "agentDir"].map((key) => [key, snapshot[key]]));
    for (const unsafe of [{ ...legacy, model: null }, { ...legacy, cwd: null }, { ...legacy, toolAllowlist: null }, { ...legacy, toolAllowlist: "read,web_search,ask_question" }]) {
      writeFileSync(path, JSON.stringify(unsafe));
      await assert.rejects(() => call("subagent_message", { name: launched.details.name, message: task }), /Cannot safely resume/);
      assert.equal(readFileSync(join(terminal, "surface"), "utf8"), "closed");
    }
    writeFileSync(path, JSON.stringify(legacy));
    const resumed = await call("subagent_message", { name: launched.details.name, message: task });
    assert.equal(resumed.details.status, "started");
    const child = await received();
    assert.equal(child.args[child.args.indexOf("--tools") + 1], "read,ask_question");
    assert.ok(child.args.includes("--no-extensions"));
    await finish();
  });
});

test("explicit resident policy and inherited actual cwd survive a changed role and parent", { timeout: 45_000 }, async () => {
  await withRoles(async ({ role, call, received, finish, project, root, terminal, ctx }) => {
    const file = role("resident", "name: resident\ntools: read\nauto-exit: false");
    const launched = await call("subagent", { agent: "resident", task });
    const first = await received();
    assert.equal(first.cwd, project);
    assert.equal(first.env.PI_SUBAGENT_AUTO_EXIT, "0");
    writeFileSync(join(terminal, "close-resident"), "manual closure");
    await finish();
    await waitFor(() => readFileSync(join(terminal, "surface"), "utf8") === "closed" ? true : undefined, "confirmed resident process-exit cleanup");
    rmSync(join(terminal, "close-resident"));
    writeFileSync(file, "---\nname: resident\ntools: bash\nauto-exit: true\n---\nChanged identity\n");
    ctx.cwd = root;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    const resumed = await call("subagent_message", { name: launched.details.name, message: task });
    assert.equal(resumed.details.status, "started");
    const second = await received();
    assert.equal(second.cwd, project);
    assert.equal(second.env.PI_SUBAGENT_AUTO_EXIT, "0");
    assert.equal(second.args[second.args.indexOf("--tools") + 1], "read,ask_question");
    assert.match(second.task, /^Original identity/);
    writeFileSync(join(terminal, "close-resident"), "manual closure");
    await finish();
  });
});

test("launch uses the discovered declared role, not a second filename lookup", { timeout: 30_000 }, async () => {
  await withRoles(async ({ role, call, received, finish }) => {
    role("different-filename", "name: alias\ntools: read\nsystem-prompt: append\nauto-exit: true");
    const listed = await call("subagents_list", {});
    assert.ok(listed.details.agents.some((a: any) => a.name === "alias"));
    const launched = await call("subagent", { agent: "alias", task });
    assert.equal(launched.details.status, "started");
    const child = await received();
    assert.equal(child.args[child.args.indexOf("--tools") + 1], "read,ask_question");
    assert.equal(readFileSync(child.args[child.args.indexOf("--append-system-prompt") + 1], "utf8"), "Original identity");
    await finish();
  });
});
