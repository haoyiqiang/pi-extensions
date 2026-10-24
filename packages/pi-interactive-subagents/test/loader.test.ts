import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("root distribution loads one native subagent controller and no standalone CLI controller", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-root-loader-"));
  try {
    const loaded = await discoverAndLoadExtensions([resolve(import.meta.dirname, "../../..")], root, join(root, "agent"));
    assert.deepEqual(loaded.errors, []);
    const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
    for (const name of ["subagent", "subagent_message", "subagents_list", "subagent_status", "subagent_stop"]) {
      assert.equal(tools.filter((tool) => tool === name).length, 1, `${name} has exactly one default owner`);
    }
    assert.equal(loaded.extensions.some((extension) => extension.path.includes("pi-subagent/index.ts")), false,
      "the independent CLI controller is opt-in, not a competing default lifecycle");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Use Pi's normal directory/manifest loading, not custom aliases or an author's
// extension installation. Direct imports in the other tests independently verify
// that the source does not require the loader's legacy compatibility aliases.
test("supported Pi loads the package manifest and child control extensions", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-loader-"));
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const loaded = await discoverAndLoadExtensions([
      packageDir,
      join(packageDir, "pi-extension/subagents/subagent-done.ts"),
      join(packageDir, "pi-extension/subagents/tools/safe-bash.ts"),
    ], root, process.env.PI_CODING_AGENT_DIR);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 3);
    const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.deepEqual(tools.sort(), ["ask_question", "safe_bash", "subagent", "subagent_message", "subagent_status", "subagent_stop", "subagents_list"]);
    assert.ok(loaded.extensions[0].commands.has("subagent"));
    assert.ok(loaded.extensions[0].messageRenderers.has("subagent_result"));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
