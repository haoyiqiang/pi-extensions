import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Set before Pi modules load: tests must never discover the developer's agents,
// credentials, or extensions. Individual fixtures may temporarily override these.
const originalCwd = process.cwd();
const home = mkdtempSync(join(tmpdir(), "pi-subagents-test-home-"));
const project = join(home, "project");
const overrides: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("GIT_")).map((key) => [key, undefined])),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
  PI_E2E_LIVE: "0",
};
const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(overrides)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
mkdirSync(project);
// A disposable repo preserves upstream's git-project tests without exposing the checkout.
execFileSync("git", ["init", "--quiet", project], { stdio: "pipe" });
process.chdir(project);

afterAll(() => {
  process.chdir(originalCwd);
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
