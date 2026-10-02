import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { createExtensionRegistrationHarness, withTempAgentDir } from "../packages/test-utils/index.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("full profile extensions register together without command, tool, or renderer collisions", async () => {
  await withTempAgentDir(async () => {
    const [{ default: blackhole }, { default: distill }, i18nModule, { default: interactiveSubagents }, { default: rewind }, { default: spark }] = await Promise.all([
      import("../packages/pi-blackhole/index.ts"),
      import("../packages/pi-distill/index.ts"),
      import("../packages/pi-extensions-i18n/index.ts"),
      import("../packages/pi-interactive-subagents/index.ts"),
      import("../packages/pi-rewind/index.ts"),
      import("../packages/pi-spark/index.ts"),
    ]);
    const { default: i18n, resetNoticeRenderer } = i18nModule;
    resetNoticeRenderer();
    const harness = createExtensionRegistrationHarness();
    try {
      await harness.load("pi-extensions-i18n", i18n);
      await harness.load("pi-spark", spark);
      await harness.load("pi-distill", distill);
      await harness.load("pi-interactive-subagents", interactiveSubagents);
      await harness.load("pi-blackhole", blackhole);
      await harness.load("pi-rewind", rewind);

      assert.equal(harness.entryRenderers.get("pi-extensions-notice")?.owner, "pi-extensions-i18n");
      assert.equal(harness.entryRenderers.get("pi-distill-audit")?.owner, "pi-distill");
      assert.equal(harness.messageRenderers.get("subagent_result")?.owner, "pi-interactive-subagents");
      assert.equal(harness.tools.get("recall")?.owner, "pi-blackhole");
      assert.equal(harness.tools.get("subagent")?.owner, "pi-interactive-subagents");
      assert.equal(harness.commands.get("rewind")?.owner, "pi-rewind");
      assert.equal(harness.commands.get("config:distill")?.owner, "pi-distill");
      assert.ok(harness.events.length > 0);
    } finally {
      resetNoticeRenderer();
    }
  }, "pi-composition-");
});

test("only pi-spark runtime source claims the editor and footer surfaces", () => {
  const violations: string[] = [];
  for (const packageName of readdirSync(join(ROOT, "packages"))) {
    const packageRoot = join(ROOT, "packages", packageName);
    if (!existsSync(join(packageRoot, "package.json"))) continue;
    for (const file of collectRuntimeFiles(packageRoot)) {
      const source = readFileSync(file, "utf8");
      if (!/\.set(?:EditorComponent|Footer)\s*\(/.test(source)) continue;
      if (packageName !== "pi-spark") violations.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, []);
});

function collectRuntimeFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (["tests", "test", "node_modules"].includes(entry.name)) continue;
      files.push(...collectRuntimeFiles(join(root, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      files.push(join(root, entry.name));
    }
  }
  return files;
}
