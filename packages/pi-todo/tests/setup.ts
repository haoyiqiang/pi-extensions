import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-todo-test-home-"));
const AGENT_DIR = join(TEST_HOME, ".pi", "agent");
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");
process.env.PI_EXTENSIONS_LOCALE = "en-US";

beforeEach(async () => {
  rmSync(join(AGENT_DIR, "extensions", "pi-todo"), { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".config", "rpiv-todo"), { recursive: true, force: true });
  const todo = await import("../todo.js");
  todo.__resetState();
});
