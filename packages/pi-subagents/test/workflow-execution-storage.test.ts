import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import { createWorkflowExecutionProvider } from "../src/workflow/execution-provider.js";
import { executionFixture } from "./helpers/workflow-execution.js";

describe("workflow storage isolation from a raw-session orphan sweep", () => {
  it.each(["parent-alias", "dangling-alias", "file"] as const)("rejects a managed directory that is a %s before constructing the backend", async kind => {
    const f = executionFixture();
    try {
      rmSync(f.sessionDir, { recursive: true });
      if (kind === "file") writeFileSync(f.sessionDir, "not a directory");
      else symlinkSync(kind === "parent-alias" ? dirname(f.sessionDir) : join(f.root, "missing"), f.sessionDir, "junction");
      const createBackend = vi.fn(() => f.backend);
      const getContext = vi.fn(() => f.ctx);
      const provider = createWorkflowExecutionProvider({ pi: f.pi, getContext, createBackend, inspectSession: f.backend.inspect });
      expect(() => provider.createHost(f.observer, { runId: "run", childSessionsDir: dirname(f.sessionDir) }))
        .toThrow(i18n.t("workflowExecution.invalidStorage"));
      expect(getContext).not.toHaveBeenCalled();
      expect(createBackend).not.toHaveBeenCalled();
      expect(f.backend.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("leaves creation of a missing real managed directory to the backend", async () => {
    const f = executionFixture();
    try {
      rmSync(f.sessionDir, { recursive: true });
      const provider = createWorkflowExecutionProvider({ pi: f.pi, getContext: () => f.ctx,
        createBackend: () => f.backend, inspectSession: f.backend.inspect });
      const execution = provider.createHost(f.observer, { runId: "run", childSessionsDir: dirname(f.sessionDir) });
      try {
        await execution.host.spawnChild({ prompt: "plain task", withSession: async child => {
          expect(dirname(child.reference.sessionFile)).toBe(f.sessionDir);
        } });
      } finally { await execution.close(); }
    } finally { await f.close(); }
  });
});
