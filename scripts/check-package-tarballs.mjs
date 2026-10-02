#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const releaseConfig = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8"));
const packageDirectories = Object.keys(releaseConfig.packages ?? {}).sort();
const errors = [];

for (const packageDirectory of packageDirectories) {
  const packageRoot = join(ROOT, packageDirectory);
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    errors.push(`${packageDirectory}: package.json is missing`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let report;
  try {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const parsed = JSON.parse(output);
    report = parsed[0];
  } catch (error) {
    errors.push(`${manifest.name ?? packageDirectory}: npm pack --dry-run failed: ${error.message}`);
    continue;
  }

  if (!report || !Array.isArray(report.files)) {
    errors.push(`${manifest.name}: npm pack did not return a file manifest`);
    continue;
  }

  const files = new Set(report.files.map((entry) => normalizePath(entry.path)));
  requireFile(files, "package.json", manifest.name);
  requireFile(files, "README.md", manifest.name);
  requireFile(files, "README.zh-CN.md", manifest.name);

  for (const entry of collectExportPaths(manifest)) {
    requireFile(files, entry, manifest.name);
  }

  for (const extension of manifest.pi?.extensions ?? []) {
    if (extension.startsWith("./")) requireFile(files, extension, manifest.name);
  }

  for (const theme of manifest.pi?.themes ?? []) {
    if (!theme.startsWith("./")) continue;
    const prefix = `${normalizePath(theme).replace(/\/$/, "")}/`;
    if (![...files].some((file) => file.startsWith(prefix))) {
      errors.push(`${manifest.name}: tarball is missing theme resources under "${theme}"`);
    }
  }

  for (const file of files) {
    if (/(^|\/)(?:tests?|__tests__)(\/|$)/.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      errors.push(`${manifest.name}: tarball must not publish test source "${file}"`);
    }
  }

  console.log(`✓ ${manifest.name}@${manifest.version}: ${files.size} files, ${report.unpackedSize} unpacked bytes`);
}

if (errors.length > 0) {
  console.error("\nPackage tarball check failed:");
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Package tarball check passed (${packageDirectories.length} packages).`);

function requireFile(files, rawPath, packageName) {
  const path = normalizePath(rawPath);
  if (!files.has(path)) errors.push(`${packageName}: tarball is missing "${path}"`);
}

function collectExportPaths(manifest) {
  const paths = new Set();
  if (typeof manifest.main === "string") paths.add(manifest.main);
  collectStringLeaves(manifest.exports, paths);
  return [...paths].filter((path) => path.startsWith("./"));
}

function collectStringLeaves(value, output) {
  if (typeof value === "string") {
    output.add(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) collectStringLeaves(child, output);
}

function normalizePath(path) {
  return path.replace(/^\.\//, "").replaceAll("\\", "/");
}
