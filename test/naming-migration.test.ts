import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("Spark owns naming distribution without a second standalone package", () => {
  assert.equal(existsSync(resolve(root, "packages/pi-naming")), false);
  const profile = json("package.json").pi.extensions as string[];
  assert.ok(profile.includes("packages/pi-spark/index.ts"));
  assert.ok(!profile.some((path) => path.includes("pi-naming") || path.includes("pi-terminal-mux")));
  const spark = json("packages/pi-spark/package.json");
  assert.ok(spark.dependencies["pi-terminal-mux"]);
  assert.equal(spark.dependencies["pi-naming"], undefined);
  assert.ok(spark.pi.extensions.includes("../pi-extensions-i18n/index.ts"));
  assert.ok(spark.files.includes("config.example.json"));
  assert.equal(json("release-please-config.json").packages["packages/pi-naming"], undefined);
  assert.equal(json(".release-please-manifest.json")["packages/pi-naming"], undefined);
  const lock = json("package-lock.json");
  assert.equal(lock.packages["packages/pi-naming"], undefined);
  assert.equal(lock.packages["node_modules/pi-naming"], undefined);
  assert.equal(lock.packages["packages/pi-spark"].dependencies["pi-terminal-mux"], spark.dependencies["pi-terminal-mux"]);
});

test("Spark ships matching naming catalogs and a canonical config example", () => {
  const catalogs = ["en-US", "zh-CN"].map((locale) => json(`packages/pi-spark/locales/${locale}.json`));
  const keys = (catalog: Record<string, unknown>) => Object.keys(catalog).filter((key) => key.startsWith("naming.")).sort();
  assert.deepEqual(keys(catalogs[0]), keys(catalogs[1]));
  for (const catalog of catalogs) {
    for (const key of ["sessionNameSystem", "renameDescription", "configCommandDescription", "namingConfigInvalidField"]) {
      assert.equal(typeof catalog[`naming.${key}`], "string");
    }
  }
  const example = json("packages/pi-spark/config.example.json");
  assert.equal(example.naming.automaticNaming, true);
  assert.equal(example.naming.manualNaming, true);
  assert.deepEqual(example.naming.targets, { session: true, workspace: true, tab: true });
});
