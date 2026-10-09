import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const root = mkdtempSync(join(tmpdir(), "pi-ask-user-question-tests-"));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.PI_EXTENSIONS_LOCALE = "en-US";

beforeEach(() => {
  rmSync(join(process.env.PI_CODING_AGENT_DIR!, "extensions", "pi-ask-user-question"), { recursive: true, force: true });
  rmSync(join(process.env.XDG_CONFIG_HOME!, "rpiv-ask-user-question"), { recursive: true, force: true });
  rmSync(join(process.env.HOME!, ".config", "rpiv-ask-user-question"), { recursive: true, force: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
