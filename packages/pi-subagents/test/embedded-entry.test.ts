import { describe, expect, it } from "vitest";
import * as runner from "../src/agent-runner.js";
import * as embedded from "../src/backends/embedded.js";
import { steerEmbeddedSession } from "../src/backends/embedded-lifecycle.js";

describe("upstream runner compatibility entrypoint", () => {
  it("re-exports the backend implementation rather than a second execution engine", () => {
    expect(Object.keys(runner).sort()).toEqual(Object.keys(embedded).sort());
    expect(runner.runAgent).toBe(embedded.runAgent);
    expect(runner.resumeAgent).toBe(embedded.resumeAgent);
    expect(runner.steerAgent).toBe(steerEmbeddedSession);
    expect(runner.getAgentConversation).toBe(embedded.getAgentConversation);
  });

  it("keeps runner configuration in the same module instance", () => {
    const before = embedded.getDefaultMaxTurns();
    try {
      runner.setDefaultMaxTurns(7);
      expect(embedded.getDefaultMaxTurns()).toBe(7);
      embedded.setDefaultMaxTurns(11);
      expect(runner.getDefaultMaxTurns()).toBe(11);
    } finally {
      runner.setDefaultMaxTurns(before);
    }
  });
});
