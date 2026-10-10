import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearConfigCache, loadConfig } from "../src/config/index.ts";
import { saveResourcesConfig } from "../src/features/session-resources/store.ts";

function withAgentDir(run: (dir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "pi-spark-resources-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  clearConfigCache();
  try {
    run(dir);
  } finally {
    clearConfigCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("legacy session-resources disable applies only when spark.json omits resources", () => {
  withAgentDir((dir) => {
    const legacyDir = join(dir, "extensions", "pi-session-resources");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), JSON.stringify({ enabled: false }));
    const ctx = { cwd: join(dir, "project"), ui: { notify() {} } } as any;

    assert.equal(loadConfig(ctx).resources, false);
    clearConfigCache();
    writeFileSync(join(dir, "spark.json"), JSON.stringify({ resources: {} }));
    assert.notEqual(loadConfig(ctx).resources, false);
  });
});

test("resources accepts the retired enabled flag inside spark.json", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "spark.json"), JSON.stringify({ resources: { enabled: false } }));
    const ctx = { cwd: join(dir, "project"), ui: { notify() {} } } as any;
    const resources = loadConfig(ctx).resources;
    assert.notEqual(resources, false);
    if (resources !== false) assert.equal(resources.enabled, false);
  });
});

test("saving resources preserves other spark settings", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "spark.json"), JSON.stringify({ footer: false, resources: {} }));
    saveResourcesConfig(false, dir);
    const saved = JSON.parse(readFileSync(join(dir, "extensions", "pi-spark", "config.json"), "utf8"));
    assert.equal(saved.footer, false);
    assert.equal(saved.resources, false);
  });
});
