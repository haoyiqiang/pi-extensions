#!/usr/bin/env node
// Pack and install into independent npm consumers. No workspace links, loader
// aliases, personal extension paths, paid models or (by default) user terminals.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-install-")));
const fixture = join(repo, "packages/pi-interactive-subagents/test");
const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "config"), npm_config_cache: join(tmpdir(), "pi-subagents-install-cache") };
// The exact same semantic workflow can deliberately opt in to real terminals.
if (!process.argv.includes("--real")) delete env.PI_SUBAGENT_SMOKE_BACKEND;
else assert.ok(["tmux", "orca"].includes(env.PI_SUBAGENT_SMOKE_BACKEND), "--real requires PI_SUBAGENT_SMOKE_BACKEND=tmux|orca inside a disposable terminal");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: "inherit", timeout: 300_000 });
try {
  mkdirSync(join(root, "tarballs"));
  const packs = [];
  for (const directory of [".", "packages/pi-interactive-subagents", "packages/pi-terminal-mux", "packages/pi-utils", "packages/pi-web-search"]) {
    const report = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", join(root, "tarballs")], { cwd: join(repo, directory), env, encoding: "utf8" }));
    const item = Array.isArray(report) ? report[0] : Object.values(report)[0];
    if (directory === "." || directory.endsWith("pi-interactive-subagents")) {
      const prefix = directory === "." ? "packages/pi-interactive-subagents/" : "";
      const files = new Set(item.files.map((file) => file.path));
      for (const file of ["package.json", "README.md", "README.zh-CN.md", "LICENSE", "agents/scout.md", "agents/worker.md", "agents/researcher.md", "pi-extension/subagents/index.ts", "pi-extension/subagents/subagent-done.ts", "pi-extension/subagents/writer.mjs", "pi-extension/subagents/tools/safe-bash.ts", "pi-extension/subagents/plugin/.claude-plugin/plugin.json", "pi-extension/subagents/plugin/hooks/on-stop.sh"]) {
        assert.ok(files.has(prefix + file), `${directory}: packed consumer needs ${prefix + file}`);
      }
      assert.equal([...files].some((file) => /(^|\/)(tests?|node_modules)\//.test(file)), false, "do not distribute fixture/test source");
    }
    packs.push(join(root, "tarballs", item.filename));
  }
  for (const [index, installation] of ["root", "package"].entries()) {
    // Separate physical dependency trees: the standalone controller cannot borrow
    // undeclared dependencies from an installed root distribution (or vice versa).
    const consumer = join(root, installation);
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--package-lock=false", packs[index], ...packs.slice(2),
      "@earendil-works/pi-coding-agent@0.87.1", "@earendil-works/pi-ai@0.87.1", "@earendil-works/pi-agent-core@0.87.1", "@earendil-works/pi-tui@0.87.1", "tsx@4.23.1", "typebox@1.3.27"], consumer);
    for (const name of [index === 0 ? "pi-extensions" : "pi-interactive-subagents", "@kevinhao/pi-terminal-mux", "@kevinhao/pi-web-search"]) {
      const path = join(consumer, "node_modules", name);
      assert.equal(realpathSync(path), path, `${name} must be installed, not linked to a workspace`);
      assert.ok(existsSync(join(path, "package.json")));
    }
    mkdirSync(join(consumer, "fixtures"));
    copyFileSync(join(fixture, "fixtures/pi-runtime.ts"), join(consumer, "fixtures/pi-runtime.ts"));
    for (const file of ["install-workflow.ts", "terminal.mjs"]) copyFileSync(join(fixture, "fixtures", file), join(consumer, file));
    copyFileSync(join(fixture, "harness.ts"), join(consumer, "harness.ts"));
    run(process.execPath, ["--import", "tsx", join(consumer, "install-workflow.ts"), installation], consumer);
  }
  console.log("Independent packed subagent installations passed (supported Pi 0.87.1; no paid provider calls).");
} catch (error) {
  console.error(`Installation smoke failed in ${root}: ${error.message}`);
  if (process.env.PI_SUBAGENT_KEEP_INSTALL !== "1") console.error("Set PI_SUBAGENT_KEEP_INSTALL=1 to retain these temporary consumers for diagnosis.");
  throw error;
} finally {
  if (process.env.PI_SUBAGENT_KEEP_INSTALL !== "1") rmSync(root, { recursive: true, force: true });
  else console.log(`Retained temporary consumers: ${root}`);
}
