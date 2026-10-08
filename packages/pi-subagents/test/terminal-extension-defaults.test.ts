import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionPolicyError, snapshotExtensionDefaults } from "../src/extension-defaults.js";
import { captureRuntimePolicy } from "../src/runtime-policy.js";
import { prepareStandardTerminalPolicy, type StandardTerminalPolicy } from "../src/backends/terminal/standard-policy.js";
import { initializeStandardTerminalRuntime, standardResourceOptions } from "../src/backends/terminal/standard-resources.js";
import { createStandardTerminalSession, forkStandardTerminalSession, openStandardTerminalSession } from "../src/backends/terminal/standard-session.js";
import type { StandardTerminalChildConfig } from "../src/backends/terminal/bridge-protocol.js";
import type { AgentConfig, ExtensionRule } from "../src/types.js";

const definition = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "fixture", description: "fixture", skills: false, systemPrompt: "Prompt", promptMode: "replace", ...overrides,
});

describe("standard terminal extension policy", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let originalAgentDir: string | undefined;
  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    root = mkdtempSync(join(tmpdir(), "terminal-extension-defaults-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });
  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  function policy(overrides: Partial<StandardTerminalPolicy> = {}): StandardTerminalPolicy {
    return {
      profile: "standard", type: "fixture", name: "fixture", cwd, configCwd: cwd, cli: "pi",
      agent: definition(), isolated: false, projectTrusted: true, persistSession: true,
      tools: ["read"], systemPrompt: "Prompt", interactive: false, autoExit: true, ...overrides,
    };
  }
  function config(selected: StandardTerminalPolicy): StandardTerminalChildConfig {
    return {
      version: 1, policy: selected, promptFile: join(root, "prompt.txt"), agentDir,
      providerExtensions: [join(root, "provider.ts")], outputMode: "json",
    };
  }
  function extension(path: string, tool: string) {
    return { path, resolvedPath: path, tools: new Map([[tool, {}]]) };
  }
  function resources(selected: StandardTerminalPolicy) {
    const child = config(selected);
    const bridge = extension("<inline:pi-subagents-terminal-bridge>", "private_bridge");
    const provider = extension(child.providerExtensions[0], "provider_write");
    const ordinary = extension(join(root, "ordinary.ts"), "ordinary_tool");
    const rootProduct = extension(join(root, "pi-spark", "index.ts"), "root_tool");
    const base = { extensions: [bridge, provider, ordinary, rootProduct], errors: [], runtime: {} } as unknown as LoadExtensionsResult;
    const factories: InlineExtension[] = [{ name: "pi-subagents-terminal-bridge", hidden: true, factory: () => {} }];
    const options = standardResourceOptions(child, factories);
    return { options, result: options.extensionsOverride(base), bridge, provider, ordinary, factories };
  }

  it.each(([false, []] as const).map((value) => [value]))("disables ordinary plugins for %j while preserving private and provider-only injection", (extensions) => {
    const { options, result, bridge, provider, factories } = resources(policy({ resolvedExtensions: extensions }));
    expect(options.noExtensions).toBe(true);
    expect(options.extensionFactories).toBe(factories);
    expect(options.additionalExtensionPaths).toEqual([join(root, "provider.ts")]);
    expect(result.extensions.map((entry) => entry.path)).toEqual([bridge.path, provider.path]);
    expect(result.extensions[1].tools.size).toBe(0);
    expect(result.extensions[0].tools.has("private_bridge")).toBe(true);
  });

  it("applies child-product and deny filters after an explicit all/list selection", () => {
    const all = resources(policy({ resolvedExtensions: true }));
    expect(all.options.noExtensions).toBe(false);
    expect(all.result.extensions.map((entry) => entry.path)).toContain(all.ordinary.path);
    expect(all.result.extensions.map((entry) => entry.path)).not.toContain(join(root, "pi-spark", "index.ts"));
    const denied = resources(policy({ agent: definition({ excludeExtensions: ["ordinary"] }), resolvedExtensions: ["ordinary"] }));
    expect(denied.result.extensions).toHaveLength(2);
    const isolated = resources(policy({ isolated: true, resolvedExtensions: true }));
    expect(isolated.options.noExtensions).toBe(true);
    expect(isolated.result.extensions).toHaveLength(2);
  });

  it.each(([true, false, [], ["saved"]] as const).map((value) => [value]))("retains a new saved %j selection on reattach and fork after default edits", (selection) => {
    const reference = createStandardTerminalSession(policy({ resolvedExtensions: selection }), join(root, "sessions"));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ defaultExtensions: ["today"] }));
    const reopened = openStandardTerminalSession(reference);
    expect(reopened.policy.resolvedExtensions).toEqual(selection);
    if (Array.isArray(selection)) expect(Object.isFrozen(reopened.policy.resolvedExtensions)).toBe(true);
    const fork = forkStandardTerminalSession(reference, reopened.policy, join(root, "forks"));
    expect(openStandardTerminalSession(fork).policy.resolvedExtensions).toEqual(selection);
    expect(fork.sessionId).not.toBe(reference.sessionId);
  });

  it.each(([undefined, true, false, [], ["old"]] as const).map((value) => [value]))("uses an old saved agent rule %j, not current defaults", (extensions) => {
    const reference = createStandardTerminalSession(policy({ agent: definition({ extensions: extensions as ExtensionRule | undefined }) }), join(root, "sessions"));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ defaultExtensions: false }));
    const reopened = openStandardTerminalSession(reference);
    expect(reopened.policy.resolvedExtensions).toEqual(extensions ?? true);
    const fork = forkStandardTerminalSession(reference, reopened.policy, join(root, "forks"));
    expect(openStandardTerminalSession(fork).policy.resolvedExtensions).toEqual(extensions ?? true);
  });

  it("does not swallow a saved legacy property in the invalid-record catch", () => {
    const reference = createStandardTerminalSession(policy(), join(root, "sessions"));
    const path = `${reference.sessionFile}.pi-subagents-terminal.json`;
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.policy.agent.sourcePath = "saved-legacy.md";
    stored.policy.agent.inherit_extensions = false;
    stored.policy.agent.extensions = true;
    writeFileSync(path, JSON.stringify(stored));
    expect(() => openStandardTerminalSession(reference)).toThrow(ExtensionPolicyError);
    expect(() => openStandardTerminalSession(reference)).toThrow("saved-legacy.md");
  });

  async function prepare(extensions?: ExtensionRule, captured = captureRuntimePolicy(cwd, true)) {
    const ctx = { cwd, getSystemPrompt: () => "Parent", modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    return prepareStandardTerminalPolicy(ctx, "fixture", {
      pi, agentConfig: definition({ extensions }), runtimePolicy: captured, resolvedExtensions: true,
    });
  }

  it.each(([false, [], ["specific"]] as const).map((value) => [value]))("keeps explicit direct-backend rule %j authoritative over a forged internal field", async (extensions) => {
    const prepared = await prepare(extensions as ExtensionRule);
    expect(prepared.policy.resolvedExtensions).toEqual(extensions);
  });

  it("uses admission-owned absent defaults without reading a later invalid setting", async () => {
    const extensionDefaults = snapshotExtensionDefaults(cwd, true, {});
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ defaultExtensions: null }));
    const ctx = { cwd, getSystemPrompt: () => "Parent", modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    const prepared = await prepareStandardTerminalPolicy(ctx, "fixture", { pi, agentConfig: definition(), extensionDefaults });
    expect(prepared.policy.resolvedExtensions).toBe(true);
    expect(prepared.policy.runtimePolicy?.settings.defaultExtensions).toBeUndefined();
  });

  it.each([true, false])("boots saved terminal runtime without reopening defaults (new policy=%j)", (current) => {
    const saved = policy(current ? { runtimePolicy: captureRuntimePolicy(cwd, true), resolvedExtensions: [] } : {});
    const reference = createStandardTerminalSession(saved, join(root, "sessions"));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ defaultExtensions: null }));
    const restored = openStandardTerminalSession(reference).policy;
    const initialized = initializeStandardTerminalRuntime(restored);
    expect(initialized.settings.defaultExtensions).toBeUndefined();
    expect(resources(restored).options.noExtensions).toBe(current);
  });

  it("copies and freezes extension arrays restored from a saved agent", () => {
    const reference = createStandardTerminalSession(policy({
      agent: definition({ extensions: ["alpha"], excludeExtensions: ["beta"], extSelectors: ["ext:alpha"] }),
    }), join(root, "sessions"));
    const restored = openStandardTerminalSession(reference).policy;
    expect(Object.isFrozen(restored.agent.extensions)).toBe(true);
    expect(Object.isFrozen(restored.agent.excludeExtensions)).toBe(true);
    expect(Object.isFrozen(restored.agent.extSelectors)).toBe(true);
  });

  it("captures live defaults for direct preparation, but absent captured defaults remain compatibility all", async () => {
    const absent = captureRuntimePolicy(cwd, true);
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ defaultExtensions: false }));
    const captured = await prepare(undefined, absent);
    expect(captured.policy.resolvedExtensions).toBe(true);
    const ctx = { cwd, getSystemPrompt: () => "Parent", modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    const live = await prepareStandardTerminalPolicy(ctx, "fixture", { pi, agentConfig: definition(), projectTrusted: true });
    expect(live.policy.resolvedExtensions).toBe(false);
  });
});
