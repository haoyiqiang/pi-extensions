import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { buildNewAgentFile, serializeAgentFile } from "../src/agent-file-toggle.js";
import { buildAgentRegistry, getConfig, registerAgents } from "../src/agent-types.js";
import type { AgentExecutionBackend, ExecutionRunOptions } from "../src/backends/types.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { loadCustomAgents, parseAgentFrontmatter } from "../src/custom-agents.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { ExtensionPolicyError, ordinaryExtensionsDisabled, parseExtensionRule, resolveExtensions, resolveSavedExtensions } from "../src/extension-defaults.js";
import { captureRuntimePolicy } from "../src/runtime-policy.js";
import { resolveChildAgentConfig } from "../src/child-resource-policy.js";
import { createRoutedExecutionBackend } from "../src/runtime.js";
import { snapshotExtensionDefaults } from "../src/extension-defaults.js";
import { loadDefaultExtensions, loadSettings, saveSettings } from "../src/settings.js";
import type { AgentConfig, ExtensionRule } from "../src/types.js";

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "policy-probe", description: "policy", skills: true, systemPrompt: "policy", promptMode: "replace", ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function backendHarness() {
  const gate = deferred<void>();
  const calls: ExecutionRunOptions[] = [];
  const session: ExecutionSession = {
    reference: { backend: "embedded", sessionId: "fixture" }, messages: [],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    subscribe: () => () => {},
  };
  const backend: AgentExecutionBackend = {
    kind: "embedded",
    async run(_ctx, _type, _prompt, options) {
      calls.push(options);
      if (calls.length === 1) await gate.promise;
      return { session, responseText: "done", aborted: false, steered: false };
    },
    resume: async () => ({ text: "done" }), steer: async () => {}, shutdown: async () => {},
  };
  return { backend, calls, release: () => gate.resolve() };
}

