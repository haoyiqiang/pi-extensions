import { parseDocument } from "yaml";

const MATRIX_DIRECTORY = "${{ matrix.dir }}";
const PACKAGE_DIRECTORY = /^\.?\/?(packages\/[\w-]+)$/;

function isManualOnlyJob(job) {
  return typeof job.if === "string" && job.if.includes("github.event_name == 'workflow_dispatch'");
}

function publishesNpm(run) {
  return run.split(/\r?\n/).some((line) => {
    const command = line.trim();
    return !command.startsWith("#") && /^(?:command\s+)?npm(?:\s+--[^\s]+)*\s+publish(?:\s|$)/.test(command);
  });
}

function packageDirectory(value, jobName) {
  if (typeof value !== "string") {
    throw new Error(`release.yml ${jobName}: npm publish has no resolvable working-directory`);
  }
  const match = value.match(PACKAGE_DIRECTORY);
  if (!match) {
    throw new Error(`release.yml ${jobName}: cannot resolve npm publish working-directory "${value}"`);
  }
  return match[1];
}

function resolveStepDirectories(step, job, workflow, jobName) {
  const workingDirectory = step["working-directory"]
    ?? job.defaults?.run?.["working-directory"]
    ?? workflow.defaults?.run?.["working-directory"];
  if (workingDirectory === MATRIX_DIRECTORY) {
    const include = job.strategy?.matrix?.include;
    if (!Array.isArray(include)) {
      throw new Error(`release.yml ${jobName}: npm publish uses matrix.dir without strategy.matrix.include`);
    }
    const directories = include.map((entry) => packageDirectory(entry?.dir, jobName));
    if (directories.length === 0) {
      throw new Error(`release.yml ${jobName}: npm publish matrix has no package directories`);
    }
    return directories;
  }
  return [packageDirectory(workingDirectory, jobName)];
}

export function parseReleaseWorkflow(workflowSource) {
  const document = parseDocument(workflowSource);
  if (document.errors.length > 0) {
    throw new Error(`release.yml cannot be parsed: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const workflow = document.toJS();
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow) || !workflow.jobs || typeof workflow.jobs !== "object") {
    throw new Error("release.yml must contain a jobs mapping");
  }
  return workflow;
}

/** Maps every automatically published package directory to its publish job. */
export function collectPublishedPackageJobs(workflowSource) {
  const workflow = parseReleaseWorkflow(workflowSource);
  const packageJobs = new Map();
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job) || isManualOnlyJob(job)) continue;
    if (!Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.run !== "string" || !publishesNpm(step.run)) continue;
      for (const directory of resolveStepDirectories(step, job, workflow, jobName)) {
        const previous = packageJobs.get(directory);
        if (previous && previous !== jobName) {
          throw new Error(`release.yml publishes "${directory}" from both ${previous} and ${jobName}`);
        }
        packageJobs.set(directory, jobName);
      }
    }
  }
  return packageJobs;
}

/** Extract package directories from automatic jobs containing an npm publish command. */
export function collectPublishedPackageDirectories(workflowSource) {
  return [...collectPublishedPackageJobs(workflowSource).keys()];
}
