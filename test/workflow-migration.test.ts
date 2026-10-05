import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("workflow and managed subagents stay independent private migration workspaces", () => {
  const profile = json("package.json").pi.extensions as string[];
  const releases = json("release-please-config.json").packages;
  const manifest = json(".release-please-manifest.json");
  for (const name of ["pi-subagents", "pi-workflow"]) {
    const path = `packages/${name}`;
    const pkg = json(`${path}/package.json`);
    assert.equal(pkg.private, true);
    assert.equal(pkg.pi, undefined);
    assert.equal(pkg.publishConfig, undefined);
    assert.equal(releases[path], undefined);
    assert.equal(manifest[path], undefined);
    assert.ok(!profile.some(entry => entry.startsWith(`${path}/`)));
    for (const other of ["@maplezzk/pi-subagents", "@maplezzk/pi-workflow", "@maplezzk/pi-interactive-subagents"]) {
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[field]?.[other], undefined);
    }
    assert.equal(pkg.devDependencies["@earendil-works/pi-coding-agent"], "0.87.1");
    assert.ok(existsSync(resolve(root, path, "UPSTREAM.md")));
    assert.ok(existsSync(resolve(root, path, "LICENSE")));
  }
  assert.ok(profile.includes("packages/pi-interactive-subagents/index.ts"));
  assert.ok(releases["packages/pi-interactive-subagents"]);
});

test("explicit workflow execution does not load the retained legacy Agent UI or workflow engine", () => {
  const pkg = json("packages/pi-subagents/package.json");
  assert.equal(pkg.exports["./workflow-executor"], "./workflow-executor.ts");
  assert.ok(pkg.files.includes("workflow-executor.ts"));
  const entry = readFileSync(resolve(root, "packages/pi-subagents/workflow-executor.ts"), "utf8");
  assert.match(entry, /registerWorkflowExecutor/);
  assert.doesNotMatch(entry, /["']\.\/src\/index\./);
  assert.doesNotMatch(entry, /workflow\/(?:runtime|host)\./);
  const workflow = json("packages/pi-workflow/package.json");
  assert.equal(workflow.exports["."], "./index.ts");
  assert.equal(workflow.exports["./startup"], "./src/startup.ts");
  assert.ok(workflow.files.includes("extension.ts"));
  assert.ok(workflow.files.includes("config.example.json"));
  assert.ok(workflow.files.includes("locales"));
});

test("workflow executor transport is versioned without a product import or hidden registration slot", () => {
  const source = readFileSync(resolve(root, "packages/pi-subagents/src/workflow/executor-protocol.ts"), "utf8");
  assert.match(source, /pi-workflow:executor:discover:v1/);
  assert.match(source, /WORKFLOW_EXECUTOR_VERSION = 1/);
  const adapter = readFileSync(resolve(root, "packages/pi-subagents/src/workflow/pi-executor.ts"), "utf8");
  assert.match(adapter, /pi\.events\.on\(WORKFLOW_EXECUTOR_DISCOVERY/);
  assert.doesNotMatch(adapter, /Symbol\.for|globalThis|from ["']@(?:maplezzk|juicesharp)\/.*workflow/);
});
