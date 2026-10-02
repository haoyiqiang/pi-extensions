#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const targetDirectory = process.argv[2];
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 5_000;

if (!targetDirectory) {
  console.error("Usage: node scripts/verify-published-workspace-deps.mjs packages/<name>");
  process.exit(2);
}

const targetRoot = resolve(ROOT, targetDirectory);
const targetManifestPath = join(targetRoot, "package.json");
if (!existsSync(targetManifestPath) || !isWithin(targetRoot, PACKAGES_DIR)) {
  console.error(`Invalid workspace package directory: ${targetDirectory}`);
  process.exit(2);
}

const workspaceNames = new Set();
for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(PACKAGES_DIR, entry.name, "package.json");
  if (!existsSync(manifestPath)) continue;
  workspaceNames.add(JSON.parse(readFileSync(manifestPath, "utf8")).name);
}

const manifest = JSON.parse(readFileSync(targetManifestPath, "utf8"));
const dependencies = new Map();
for (const field of ["dependencies", "optionalDependencies"]) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (workspaceNames.has(name)) dependencies.set(name, range);
  }
}

for (const [name, range] of dependencies) {
  await verifyPublishedRange(name, range);
}

console.log(`Published workspace dependency check passed for ${manifest.name} (${dependencies.size} dependencies).`);

async function verifyPublishedRange(name, range) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("npm", ["view", `${name}@${range}`, "version", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const value = JSON.parse(stdout);
      const versions = Array.isArray(value) ? value : [value];
      if (versions.some((version) => typeof version === "string" && version.length > 0)) {
        console.log(`✓ ${name}@${range} is available from npm`);
        return;
      }
      throw new Error("npm view returned no matching version");
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        console.log(`Waiting for ${name}@${range} to become visible on npm (${attempt}/${MAX_ATTEMPTS})...`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(`Workspace dependency ${name}@${range} is not available from npm: ${lastError?.message ?? lastError}`);
}

function isWithin(path, parent) {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}
