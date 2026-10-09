import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionRegistrationHarness, withTempAgentDir } from "pi-utils";
import spark from "../index.ts";
import { clearConfigCache } from "../src/config/index.ts";
import { loadNamingConfig } from "../src/config/naming-store.ts";

test("Spark refreshes config before feature startup handlers on reload", async () => {
  await withTempAgentDir(async (agentDir) => {
    clearConfigCache();
    try {
      const path = join(agentDir, "spark.json");
      const ctx = { cwd: agentDir, ui: { notify: () => assert.fail("valid config") } } as unknown as ExtensionContext;
      writeFileSync(path, JSON.stringify({ naming: false }));
      assert.equal(loadNamingConfig(ctx), false);
      const harness = createExtensionRegistrationHarness();
      await harness.load("pi-spark", spark);
      writeFileSync(path, JSON.stringify({ naming: { targets: { workspace: false, tab: false } } }));
      assert.equal(loadNamingConfig(ctx), false, "cached until lifecycle boundary");
      const firstStart = harness.events.find((event) => event.event === "session_start");
      assert.ok(firstStart);
      await firstStart.handler({ type: "session_start", reason: "reload" }, ctx);
      const config = loadNamingConfig(ctx);
      assert.notEqual(config, false);
      if (config !== false) assert.deepEqual(config.targets, { session: true, workspace: false, tab: false });
      assert.equal(harness.events.some((event) => event.event === "session_switch"), false);
    } finally { clearConfigCache(); }
  }, "spark-naming-lifecycle-");
});
