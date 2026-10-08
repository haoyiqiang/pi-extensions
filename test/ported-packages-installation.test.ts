import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const packages = ["pi-advisor", "pi-todo", "pi-ask-user-question"];
const repoRoot = resolve(import.meta.dirname, "..");

for (const layout of ["hoisted", "nested"] as const) {
  test(`ported scoped packages resolve their i18n entry in a ${layout} npm layout`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-ported-install-"));
    try {
      const agentDir = join(cwd, "agent");
      const settingsManager = SettingsManager.inMemory({});
      const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
      for (const slug of packages) {
        const source = join(repoRoot, "packages", slug);
        const packageRoot = join(cwd, "node_modules", "@maplezzk", slug);
        mkdirSync(packageRoot, { recursive: true });
        for (const file of ["package.json", "index.ts", "i18n-entry.ts"]) {
          writeFileSync(join(packageRoot, file), readFileSync(join(source, file)));
        }
        const dependencyRoot = layout === "hoisted"
          ? join(cwd, "node_modules", "pi-extensions-i18n")
          : join(packageRoot, "node_modules", "pi-extensions-i18n");
        mkdirSync(dependencyRoot, { recursive: true });
        writeFileSync(join(dependencyRoot, "package.json"), readFileSync(join(repoRoot, "packages", "pi-extensions-i18n", "package.json")));
        writeFileSync(join(dependencyRoot, "index.ts"), "export default function () {}\n");
        const resources = await manager.resolveExtensionSources([packageRoot]);
        const entries = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
        assert.deepEqual(entries, [join(packageRoot, "i18n-entry.ts"), join(packageRoot, "index.ts")]);
        const dependencyEntry = createRequire(join(packageRoot, "i18n-entry.ts")).resolve("pi-extensions-i18n");
        assert.equal(dirname(dependencyEntry), realpathSync(dependencyRoot));
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
