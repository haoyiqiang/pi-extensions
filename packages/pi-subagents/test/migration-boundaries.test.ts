import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import extension from "../index.js";

const packageRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const readJson = (path: string, root = repositoryRoot) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("private migration boundary", () => {
  it("does not publish or auto-load the imported implementation", () => {
    const manifest = readJson("package.json", packageRoot);
    expect(manifest.name).toBe("@maplezzk/pi-subagents");
    expect(manifest.private).toBe(true);
    expect(manifest.pi).toBeUndefined();
    expect(readJson("release-please-config.json").packages).not.toHaveProperty("packages/pi-subagents");
    expect(Object.keys(readJson(".release-please-manifest.json"))).not.toContain("packages/pi-subagents");
    expect(readFileSync(new URL(".github/workflows/release.yml", repositoryRoot), "utf8"))
      .not.toContain("packages/pi-subagents");
  });

  it("keeps the existing interactive product as the only active subagent entry", () => {
    const entries = readJson("package.json").pi.extensions as string[];
    expect(entries.filter((entry) => entry.includes("subagents")))
      .toEqual(["packages/pi-interactive-subagents/index.ts"]);
    expect(readJson("packages/pi-interactive-subagents/package.json").name)
      .toBe("@maplezzk/pi-interactive-subagents");
  });

  it("exports a source factory without activating its manager", () => {
    expect(typeof extension).toBe("function");
    expect(Reflect.get(globalThis, Symbol.for("pi-subagents:manager"))).toBeUndefined();
  });

  it("keeps Pi development dependencies in lockstep", () => {
    const dependencies = readJson("package.json", packageRoot).devDependencies;
    for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
      expect(dependencies[`@earendil-works/${name}`]).toBe("0.87.1");
    }
  });

  it("retains provenance, the MIT notice, and hidden upstream test fixtures", () => {
    expect(readFileSync(new URL("UPSTREAM.md", packageRoot), "utf8"))
      .toContain("e955e29c51b7a6cce37e1108cd2d6c57a77e151c");
    expect(readFileSync(new URL("LICENSE", packageRoot), "utf8")).toContain("tintinweb");
    for (const file of [
      "test/fixtures/.pi/agents/minimal.md",
      "test/fixtures/.pi/skills/probe-skill.md",
      "docs/upstream-README.md",
      "examples/workflows/fan-out-audit.js",
    ]) {
      expect(existsSync(new URL(file, packageRoot)), file).toBe(true);
    }
  });

  it("runs under isolated test directories with live models disabled", () => {
    expect(process.env.PI_E2E_LIVE).toBe("0");
    expect(process.env.PI_CODING_AGENT_DIR).toContain("pi-subagents-test-home-");
    expect(process.env.HOME).toContain("pi-subagents-test-home-");
    expect(process.cwd()).toContain("pi-subagents-test-home-");
  });
});
