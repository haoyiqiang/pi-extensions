import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir, getLegacyWorkflowConfigDir } from "../src/config.ts";
import { getDocsProtocol } from "../src/docs-protocol.ts";
import { cachedImport } from "../src/load/cache.ts";
import { loadWorkflows, projectOverlayPaths, userOverlayPaths } from "../src/load/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const tempDirectory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "pi-workflow-import-"));
  temporaryDirectories.push(path);
  return path;
};
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("unpublished product metadata", () => {
  it("declares the extension entry while remaining unpublished", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("@maplezzk/pi-workflow");
    expect(pkg.private).toBe(true);
    expect(pkg.pi.extensions).toEqual(["./extension.ts", "../pi-extensions-i18n/index.ts"]);
    expect(pkg.publishConfig).toBeUndefined();
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./internal", "./registration", "./runner", "./startup"]);
    for (const target of Object.values(pkg.exports)) expect(existsSync(join(root, String(target)))).toBe(true);
    expect(Object.keys(pkg.dependencies).some((name) => name.startsWith("@juicesharp/"))).toBe(false);
  });

  it("keeps public and explicit extension entry points separate", async () => {
    const publicApi = await import("@maplezzk/pi-workflow");
    const extension = await import("../extension.ts");
    expect(publicApi.runWorkflow).toBeTypeOf("function");
    expect("default" in publicApi).toBe(false);
    expect(extension.default).toBeTypeOf("function");
  });

  it("references the relocated, preserved documentation", () => {
    const protocol = getDocsProtocol();
    for (const name of ["workflow-basics.md", "workflow-authoring.md"]) {
      const path = join(root, "docs", name);
      expect(protocol).toContain(path);
      expect(existsSync(path)).toBe(true);
    }
  });
});

describe("portable paths without storage migration", () => {
  it("resolves the isolated Pi agent directory through the shared foundation", () => {
    expect(getAgentDir()).toBe(join(process.env.HOME!, ".pi", "agent"));
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    expect(getAgentDir()).toBe(join(process.env.HOME!, "custom-agent"));
    expect(userOverlayPaths().configFile).toBe(join(process.env.HOME!, ".config", "rpiv-workflow", "config.ts"));
  });

  it.each([undefined, "", "   ", "relative/path", "~someone/path"])("preserves legacy fallback for XDG=%s", (value) => {
    if (value === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = value;
    expect(getLegacyWorkflowConfigDir()).toBe(join(process.env.HOME!, ".config", "rpiv-workflow"));
  });

  it.each(["~", "~/custom-config"])("expands legacy XDG=%s", (value) => {
    process.env.XDG_CONFIG_HOME = ` ${value} `;
    expect(getLegacyWorkflowConfigDir()).toBe(join(process.env.HOME!, value === "~" ? "" : "custom-config", "rpiv-workflow"));
  });

  it("honors absolute XDG and leaves project paths unchanged", () => {
    const cwd = tempDirectory();
    process.env.XDG_CONFIG_HOME = ` ${cwd} `;
    expect(getLegacyWorkflowConfigDir()).toBe(join(cwd, "rpiv-workflow"));
    expect(projectOverlayPaths(cwd)).toEqual({
      configFile: join(cwd, ".rpiv", "workflows", "config.ts"),
      packsDir: join(cwd, ".rpiv", "workflows", "packs"),
    });
  });
});

describe("project workflow approval", () => {
  it("excludes untrusted executable definitions before import, including previously cached ones", async () => {
    const cwd = tempDirectory();
    const marker = join(cwd, "project-code-ran");
    const { configFile } = projectOverlayPaths(cwd);
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, `import { writeFileSync } from "node:fs";
import { defineWorkflow, acts } from "@maplezzk/pi-workflow";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default defineWorkflow({ name: "project-only", start: "step",
  stages: { step: acts.prompt({ prompt: "approved prompt" }) }, edges: { step: "stop" } });`);

    const rejected = await loadWorkflows(cwd, { projectTrusted: false });
    expect(existsSync(marker)).toBe(false);
    expect(rejected.workflows).toEqual([]);
    expect(rejected.issues).toContainEqual(expect.objectContaining({ layer: "project", severity: "warning" }));

    expect((await loadWorkflows(cwd, { projectTrusted: true })).workflows.map(({ name }) => name)).toEqual(["project-only"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect((await loadWorkflows(cwd, { projectTrusted: false })).workflows).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("scoped workflow package aliases", () => {
  it.each(["@maplezzk/pi-workflow", "@juicesharp/rpiv-workflow"])("loads config authored against %s outside the workspace", async (name) => {
    const cwd = tempDirectory();
    const { configFile } = projectOverlayPaths(cwd);
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, `import { defineWorkflow, acts } from ${JSON.stringify(name)};
export default defineWorkflow({ name: "portable", start: "review", stages: { review: acts() }, edges: { review: "stop" } });`);
    const loaded = await loadWorkflows(cwd);
    expect(loaded.issues).toEqual([]);
    expect(loaded.workflows.map((workflow) => workflow.name)).toEqual(["portable"]);
  });

  it.each(["@maplezzk/pi-workflow", "@juicesharp/rpiv-workflow"])("resolves public subpaths for %s without an upstream installation", async (name) => {
    const module = join(tempDirectory(), "aliases.ts");
    writeFileSync(module, `import { defineWorkflow } from "${name}/registration";
import { registerBuiltIns } from "${name}/startup";
import { runWorkflow } from "${name}/runner";
import { __resetLoadCache } from "${name}/internal";
export default [defineWorkflow, registerBuiltIns, runWorkflow, __resetLoadCache].map((value) => typeof value);`);
    expect(await cachedImport(module)).toEqual(["function", "function", "function", "function"]);
  });
});
