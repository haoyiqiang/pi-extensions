import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearConfigCache, loadConfig } from "../src/config/index.ts";
import { saveMetricsConfig } from "../src/features/metrics/store.ts";

function withAgentDir(run: (dir: string) => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "pi-spark-metrics-"));
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

test("legacy pi-metrics config is used only when spark.json omits metrics", () => {
  withAgentDir((dir) => {
    const legacyDir = join(dir, "extensions", "pi-metrics");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), JSON.stringify({ enabled: true, display: "live" }));
    const ctx = { cwd: join(dir, "project"), ui: { notify() {} } } as any;

    const legacy = loadConfig(ctx).metrics;
    assert.notEqual(legacy, false);
    if (legacy !== false) assert.equal(legacy.display, "live");
    clearConfigCache();
    writeFileSync(join(dir, "spark.json"), JSON.stringify({ metrics: { display: "on-stop" } }));
    const current = loadConfig(ctx).metrics;
    assert.notEqual(current, false);
    if (current !== false) assert.equal(current.display, "on-stop");
  });
});

test("metrics false disables telemetry and saving preserves other spark settings", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "spark.json"), JSON.stringify({ footer: false, metrics: false }));
    const ctx = { cwd: join(dir, "project"), ui: { notify() {} } } as any;
    assert.equal(loadConfig(ctx).metrics, false);
    assert.equal(loadConfig(ctx).footer, false);

    clearConfigCache();
    saveMetricsConfig({ display: "live" }, dir);
    const saved = JSON.parse(readFileSync(join(dir, "spark.json"), "utf8"));
    assert.equal(saved.footer, false);
    assert.deepEqual(saved.metrics, { display: "live" });
  });
});
