import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLocale } from "pi-extensions-i18n";
import { afterAll, beforeEach } from "vitest";

// Existing upstream assertions pin the original English text byte-for-byte.
applyLocale("en-US");

// Set these before dynamically importing runtime modules: no real HOME reads.
const testHome = mkdtempSync(join(tmpdir(), "pi-workflow-test-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.PI_CODING_AGENT_DIR = join(testHome, ".pi", "agent");
delete process.env.XDG_CONFIG_HOME;

// Only workflow resets from upstream test/setup.ts; no sibling RPIV runtime.
beforeEach(async () => {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.PI_CODING_AGENT_DIR = join(testHome, ".pi", "agent");
  delete process.env.XDG_CONFIG_HOME;
  const workflow = await import("../src/internal.ts");
  workflow.__resetBuiltIns();
  workflow.__resetLoadCache();
  workflow.__resetLifecycleRegistry();
  workflow.__resetSkillContracts();
  workflow.__resetStrikeBudgets();
  workflow.__resetWorkflowExecutionHost();
  rmSync(join(testHome, ".config", "rpiv-workflow"), { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
