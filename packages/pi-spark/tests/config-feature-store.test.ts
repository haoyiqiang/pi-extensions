import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTempDir } from "pi-utils";
import { patchGlobalFeature, projectOverridesFeature, projectSparkConfigPath, readConfigObject, sparkConfigPath } from "../src/config/store.ts";

test("feature patches preserve sibling spark settings and leave no temporary file", async () => {
  await withTempDir("pi-spark-config-store-", (dir) => {
    patchGlobalFeature("footer", false, dir);
    patchGlobalFeature("metrics", { display: "live" }, dir);
    patchGlobalFeature("resources", false, dir);

    assert.deepEqual(readConfigObject(sparkConfigPath(dir)), {
      footer: false,
      metrics: { display: "live" },
      resources: false,
    });
    assert.deepEqual(readdirSync(dir), ["spark.json"]);
  });
});

test("project override detection is namespaced by feature", async () => {
  await withTempDir("pi-spark-config-store-", (dir) => {
    const cwd = join(dir, "project");
    const path = projectSparkConfigPath(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(path, JSON.stringify({ metrics: false }), { encoding: "utf8", flag: "wx" });

    assert.equal(projectOverridesFeature(cwd, "metrics"), true);
    assert.equal(projectOverridesFeature(cwd, "resources"), false);
  });
});

test("malformed and non-object files fail instead of erasing configuration", async () => {
  await withTempDir("pi-spark-config-store-", (dir) => {
    const path = sparkConfigPath(dir);
    writeFileSync(path, "[]", "utf8");
    assert.throws(() => patchGlobalFeature("resources", false, dir), /configuration must be a JSON object/);
  });
});
