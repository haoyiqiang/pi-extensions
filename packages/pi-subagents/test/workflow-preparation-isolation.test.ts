import { expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { WorkflowPromptResource } from "../src/workflow/prompt-preparation.js";
import { ConsumerCancellation, executionFixture } from "./helpers/workflow-execution.js";

it("snapshots reusable synchronous preparation data before a sibling can mutate it", async () => {
  const f = executionFixture();
  const reused = { text: "", requiredTools: ["read"], resources: [{
    kind: "skill", name: "first", filePath: f.sessionDir, baseDir: f.root, sha256: "a".repeat(64), format: "pi",
  } as WorkflowPromptResource] };
  const host = f.host({ maxConcurrency: 2, preparePrompt(input) {
    reused.text = input;
    reused.requiredTools[0] = input === "FIRST" ? "read" : "bash";
    reused.resources[0] = { ...reused.resources[0], name: input.toLowerCase() };
    return reused;
  } });
  try {
    const results = await Promise.all(["FIRST", "SECOND"].map(input => host.spawnChild({ prompt: input,
      withSession: async child => child.preparation,
    })));
    expect(f.backend.run.mock.calls.map(call => call[2])).toEqual(["FIRST", "SECOND"]);
    expect(f.backend.run.mock.calls.map(call => call[3].requiredTools)).toEqual([["read"], ["bash"]]);
    expect(results.map(value => value?.text)).toEqual(["FIRST", "SECOND"]);
    expect(results.map(value => value?.resources?.[0].name)).toEqual(["first", "second"]);
    expect(results[0]).not.toBe(results[1]);
  } finally { await f.close(); }
});

it.each(["fresh", "resume"] as const)("rechecks cancellation after synchronous preparation yields (%s)", async phase => {
  const f = executionFixture();
  const controller = new AbortController();
  const host = f.host({ signal: controller.signal, preparePrompt(input) {
    if (input === "cancel-before-dispatch") queueMicrotask(() => controller.abort());
    return { text: input };
  } });
  const spawn = vi.spyOn(AgentManager.prototype, "spawn");
  const resume = vi.spyOn(AgentManager.prototype, "resume");
  try {
    const task = host.spawnChild({ prompt: phase === "fresh" ? "cancel-before-dispatch" : "initial",
      withSession: async child => {
        spawn.mockClear();
        await child.sendUserMessage("cancel-before-dispatch");
      },
    });
    await expect(task).rejects.toBeInstanceOf(ConsumerCancellation);
    expect(spawn).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(f.backend.resume).not.toHaveBeenCalled();
    if (phase === "fresh") expect(f.backend.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
    spawn.mockRestore();
    resume.mockRestore();
  }
});
