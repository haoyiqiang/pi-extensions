#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

const PACKAGE_LAYERS = new Map([
  ["pi-utils", "foundation"],
  ["pi-terminal-mux", "foundation"],
  ["pi-spark", "product"],
  ["pi-blackhole", "product"],
  ["pi-distill", "capability"],
  ["@maplezzk/pi-todo", "capability"],
  ["pi-action-fusion", "capability"],
  ["@maplezzk/pi-web-search", "capability"],
  ["pi-models-discovery", "capability"],
  ["pi-rewind", "capability"],
  ["pi-context-view", "capability"],
]);

const ALLOWED_WORKSPACE_EDGES = new Set([
  "pi-terminal-mux -> pi-utils",
  "pi-spark -> pi-utils",
  "pi-spark -> pi-terminal-mux",
  "pi-blackhole -> pi-utils",
  "@maplezzk/pi-todo -> pi-utils",
  "pi-distill -> pi-utils",
  "pi-action-fusion -> pi-utils",
  "@maplezzk/pi-web-search -> pi-utils",
  "pi-models-discovery -> pi-utils",
  "pi-rewind -> pi-utils",
  "pi-context-view -> pi-utils",
]);

const errors = [];
const packageRecords = [];

for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const root = join(PACKAGES_DIR, entry.name);
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  packageRecords.push({ dir: entry.name, root, manifest });
}

const packageByName = new Map(packageRecords.map((record) => [record.manifest.name, record]));

for (const { dir, manifest } of packageRecords) {
  if (!PACKAGE_LAYERS.has(manifest.name)) {
    errors.push(`${dir}: package "${manifest.name}" is missing from the architecture layer map`);
  }
}

for (const packageName of PACKAGE_LAYERS.keys()) {
  if (!packageByName.has(packageName)) {
    errors.push(`architecture layer map references missing package "${packageName}"`);
  }
}

for (const record of packageRecords) {
  const { manifest, root } = record;
  const localDependencies = collectLocalDependencies(manifest, packageByName);
  for (const dependency of localDependencies) {
    const edge = `${manifest.name} -> ${dependency}`;
    if (!ALLOWED_WORKSPACE_EDGES.has(edge)) {
      errors.push(`${manifest.name}: workspace dependency is not allowed by the architecture: ${edge}`);
    }
  }

  const runtimeFiles = collectRuntimeTypeScriptFiles(root, manifest);
  for (const file of runtimeFiles) {
    const source = readFileSync(file, "utf8");
    for (const specifier of collectImportSpecifiers(source)) {
      if (packageByName.has(specifier) && !localDependencies.has(specifier)) {
        errors.push(`${displayPath(file)}: imports workspace package "${specifier}" without a runtime dependency`);
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (isWithin(target, PACKAGES_DIR) && !isWithin(target, root)) {
        errors.push(`${displayPath(file)}: imports sibling package through private path "${specifier}"`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Package boundary check failed:");
  for (const message of errors) console.error(`- ${message}`);
  process.exit(1);
}

const counts = Object.fromEntries(
  ["product", "capability", "foundation", "internal"].map((layer) => [
    layer,
    [...PACKAGE_LAYERS.values()].filter((value) => value === layer).length,
  ]),
);
console.log(
  `Package boundary check passed (${counts.product} product, ${counts.capability} capability, ${counts.foundation} foundation, ${counts.internal} internal).`,
);

function collectLocalDependencies(manifest, knownPackages) {
  const dependencies = new Set();
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (knownPackages.has(name)) dependencies.add(name);
    }
  }
  return dependencies;
}

function collectRuntimeTypeScriptFiles(packageRoot, manifest) {
  const extensionEntries = (manifest.pi?.extensions ?? [])
    .filter((entry) => typeof entry === "string" && entry.startsWith("./"))
    .map((entry) => resolve(packageRoot, entry.slice(2)))
    .filter((entry) => isWithin(entry, packageRoot));
  const candidates = [join(packageRoot, "index.ts"), join(packageRoot, "src"), join(packageRoot, "pi-extension"), ...extensionEntries];
  return [...new Set(candidates.flatMap((candidate) => collectTypeScriptFiles(candidate)))];
}

function collectTypeScriptFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) {
    return path.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(path) ? [path] : [];
  }
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ["tests", "test", "__tests__"].includes(entry.name)) continue;
    files.push(...collectTypeScriptFiles(join(path, entry.name)));
  }
  return files;
}

function collectImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function isWithin(path, parent) {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function displayPath(path) {
  return relative(ROOT, path).split(sep).join("/");
}
