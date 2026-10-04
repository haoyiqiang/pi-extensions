#!/usr/bin/env node
/**
 * check-package-config.mjs
 *
 * CI gate: validate monorepo package configuration consistency.
 *
 * Checks:
 * 1. release-please-config.json paths exist on disk
 * 2. release.yml publish jobs cover all release-please packages
 * 3. Each package has required files (package.json, index.ts, README.md, README.zh-CN.md, tsconfig.json)
 * 4. package.json has required fields (name, version, description, main, exports, files, license)
 * 5. i18n catalogs have both zh-CN and en-US for every key
 * 6. package.json "files" includes README.md and README.zh-CN.md
 * 7. The root Pi distribution profile explicitly lists every extension and theme
 * 8. Pi development dependency pins use one exact version across all workspaces
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectPublishedPackageDirectories } from "./release-publish-coverage.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

function error(msg) {
  errors.push(`❌ ${msg}`);
}

function warn(msg) {
  warnings.push(`⚠️  ${msg}`);
}

function collectTypeScriptFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 1. Load release-please-config.json
// ---------------------------------------------------------------------------
const rpConfigPath = join(ROOT, "release-please-config.json");
if (!existsSync(rpConfigPath)) {
  error("release-please-config.json not found at repo root");
} else {
  const rpConfig = JSON.parse(readFileSync(rpConfigPath, "utf8"));
  const rpPackages = Object.keys(rpConfig.packages ?? {});

  // 1a. Each path in release-please-config must exist on disk
  for (const pkgPath of rpPackages) {
    const absPath = join(ROOT, pkgPath);
    if (!existsSync(absPath)) {
      error(`release-please-config.json references "${pkgPath}" but directory does not exist`);
    }
  }

  // 1b. Every public package must be released; private workspaces must not be.
  const actualPackages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, "package.json")))
    .map((d) => {
      const path = `packages/${d.name}`;
      const manifest = JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8"));
      return { path, private: manifest.private === true };
    });

  for (const pkg of actualPackages) {
    if (pkg.private && rpPackages.includes(pkg.path)) {
      error(`Private workspace "${pkg.path}" must not appear in release-please-config.json`);
    } else if (!pkg.private && !rpPackages.includes(pkg.path)) {
      error(`Public package "${pkg.path}" is missing from release-please-config.json`);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. release.yml publish jobs cover all release-please packages
  // ---------------------------------------------------------------------------
  const releaseYmlPath = join(ROOT, ".github/workflows/release.yml");
  if (!existsSync(releaseYmlPath)) {
    error(".github/workflows/release.yml not found");
  } else {
    const releaseContent = readFileSync(releaseYmlPath, "utf8");
    const publishedDirectories = collectPublishedPackageDirectories(releaseContent);

    if (publishedDirectories.length === 0) {
      error("release.yml: no package publish working directory found");
    } else {
      for (const pkgPath of rpPackages) {
        if (!publishedDirectories.includes(pkgPath)) {
          error(`release.yml publish jobs are missing "${pkgPath}" (present in release-please-config.json)`);
        }
      }

      for (const dir of publishedDirectories) {
        if (!rpPackages.includes(dir)) {
          warn(`release.yml publish jobs include "${dir}" which is not in release-please-config.json`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3-8. Per-package checks
// ---------------------------------------------------------------------------
const packageDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, "package.json")))
  .map((d) => d.name);

const rootPackageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const rootExtensionEntries = rootPackageJson.pi?.extensions ?? [];
const rootThemeEntries = rootPackageJson.pi?.themes ?? [];
const WORKSPACE_PACKAGES_PATH = "packages";
const EXTENSION_ENTRY_FILE = "index.ts";
const PACKAGE_EXTENSION_ENTRY = `./${EXTENSION_ENTRY_FILE}`;
const expectedRootExtensionEntries = new Set();
const expectedRootThemeEntries = new Set();
for (const entry of [...rootExtensionEntries, ...rootThemeEntries]) {
  if (entry.includes("*") || entry.startsWith("!")) {
    error(`Root Pi manifest must use an explicit resource allowlist, found "${entry}"`);
  }
}
const REQUIRED_FILES = ["package.json", "index.ts", "README.md", "README.zh-CN.md", "tsconfig.json"];
const REQUIRED_PKG_FIELDS = ["name", "version", "description", "main", "exports", "files", "license"];
const PI_DEV_DEPENDENCIES = new Set([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);
const piDevPins = new Map();

for (const dir of packageDirs) {
  const pkgRoot = join(PACKAGES_DIR, dir);
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const label = pkgJson.name ?? dir;
  for (const [dependency, version] of Object.entries(pkgJson.devDependencies ?? {})) {
    if (!PI_DEV_DEPENDENCIES.has(dependency)) continue;
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      error(`${label}: devDependency "${dependency}" must use an exact version, found "${version}"`);
    }
    const users = piDevPins.get(version) ?? [];
    users.push(`${label}:${dependency}`);
    piDevPins.set(version, users);
  }

  // Private workspaces can contain extension source for tests/incubation, but
  // must never claim installable Pi resources or enter the distribution profile.
  if (pkgJson.private === true) {
    for (const kind of ["extensions", "themes", "skills", "prompts"]) {
      if (pkgJson.pi?.[kind]?.length) error(`${label}: private workspaces must not declare Pi ${kind}`);
      for (const entry of rootPackageJson.pi?.[kind] ?? []) {
        if (entry.startsWith(`${WORKSPACE_PACKAGES_PATH}/${dir}/`)) {
          error(`${label}: private workspace resource must not appear in the root Pi profile: "${entry}"`);
        }
      }
    }
  }

  // The root Git package is an explicit full-suite distribution profile.
  const exposesIndexAsExtension = pkgJson.pi?.extensions?.includes(PACKAGE_EXTENSION_ENTRY) ?? false;
  const rootExtensionEntry = `${WORKSPACE_PACKAGES_PATH}/${dir}/${EXTENSION_ENTRY_FILE}`;
  if (exposesIndexAsExtension) {
    expectedRootExtensionEntries.add(rootExtensionEntry);
    if (!rootExtensionEntries.includes(rootExtensionEntry)) {
      error(`${label}: root Pi manifest is missing extension entry "${rootExtensionEntry}"`);
    }
  } else if (rootExtensionEntries.includes(rootExtensionEntry)) {
    error(`${label}: library-only entrypoint must not be loaded by the root Pi manifest`);
  }

  for (const themeEntry of pkgJson.pi?.themes ?? []) {
    if (typeof themeEntry !== "string" || !themeEntry.startsWith("./")) continue;
    const rootThemeEntry = `${WORKSPACE_PACKAGES_PATH}/${dir}/${themeEntry.slice(2)}`;
    expectedRootThemeEntries.add(rootThemeEntry);
    if (!rootThemeEntries.includes(rootThemeEntry)) {
      error(`${label}: root Pi manifest is missing theme entry "${rootThemeEntry}"`);
    }
  }

  // 3. Required files
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(pkgRoot, file))) {
      error(`${label}: missing required file "${file}"`);
    }
  }

  // 4. Required package.json fields
  for (const field of REQUIRED_PKG_FIELDS) {
    if (pkgJson[field] === undefined || pkgJson[field] === null || pkgJson[field] === "") {
      error(`${label}: package.json missing required field "${field}"`);
    }
  }

  // Runtime imports must be installed with the package. Pi's extension
  // installer does not guarantee that peerDependencies are available to a
  // package's source files.
  const runtimeSourceFiles = [
    join(pkgRoot, "index.ts"),
    join(pkgRoot, "src"),
    join(pkgRoot, "pi-extension"),
  ].flatMap((path) => (path.endsWith(".ts") ? (existsSync(path) ? [path] : []) : collectTypeScriptFiles(path)));
  const importsI18n = runtimeSourceFiles.some((path) =>
    /(?:from|import\s*\()\s*["']pi-extensions-i18n["']/.test(readFileSync(path, "utf8")),
  );
  if (importsI18n && !pkgJson.dependencies?.["pi-extensions-i18n"]) {
    error(`${label}: runtime imports pi-extensions-i18n, but it is not declared in dependencies`);
  }
  if (
    importsI18n &&
    Array.isArray(pkgJson.pi?.extensions) &&
    !pkgJson.pi.extensions.includes("../pi-extensions-i18n/index.ts")
  ) {
    error(`${label}: runtime imports pi-extensions-i18n, but its Pi extension entry is not loaded`);
  }

  // 5. files field should include READMEs
  if (Array.isArray(pkgJson.files)) {
    if (!pkgJson.files.includes("README.md")) {
      warn(`${label}: package.json "files" does not include README.md`);
    }
    if (!pkgJson.files.includes("README.zh-CN.md")) {
      warn(`${label}: package.json "files" does not include README.zh-CN.md`);
    }
  }

  // 6. i18n catalog consistency. Repository packages use one flat string map
  // per locale; the public compatibility loader still supports legacy callers.
  const localesDir = join(pkgRoot, "locales");
  if (existsSync(localesDir)) {
    const catalogFiles = readdirSync(localesDir).filter((file) => file.endsWith(".json")).sort();
    const expectedFiles = ["en-US.json", "zh-CN.json"];
    if (JSON.stringify(catalogFiles) !== JSON.stringify(expectedFiles)) {
      error(`${label}: locales must contain exactly en-US.json and zh-CN.json`);
    }
    const catalogs = new Map();
    for (const catalogFile of catalogFiles) {
      const catalog = JSON.parse(readFileSync(join(localesDir, catalogFile), "utf8"));
      if (Object.values(catalog).some((value) => typeof value !== "string")) {
        error(`${label}: locales/${catalogFile} must be a flat string map`);
        continue;
      }
      catalogs.set(catalogFile.replace(/\.json$/, ""), catalog);
    }
    const english = catalogs.get("en-US");
    const chinese = catalogs.get("zh-CN");
    if (english && chinese) {
      const englishKeys = Object.keys(english).sort();
      const chineseKeys = Object.keys(chinese).sort();
      if (JSON.stringify(englishKeys) !== JSON.stringify(chineseKeys)) {
        error(`${label}: locales/en-US.json and locales/zh-CN.json must contain the same keys`);
      }
    }
  }
}

for (const entry of rootExtensionEntries) {
  if (!expectedRootExtensionEntries.has(entry)) {
    error(`Root Pi manifest references unknown or non-extension entry "${entry}"`);
  }
}
for (const entry of rootThemeEntries) {
  if (!expectedRootThemeEntries.has(entry)) {
    error(`Root Pi manifest references unknown theme entry "${entry}"`);
  }
}

if (piDevPins.size > 1) {
  const details = [...piDevPins.entries()]
    .map(([version, users]) => `${version} (${users.join(", ")})`)
    .join("; ");
  error(`Pi development dependencies must use one version across all workspaces: ${details}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (warnings.length > 0) {
  console.log("\n--- Warnings ---");
  for (const w of warnings) console.log(w);
}

if (errors.length > 0) {
  console.log("\n--- Errors ---");
  for (const e of errors) console.log(e);
  console.log(`\n💥 ${errors.length} error(s) found. Fix them before merging.`);
  process.exit(1);
} else {
  console.log(`✅ Package config check passed (${packageDirs.length} packages, ${warnings.length} warning(s)).`);
}
