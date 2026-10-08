import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInChildSessionContext } from "../src/child-context.js";
import { standardResourceOptions } from "../src/backends/terminal/standard-resources.js";
import type { StandardTerminalChildConfig } from "../src/backends/terminal/bridge-protocol.js";

/** Real offline SDK discovery: no process, model, network or UI setup. */
describe("ordinary-off SDK resource loading", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "extension-loader-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.each([false, []].map((value) => [value]))("retains private factories and explicit provider paths for %j", async (resolvedExtensions) => {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    mkdirSync(agentDir);
    const provider = join(root, "provider.ts");
    const ordinary = join(cwd, ".pi", "extensions", "ordinary.ts");
    const toolSource = (name: string) => `export default function(pi) {
      pi.registerTool({ name: ${JSON.stringify(name)}, label: "probe", description: "probe",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }) });
    }`;
    writeFileSync(provider, toolSource("provider_only_probe"));
    writeFileSync(ordinary, toolSource("ordinary_probe"));
    let privateLoaded = false;
    const factories: InlineExtension[] = [{
      name: "pi-subagents-terminal-private-probe", hidden: true,
      factory: (pi) => {
        privateLoaded = true;
        pi.registerTool({ name: "private_probe", label: "private", description: "private",
          parameters: { type: "object", properties: {} } as any,
          execute: async () => ({ content: [{ type: "text", text: "private" }], details: {} }),
        });
      },
    }];
    const config: StandardTerminalChildConfig = {
      version: 1, agentDir, providerExtensions: [provider], promptFile: join(root, "prompt"), outputMode: "json",
      policy: {
        profile: "standard", type: "probe", name: "probe", cwd, configCwd: cwd, cli: "pi",
        agent: { name: "probe", description: "probe", skills: false, systemPrompt: "probe", promptMode: "replace" },
        resolvedExtensions: resolvedExtensions as boolean | string[], isolated: false, projectTrusted: true,
        persistSession: false, tools: ["read"], systemPrompt: "probe", interactive: false, autoExit: true,
      },
    };
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
      ...standardResourceOptions(config, factories),
    });
    await runInChildSessionContext(() => loader.reload());
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(privateLoaded).toBe(true);
    expect(loaded.extensions.map((entry) => entry.path)).toContain(provider);
    expect(loaded.extensions.map((entry) => entry.path)).not.toContain(ordinary);
    expect(loaded.extensions.find((entry) => entry.path === provider)?.tools.size).toBe(0);
    expect(loaded.extensions.flatMap((entry) => [...entry.tools.keys()])).toContain("private_probe");
    expect(loaded.extensions.flatMap((entry) => [...entry.tools.keys()])).not.toContain("provider_only_probe");
  });
});
