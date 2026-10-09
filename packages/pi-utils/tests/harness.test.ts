import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRegistrationHarness, withTempAgentDir } from "../index.ts";

test("registration harness records owners and rejects collisions", async () => {
  const harness = createExtensionRegistrationHarness();
  await harness.load("first", (pi) => {
    pi.registerCommand("example", { description: "first" });
    pi.registerTool({ name: "tool-a" });
    pi.on("session_start", () => undefined);
  });

  assert.equal(harness.commands.get("example")?.owner, "first");
  assert.equal(harness.tools.get("tool-a")?.owner, "first");
  assert.equal(harness.events[0]?.owner, "first");

  await assert.rejects(
    harness.load("second", (pi) => pi.registerCommand("example", {})),
    /attempted to replace first's registration/,
  );
});

test("temporary agent directory restores the previous environment", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  await withTempAgentDir(async (agentDir) => {
    assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
});
