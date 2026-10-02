import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTempDir } from "@maplezzk/pi-test-utils";
import {
  extensionConfigPath,
  readJsonObject,
  readJsonObjectResult,
  resolveAgentDir,
  tryWriteJsonAtomic,
  updateJsonObjectAtomic,
  writeJsonAtomic,
} from "../index.ts";

test("agent directory resolution supports defaults and tilde overrides", () => {
  assert.equal(resolveAgentDir({}, "/home/test"), "/home/test/.pi/agent");
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~" }, "/home/test"), "/home/test");
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }, "/home/test"), "/home/test/custom");
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/pi" }, "/home/test"), "/tmp/pi");
});

test("extensionConfigPath uses the conventional Pi extension directory", () => {
  assert.equal(extensionConfigPath("pi-example", "settings.json", "/tmp/agent"), "/tmp/agent/extensions/pi-example/settings.json");
});

test("reader distinguishes missing, loaded, malformed, and non-object files", async () => {
  await withTempDir("pi-extensions-config-", (dir) => {
    const path = join(dir, "config.json");
    assert.deepEqual(readJsonObjectResult(path), { status: "missing" });
    writeFileSync(path, '{"enabled":true}', "utf8");
    assert.deepEqual(readJsonObject(path), { enabled: true });
    writeFileSync(path, "{broken", "utf8");
    assert.equal(readJsonObjectResult(path).status, "invalid");
    writeFileSync(path, "[]", "utf8");
    assert.throws(() => readJsonObject(path), /configuration must be a JSON object/);
  });
});

test("atomic writes preserve sibling fields and use owner-only permissions", async () => {
  await withTempDir("pi-extensions-config-", (dir) => {
    const path = join(dir, "nested", "config.json");
    writeJsonAtomic(path, { first: 1 });
    updateJsonObjectAtomic(path, (current) => {
      current.second = 2;
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { first: 1, second: 2 });
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("failed writes return false through the user-facing wrapper", async () => {
  await withTempDir("pi-extensions-config-", (dir) => {
    const parent = join(dir, "blocked");
    writeFileSync(parent, "not a directory", "utf8");
    assert.equal(tryWriteJsonAtomic(join(parent, "config.json"), {}), false);
  });
});
