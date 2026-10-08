import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "pi-advisor-tests-"));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.PI_EXTENSIONS_LOCALE = "en-US";
for (const key of Object.keys(process.env)) {
  if (key.endsWith("_API_KEY") || key.endsWith("_TOKEN")) delete process.env[key];
}

vi.stubGlobal("fetch", vi.fn(async () => {
  throw new Error("network access is disabled in pi-advisor tests");
}));

beforeEach(() => {
  rmSync(join(root, "agent"), { recursive: true, force: true });
  rmSync(join(root, "xdg"), { recursive: true, force: true });
  rmSync(join(root, ".config"), { recursive: true, force: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "xdg"), { recursive: true });
});