describe("extension defaults core", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  const managers: AgentManager[] = [];
  const releases: Array<() => void> = [];
  const globalFile = () => join(agentDir, "subagents.json");
  const projectFile = () => join(cwd, ".pi", "subagents.json");
  const writeGlobal = (value: unknown) => writeFileSync(globalFile(), JSON.stringify(value));
  const writeProject = (value: unknown) => writeFileSync(projectFile(), JSON.stringify(value));

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    root = mkdtempSync(join(tmpdir(), "extension-defaults-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    registerAgents(new Map());
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const manager of managers.splice(0)) await manager.dispose();
    registerAgents(new Map());
    vi.restoreAllMocks();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(([undefined, true, false, [], ["a", "b"]] as const).map((value) => [value]))("preserves the raw rule %j", (value) => {
    const parsed = parseExtensionRule(value, "fixture.md");
    expect(parsed).toEqual(value);
    if (Array.isArray(value)) expect(parsed).not.toBe(value);
  });

  it.each([null, 0, {}, [true], ["a", 2], [null], [" "], "inherit", "a,b"].map((value) => [value]))("rejects invalid JSON rule %j", (value) => {
    expect(() => parseExtensionRule(value, "bad.json")).toThrow(ExtensionPolicyError);
    expect(() => parseExtensionRule(value, "bad.json")).toThrow("bad.json");
  });

  it("accepts legacy CSV spelling without changing skills or collapsing []", () => {
    expect(parseExtensionRule("a, b", "agent.md", { allowCsv: true })).toEqual(["a", "b"]);
    expect(parseExtensionRule("none", "agent.md", { allowCsv: true })).toBe(false);
    expect(parseExtensionRule("", "agent.md", { allowCsv: true })).toBe(false);
    expect(() => parseExtensionRule("a,,b", "agent.md", { allowCsv: true })).toThrow("agent.md");
    writeFileSync(join(cwd, ".pi", "agents", "arrays.md"), "---\nextensions: []\ninherit_skills: false\n---\nPrompt");
    const loaded = loadCustomAgents(cwd).get("arrays")!;
    expect(loaded.extensions).toEqual([]);
    expect(loaded.skills).toBe(false);
    expect(ordinaryExtensionsDisabled(resolveExtensions({ agent: loaded, defaultExtensions: true }))).toBe(true);
  });

  it.each(([undefined, true, false, [], ["a"]] as const).map((value) => [value]))("serializes raw extension rule %j in both writers", (value) => {
    const configuration = agent({ extensions: value as ExtensionRule | undefined });
    for (const content of [
      serializeAgentFile(configuration),
      buildNewAgentFile({ description: "new", tools: "read", systemPrompt: "Prompt", extensions: value as ExtensionRule | undefined }),
    ]) {
      const raw = parseAgentFrontmatter<Record<string, unknown>>(content).frontmatter;
      expect(raw.extensions).toEqual(value);
      expect(Object.hasOwn(raw, "extensions")).toBe(value !== undefined);
    }
  });

  it("omits the field in every builtin and in both config projection fallbacks", () => {
    for (const [name, definition] of DEFAULT_AGENTS) {
      expect(Object.hasOwn(definition, "extensions"), name).toBe(false);
      expect(getConfig(name).extensions).toBeUndefined();
    }
    expect(getConfig("missing").extensions).toBeUndefined();
    expect(buildAgentRegistry(new Map(), { disableDefaultAgents: true }).size).toBe(0);
  });

  it("selects explicit > captured default > compatibility true, with owned frozen arrays", () => {
    expect(resolveExtensions({ agent: agent(), defaultExtensions: false })).toBe(false);
    expect(resolveExtensions({ agent: agent({ extensions: true }), defaultExtensions: false })).toBe(true);
    expect(resolveExtensions({ agent: agent({ extensions: false }), defaultExtensions: true, resolvedExtensions: true })).toBe(false);
    expect(resolveExtensions({ agent: agent() })).toBe(true);
    expect(resolveExtensions({ agent: agent({ extensions: true }), isolated: true })).toBe(false);
    expect(resolveExtensions({ agent: agent({ enabled: false }), defaultExtensions: true })).toBe(false);
    const input = ["alpha"];
    const rule = resolveExtensions({ agent: agent({ extensions: input }), defaultExtensions: false, resolvedExtensions: true });
    input.push("beta");
    expect(rule).toEqual(["alpha"]);
    expect(Object.isFrozen(rule)).toBe(true);
    expect(resolveExtensions({ agent: agent({ extensions: [] }), defaultExtensions: true })).toEqual([]);
    expect(ordinaryExtensionsDisabled(false)).toBe(true);
    expect(ordinaryExtensionsDisabled([])).toBe(true);
  });

  it("reports the trusted source and lets project [] override global without pinning on unrelated save", () => {
    expect(loadSettings(cwd)).not.toHaveProperty("defaultExtensions");
    expect(loadDefaultExtensions(cwd)).toEqual({ value: undefined, source: "unset" });
    writeGlobal({ defaultExtensions: ["alpha"] });
    expect(loadDefaultExtensions(cwd, { projectTrusted: true })).toEqual({ value: ["alpha"], source: "global", path: globalFile() });
    expect(saveSettings({ ...loadSettings(cwd), showCost: true }, cwd)).toBe(true);
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).not.toHaveProperty("defaultExtensions");
    writeProject({ defaultExtensions: [], futureKey: "kept" });
    expect(loadDefaultExtensions(cwd, { projectTrusted: true })).toEqual({ value: [], source: "project", path: projectFile() });
    expect(loadDefaultExtensions(cwd, { projectTrusted: false })).toEqual({ value: ["alpha"], source: "global", path: globalFile() });
    expect(saveSettings({ showCost: false, defaultExtensions: true }, cwd)).toBe(true);
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toMatchObject({ defaultExtensions: [], futureKey: "kept" });
  });

  it.each([null, "none", "alpha,beta", 1, {}, [false], ["alpha", 7]].map((value) => [value]))("validates invalid defaults in each participating layer: %j", (invalid) => {
    writeGlobal({ defaultExtensions: invalid });
    writeProject({ defaultExtensions: false });
    expect(() => loadSettings(cwd, { projectTrusted: true })).toThrow(globalFile());
    expect(() => loadDefaultExtensions(cwd, { projectTrusted: true })).toThrow(globalFile());
    writeGlobal({ defaultExtensions: true });
    writeProject({ defaultExtensions: invalid });
    expect(() => loadSettings(cwd, { projectTrusted: true })).toThrow(projectFile());
    expect(loadSettings(cwd, { projectTrusted: false }).defaultExtensions).toBe(true);
  });

  it.each(["inherit_extensions: false", "inherit_extensions: null\nextensions: true", "inherit_extensions: []\nenabled: false", 'inherit_extensions: false\nname: "bad:name"'])("fails closed immediately for a legacy file (%s)", (fields) => {
    const path = join(cwd, ".pi", "agents", "Explore.md");
    writeFileSync(path, `---\n${fields}\n---\nPrompt`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => loadCustomAgents(cwd, false)).toThrow(path);
    expect(() => loadCustomAgents(cwd, true)).toThrow(ExtensionPolicyError);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["extensions: null", "extensions: 2", "extensions: [alpha, false]", "extensions: {bad: value}"])("does not substitute malformed rules (%s)", (fields) => {
    const path = join(cwd, ".pi", "agents", "general-purpose.md");
    writeFileSync(path, `---\n${fields}\n---\nPrompt`);
    expect(() => loadCustomAgents(cwd, false)).toThrow(path);
  });

  function makeManager() {
    const harness = backendHarness();
    releases.push(harness.release);
    const manager = new AgentManager(undefined, 1, undefined, undefined, undefined, harness.backend);
    managers.push(manager);
    const ctx = { cwd, isProjectTrusted: () => true } as ExtensionContext;
    const pi = {} as ExtensionAPI;
    return { ...harness, manager, ctx, pi };
  }

  it.each([[true, false], [true, null], [false, false], [false, null]])("captures absent defaults before queueing (policy=%j, later=%j)", async (supplied, later) => {
    const h = makeManager();
    const captured = supplied ? captureRuntimePolicy(cwd, true) : undefined;
    const first = h.manager.spawn(h.pi, h.ctx, "general-purpose", "first", { description: "first", isBackground: true, runtimePolicy: captured });
    const second = h.manager.spawn(h.pi, h.ctx, "general-purpose", "queued", { description: "queued", isBackground: true, runtimePolicy: captured });
    expect(h.manager.getRecord(second)?.status).toBe("queued");
    writeProject({ defaultExtensions: later });
    h.release();
    await h.manager.getRecord(first)!.promise;
    await h.manager.awaitStartup(second);
    await h.manager.getRecord(second)!.promise;
    expect(h.calls[1].resolvedExtensions).toBe(true);
    expect(h.calls[1].runtimePolicy).toBe(captured);
    expect(h.calls[1].extensionDefaults?.settings.defaultExtensions).toBeUndefined();
  });

  it("owns queued explicit arrays and captured defaults even after caller and disk mutations", async () => {
    const h = makeManager();
    writeProject({ defaultExtensions: ["alpha"] });
    const first = h.manager.spawn(h.pi, h.ctx, "general-purpose", "first", { description: "first", isBackground: true, projectTrusted: true });
    const input = ["explicit"];
    const definition = agent({ extensions: input });
    const second = h.manager.spawn(h.pi, h.ctx, definition.name, "queued", {
      description: "queued", isBackground: true, agentConfig: definition, projectTrusted: true,
    });
    const third = h.manager.spawn(h.pi, h.ctx, "general-purpose", "default", { description: "default", isBackground: true, projectTrusted: true });
    input.push("leaked");
    definition.extensions = true;
    writeProject({ defaultExtensions: null });
    h.release();
    await h.manager.getRecord(first)!.promise;
    await h.manager.awaitStartup(second);
    await h.manager.getRecord(second)!.promise;
    await h.manager.awaitStartup(third);
    await h.manager.getRecord(third)!.promise;
    expect(h.calls[1].resolvedExtensions).toEqual(["explicit"]);
    expect(h.calls[1].agentConfig?.extensions).toEqual(["explicit"]);
    expect(Object.isFrozen(h.calls[1].resolvedExtensions)).toBe(true);
    expect(h.calls[2].resolvedExtensions).toEqual(["alpha"]);
    expect(Object.isFrozen(h.calls[2].extensionDefaults?.settings.defaultExtensions)).toBe(true);
  });

  it.each(([false, [], ["explicit"], true] as const).map((value) => [value]))("overwrites forged admission selection for explicit %j", async (extensions) => {
    const h = makeManager();
    const first = h.manager.spawn(h.pi, h.ctx, "general-purpose", "first", { description: "first", isBackground: true });
    const second = h.manager.spawn(h.pi, h.ctx, "policy-probe", "queued", {
      description: "queued", isBackground: true, agentConfig: agent({ extensions: extensions as ExtensionRule }), resolvedExtensions: true,
      extensionDefaults: { configCwd: cwd, projectTrusted: true, settings: { defaultExtensions: true } },
    });
    h.release();
    await h.manager.getRecord(first)!.promise;
    await h.manager.awaitStartup(second);
    await h.manager.getRecord(second)!.promise;
    expect(h.calls[1].resolvedExtensions).toEqual(extensions);
    if (Array.isArray(extensions)) expect(h.calls[1].resolvedExtensions).not.toBe(extensions);
  });

  it("overwrites a forged internal choice for omitted rules and isolation", async () => {
    const h = makeManager();
    writeProject({ defaultExtensions: false });
    const first = h.manager.spawn(h.pi, h.ctx, "general-purpose", "first", {
      description: "first", isBackground: true, projectTrusted: true, resolvedExtensions: true,
      extensionDefaults: { configCwd: cwd, projectTrusted: true, settings: { defaultExtensions: true } },
    });
    const second = h.manager.spawn(h.pi, h.ctx, "general-purpose", "queued", {
      description: "queued", isBackground: true, isolated: true, resolvedExtensions: true,
    });
    h.release();
    await h.manager.getRecord(first)!.promise;
    await h.manager.awaitStartup(second);
    await h.manager.getRecord(second)!.promise;
    expect(h.calls.map((call) => call.resolvedExtensions)).toEqual([false, false]);
  });

  it("selects the trusted definition before its cwd and rule", async () => {
    const h = makeManager();
    writeGlobal({ defaultExtensions: false });
    const untrusted = agent({ name: "Explore", source: "project", extensions: true, cwd: "untrusted-target" });
    const id = h.manager.spawn(h.pi, h.ctx, "Explore", "trusted", {
      description: "trusted", agentConfig: untrusted, projectTrusted: false,
    });
    h.release();
    await h.manager.getRecord(id)!.promise;
    expect(h.calls[0].agentConfig?.isDefault).toBe(true);
    expect(h.calls[0].resolvedExtensions).toBe(false);
    expect(h.calls[0].cwd).toBeUndefined();
  });

  it("rejects own legacy programmatic properties before queue/fallback and leaves the registry intact", () => {
    const h = makeManager();
    const legacy = { ...agent({ name: "Explore", source: "project", sourcePath: "legacy-program.md" }), inherit_extensions: undefined };
    expect(() => h.manager.spawn(h.pi, h.ctx, "Explore", "bad", {
      description: "bad", agentConfig: legacy, projectTrusted: false,
    })).toThrow("legacy-program.md");
    expect(h.calls).toHaveLength(0);
    expect(() => registerAgents(new Map([["Explore", legacy]]))).toThrow(ExtensionPolicyError);
    expect(getConfig("Explore").extensions).toBeUndefined();
  });

  it("does not re-read default settings during trusted-definition fallback or routed backend startup", async () => {
    const extensionDefaults = snapshotExtensionDefaults(cwd, false, {});
    writeGlobal({ defaultExtensions: null });
    expect(resolveChildAgentConfig("Explore", DEFAULT_AGENTS.get("Explore"), {
      configCwd: cwd, projectTrusted: false, settings: extensionDefaults.settings,
    })?.isDefault).toBe(true);
    const h = backendHarness();
    releases.push(h.release);
    h.release();
    const router = createRoutedExecutionBackend({ cwd, embedded: () => h.backend });
    await router.run({ cwd } as ExtensionContext, "Explore", "queued", { pi: {} as ExtensionAPI, extensionDefaults });
    expect(h.calls).toHaveLength(1);
  });

  it("restores old saved fields without reading today's default", () => {
    writeProject({ defaultExtensions: false });
    expect(resolveSavedExtensions({ agent: agent(), isolated: false })).toBe(true);
    expect(resolveSavedExtensions({ agent: agent({ extensions: [] }), isolated: false })).toEqual([]);
    expect(resolveSavedExtensions({ agent: agent(), isolated: false, resolvedExtensions: ["saved"] })).toEqual(["saved"]);
  });
});
