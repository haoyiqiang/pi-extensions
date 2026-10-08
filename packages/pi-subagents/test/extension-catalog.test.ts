import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { discoverExtensionCatalog } from "../src/ui/extension-catalog.js";
import { hermeticDir } from "./helpers/boot-extension.js";

function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function extensionPackage(root: string, name: string, entries = ["./src/index.ts"], extra = {}) {
  json(join(root, "package.json"), { name, pi: { extensions: entries, ...extra } });
  for (const entry of entries) {
    const path = join(root, entry);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "throw new Error('MODULE MUST NOT EXECUTE'); export default () => { throw new Error('FACTORY MUST NOT EXECUTE'); };\n");
  }
}

describe("metadata-only native extension catalog", () => {
  it("discovers canonical package groups and directories without imports, factories, network or installation", async () => {
    const env = hermeticDir();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const pkg = join(agentDir, "safe-tools");
    extensionPackage(pkg, "@test/safe-tools", ["./src/index.ts", "./other/index.ts"]);
    const settingsPath = join(agentDir, "settings.json");
    json(settingsPath, { packages: [pkg, "npm:@pi-catalog-sentinel/missing@0.0.0", "git:github.com/pi-catalog-sentinel/missing@missing"] });
    const original = readFileSync(settingsPath, "utf8");
    const install = vi.spyOn(DefaultPackageManager.prototype, "install");
    const update = vi.spyOn(DefaultPackageManager.prototype, "update");
    const temporary = vi.spyOn(DefaultPackageManager.prototype, "resolveExtensionSources");
    const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const catalog = await discoverExtensionCatalog(env.dir, { projectTrusted: true });
      expect(catalog).toHaveLength(1);
      expect(catalog[0]).toMatchObject({ value: "safe-tools", available: true, aliases: expect.arrayContaining(["src", "safe-tools", "other"]) });
      expect(catalog[0].description).toContain(join(pkg, "src/index.ts"));
      expect(catalog[0].description).toContain(join(pkg, "other/index.ts"));
      expect(install).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(temporary).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledOnce();
      expect(await resolve.mock.calls[0][0]!("npm:missing-source")).toBe("skip");
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(join(agentDir, "npm", "node_modules", "@pi-catalog-sentinel", "missing"))).toBe(false);
      expect(readFileSync(settingsPath, "utf8")).toBe(original);
    } finally { vi.restoreAllMocks(); env.restore(); }
  });

  it("normalizes directory entrypoints natively, excluding root/UI/ambient products and disabled resources", async () => {
    const env = hermeticDir();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const dirs = ["pi-subagents", "pi-spark", "pi-workflow", "observer", "disabled-tools", "safe-tools"]
      .map(name => join(agentDir, name));
    dirs.forEach((dir, index) => extensionPackage(dir, `@test/${dir.split("/").at(-1)}`,
      [index === 2 ? "./src/extension.ts" : "./src/index.ts"], index === 3 ? { ambientObserver: true } : {}));
    json(join(agentDir, "settings.json"), {
      extensions: dirs.filter((_, index) => index !== 4),
      packages: [{ source: dirs[4], extensions: [] }],
    });
    try {
      const catalog = await discoverExtensionCatalog(env.dir, { projectTrusted: true });
      expect(catalog.map(option => option.value)).toEqual(["safe-tools"]);
      expect(catalog[0].paths).toContain(join(dirs[5], "src/index.ts"));
    } finally { env.restore(); }
  });

  it("uses the native trust layer for candidate data, not untrusted project settings or auto resources", async () => {
    const env = hermeticDir();
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    extensionPackage(join(agentDir, "extensions/global-tools"), "@test/global-tools");
    extensionPackage(join(env.dir, ".pi/extensions/project-tools"), "@test/project-tools");
    extensionPackage(join(env.dir, "explicit-tools"), "@test/explicit-tools");
    json(join(env.dir, ".pi/settings.json"), { extensions: ["../explicit-tools"] });
    try {
      const denied = await discoverExtensionCatalog(env.dir, { projectTrusted: false });
      expect(denied.map(option => option.value)).toEqual(["global-tools"]);
      const approved = await discoverExtensionCatalog(env.dir, { projectTrusted: true });
      expect(approved.map(option => option.value)).toEqual(["explicit-tools", "global-tools", "project-tools"]);
    } finally { env.restore(); }
  });
});
