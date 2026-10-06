import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { collectPublishedPackageDirectories, parseReleaseWorkflow } from "./release-publish-coverage.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function workflow(jobs) {
  return `jobs:\n${jobs}`;
}

const publishRun = "npm publish --provenance";

test("真实发布工作流覆盖分波 matrix 与专用自动发布 job，并去重", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.deepEqual(collectPublishedPackageDirectories(source), [
    "packages/pi-extensions-config",
    "packages/pi-extensions-i18n",
    "packages/pi-web-search",
    "packages/pi-distill",
    "packages/pi-models-discovery",
    "packages/pi-blackhole",
    "packages/pi-context-view",
    "packages/pi-rewind",
    "packages/pi-terminal-mux",
    "packages/pi-spark",
  ]);
});

test("自动发布覆盖不包含任何 private workspace", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const directory of collectPublishedPackageDirectories(source)) {
    const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
    assert.notEqual(manifest.private, true, `${directory} must not be automatically published`);
  }
});

test("手动重试仅允许 release-managed public package", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const workflow = parseReleaseWorkflow(source);
  const retry = workflow.jobs["publish-npm-retry"];
  const guard = retry.steps.find((step) => step.name === "Verify package is release-managed and public");
  assert.match(guard.run, /release-please-config\.json/);
  assert.match(guard.run, /manifest\.private === true/);
});

test("registry 验证 step 不是发布覆盖", () => {
  const source = workflow(`
  verify-only:
    steps:
      - working-directory: packages/pi-spark
        run: npm view pi-terminal-mux version
`);
  assert.deepEqual(collectPublishedPackageDirectories(source), []);
});

test("删除专用 mux publish step 会移除覆盖，删除唯一 Spark matrix 项会使配置失败", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const withoutMux = source.replace(/\n      - name: Publish to npm\n        working-directory: packages\/pi-terminal-mux\n        run: \|[\s\S]*?\n          fi\n/, "\n");
  assert.ok(!collectPublishedPackageDirectories(withoutMux).includes("packages/pi-terminal-mux"));
  const withoutSpark = source.replace("\n          - dir: packages/pi-spark", "");
  assert.throws(() => collectPublishedPackageDirectories(withoutSpark), /matrix\.include/);
});

test("只有 matrix 而没有 publish step 不算发布覆盖", () => {
  const source = workflow(`
  publish-npm:
    strategy:
      matrix:
        include:
          - dir: packages/independent
    steps:
      - working-directory: \${{ matrix.dir }}
        run: npm test
`);
  assert.deepEqual(collectPublishedPackageDirectories(source), []);
});

test("matrix 只在同一 publish job 使用 matrix.dir 时展开", () => {
  const source = workflow(`
  unrelated-matrix:
    strategy:
      matrix:
        include:
          - dir: packages/wrong
    steps:
      - run: echo ignored
  publish-npm:
    strategy:
      matrix:
        include:
          - dir: packages/first
          - dir: packages/second
    steps:
      - working-directory: \${{ matrix.dir }}
        run: |
          ${publishRun}
`);
  assert.deepEqual(collectPublishedPackageDirectories(source), ["packages/first", "packages/second"]);
});

test("run 默认目录适用于 publish step，无法解析的目录直接失败", () => {
  const withDefault = `
defaults:
  run:
    working-directory: packages/defaulted
jobs:
  publish-defaulted:
    steps:
      - run: ${publishRun}
`;
  assert.deepEqual(collectPublishedPackageDirectories(withDefault), ["packages/defaulted"]);

  const unresolved = workflow(`
  publish-unknown:
    steps:
      - run: ${publishRun}
`);
  assert.throws(() => collectPublishedPackageDirectories(unresolved), /no resolvable working-directory/);
});
