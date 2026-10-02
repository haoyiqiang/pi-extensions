// @ts-nocheck
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearConfigCache } from "../src/config/index.ts";
import { configPath, loadConfig, normalizeConfig, saveConfig } from "../src/features/clean-mode/config-store.ts";
import { DEFAULT_CLEAN_MODE_CONFIG } from "../src/features/clean-mode/types.ts";

function withAgentDir(run: (agentDir: string, ctx: any) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-clean-mode-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  clearConfigCache();
  try {
    run(agentDir, { cwd: join(agentDir, "project"), ui: { notify() {} } });
  } finally {
    clearConfigCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeLegacyConfig(agentDir: string, value: unknown): void {
  const dir = join(agentDir, "extensions", "pi-clean-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(value), "utf8");
}

test("spark config missing returns clean-mode defaults", () => {
  withAgentDir((_agentDir, ctx) => {
    assert.deepEqual(loadConfig(ctx).config, DEFAULT_CLEAN_MODE_CONFIG);
  });
});

test("legacy partial config is used only when spark.json omits cleanMode", () => {
  withAgentDir((agentDir, ctx) => {
    writeLegacyConfig(agentDir, { enabled: false, showRunHeader: false });
    const legacy = loadConfig(ctx).config;
    assert.equal(legacy.enabled, false);
    assert.equal(legacy.showRunHeader, false);
    assert.equal(legacy.hideThinking, DEFAULT_CLEAN_MODE_CONFIG.hideThinking);

    clearConfigCache();
    writeFileSync(configPath(), JSON.stringify({ cleanMode: { enabled: true } }));
    assert.equal(loadConfig(ctx).config.enabled, true);
  });
});

test("field type mismatches fall back independently", () => {
  const normalized = normalizeConfig({ enabled: "yes", showRunHeader: 1 });
  assert.equal(normalized.enabled, DEFAULT_CLEAN_MODE_CONFIG.enabled);
  assert.equal(normalized.showRunHeader, DEFAULT_CLEAN_MODE_CONFIG.showRunHeader);
});

test("saving cleanMode preserves other spark settings", () => {
  withAgentDir((_agentDir, ctx) => {
    writeFileSync(configPath(), JSON.stringify({ footer: false }));
    const config = { ...DEFAULT_CLEAN_MODE_CONFIG, autoExpandWhileRunning: false };
    const result = saveConfig(config);
    assert.equal(result.success, true);
    const saved = JSON.parse(readFileSync(configPath(), "utf8"));
    assert.equal(saved.footer, false);
    assert.deepEqual(saved.cleanMode, config);
    assert.deepEqual(loadConfig(ctx).config, config);
  });
});
