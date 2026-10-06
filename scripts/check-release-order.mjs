import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectPublishedPackageJobs, parseReleaseWorkflow } from "./release-publish-coverage.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const workflowSource = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const workflow = parseReleaseWorkflow(workflowSource);
const packageJobs = collectPublishedPackageJobs(workflowSource);
const packageByName = new Map();
const publicPackageByDirectory = new Map();

for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(PACKAGES_DIR, entry.name, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true) continue;
  const record = { directory: `packages/${entry.name}`, manifest };
  packageByName.set(manifest.name, record);
  publicPackageByDirectory.set(record.directory, record);
}

for (const [directory, jobName] of packageJobs) {
  assert.ok(publicPackageByDirectory.has(directory), `${jobName} must not automatically publish private or unknown package ${directory}`);
}

let edgeCount = 0;
for (const { directory, manifest } of packageByName.values()) {
  const consumerJob = packageJobs.get(directory);
  assert.ok(consumerJob, `${manifest.name} has no automatic npm publish job`);
  assert.ok(jobDependsOn(consumerJob, "release-verify"), `${consumerJob} must wait for the one-time release-verify job`);

  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const dependencyName of Object.keys(manifest[field] ?? {})) {
      const dependency = packageByName.get(dependencyName);
      if (!dependency) continue;
      const dependencyJob = packageJobs.get(dependency.directory);
      assert.ok(dependencyJob, `${dependencyName} has no automatic npm publish job`);
      assert.notEqual(
        consumerJob,
        dependencyJob,
        `${manifest.name} and workspace dependency ${dependencyName} publish in the same parallel job`,
      );
      assert.ok(
        jobDependsOn(consumerJob, dependencyJob),
        `${consumerJob} must wait for ${dependencyJob} before publishing ${manifest.name}`,
      );
      edgeCount += 1;
    }
  }
}

for (const jobName of new Set(packageJobs.values())) {
  const job = workflow.jobs[jobName];
  const commands = (job.steps ?? [])
    .filter((step) => step && typeof step === "object" && typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.doesNotMatch(commands, /\bnpm\s+(?:run\s+check|test)\b/, `${jobName} must not rerun the repository test suite`);
}

console.log(`Release order check passed (${packageJobs.size} packages, ${edgeCount} workspace dependency edges).`);

function jobDependsOn(jobName, dependencyJob, visited = new Set()) {
  if (jobName === dependencyJob) return true;
  if (visited.has(jobName)) return false;
  visited.add(jobName);
  const job = workflow.jobs[jobName];
  if (!job || typeof job !== "object") return false;
  const needs = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
  return needs.some((need) => need === dependencyJob || jobDependsOn(need, dependencyJob, visited));
}
