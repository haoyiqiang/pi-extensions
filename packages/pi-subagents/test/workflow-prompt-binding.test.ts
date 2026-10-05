import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptBinding } from "../src/backends/prompt-binding.js";
import { prepareManagedPolicy } from "../src/backends/managed-policy.js";
import { i18n } from "../src/i18n.js";
import type { ManagedWorkflowExecution } from "../src/workflow/execution-contract.js";
import { createWorkflowExecutionProvider } from "../src/workflow/execution-provider.js";
import { createWorkflowSkillPreparer } from "../src/workflow/skill-resources.js";
import { executionFixture } from "./helpers/workflow-execution.js";

const binding = (): PromptBinding => ({ resolverId: "fixture/skills@1", resourceSetDigest: "a".repeat(64), assetMode: "live" });
const fixtures: ReturnType<typeof executionFixture>[] = [];
const executions: ManagedWorkflowExecution[] = [];
function fixture() { const f = executionFixture(); fixtures.push(f); return f; }
afterEach(async () => {
  await Promise.all(executions.splice(0).map(execution => execution.close()));
  await Promise.all(fixtures.splice(0).map(f => f.close()));
  vi.restoreAllMocks();
});

describe("explicit factory-bound workflow prompt identity", () => {
  it("captures fresh policy binding before asynchronous environment preparation and rejects invalid data before exec", async () => {
    const f = fixture();
    const mutable = { ...binding() };
    const preparing = prepareManagedPolicy(f.ctx, "general-purpose", { pi: f.pi, isolated: true, promptBinding: mutable });
    mutable.resolverId = "mutated-during-environment-preparation";
    const policy = await preparing;
    expect(policy.promptBinding).toEqual(binding());
    expect(Object.isFrozen(policy.promptBinding)).toBe(true);
    vi.mocked(f.pi.exec).mockClear();
    await expect(prepareManagedPolicy(f.ctx, "general-purpose", { pi: f.pi, isolated: true,
      promptBinding: { ...binding(), resourceSetDigest: "invalid" } })).rejects.toThrow(i18n.t("promptBinding.invalid"));
    expect(f.pi.exec).not.toHaveBeenCalled();
  });

  it("snapshots host binding and forwards it through manager fresh dispatch without inferring preparation", async () => {
    const f = fixture();
    const mutable = { ...binding() };
    const options = { promptBinding: mutable };
    const host = f.host(options);
    mutable.resolverId = "changed-after-construction";
    options.promptBinding = { ...binding(), resourceSetDigest: "b".repeat(64) };
    expect(host.promptBinding).toEqual(binding());
    expect(Object.isFrozen(host.promptBinding)).toBe(true);
    // A binding describes owner identity, not an implicit resource loader.
    expect(host.capabilities.promptPreparation).toBe(false);
    await host.spawnChild({ prompt: "fresh text", withSession: async () => {} });
    const dispatched = f.backend.run.mock.calls[0][3];
    expect(dispatched.promptBinding).toEqual(binding());
    expect(Object.isFrozen(dispatched.promptBinding)).toBe(true);
  });

  it("captures provider binding before any host is created and passes the same expectation to each host", async () => {
    const f = fixture();
    const mutable = { ...binding() };
    const options = { pi: f.pi, getContext: () => f.ctx, createBackend: () => f.backend,
      inspectSession: f.backend.inspect, promptBinding: mutable };
    const provider = createWorkflowExecutionProvider(options);
    mutable.resolverId = "changed-after-factory";
    options.promptBinding = { ...binding(), resourceSetDigest: "c".repeat(64) };
    for (const runId of ["one", "two"]) {
      const execution = provider.createHost(f.observer, { runId, childSessionsDir: dirname(f.sessionDir) });
      executions.push(execution);
      expect(execution.host.promptBinding).toEqual(binding());
      await execution.host.spawnChild({ prompt: runId, withSession: async () => {} });
    }
    expect(f.backend.run.mock.calls.map(call => call[3].promptBinding)).toEqual([binding(), binding()]);
  });

  it("does not infer a binding even when the callable preparer publishes one", async () => {
    const f = fixture();
    const preparePrompt = createWorkflowSkillPreparer([]);
    const host = f.host({ preparePrompt });
    expect(preparePrompt.promptBinding).toBeDefined();
    expect(host.promptBinding).toBeUndefined();
    await host.spawnChild({ prompt: "plain", withSession: async () => {} });
    expect(f.backend.run.mock.calls[0][3].promptBinding).toBeUndefined();
    const source = f.seed();
    await host.spawnChild({ reattach: { sessionFile: source.reference.sessionFile }, prompt: "ignored", withSession: async () => {} });
    expect(f.backend.reattach.mock.calls[0][1]?.promptBinding).toBeUndefined();
  });

  it.each(["reattach", "fork"] as const)("forwards matched %s expectations without preparing or replaying the ignored prompt", async mode => {
    const f = fixture();
    const source = f.seed({ policy: { promptBinding: binding() } });
    const preparePrompt = vi.fn((text: string) => ({ text }));
    const host = f.host({ promptBinding: binding(), preparePrompt });
    await host.spawnChild({ [mode]: { sessionFile: source.reference.sessionFile }, prompt: "/must-not-prepare",
      withSession: async child => {
        expect(child.preparation).toBeUndefined();
        expect(preparePrompt).not.toHaveBeenCalled();
        expect(f.backend.resume).not.toHaveBeenCalled();
        await child.sendUserMessage("continue explicitly");
      } });
    const restored = f.backend[mode].mock.calls[0][1];
    expect(restored?.promptBinding).toEqual(binding());
    expect(Object.isFrozen(restored?.promptBinding)).toBe(true);
    expect(preparePrompt).toHaveBeenCalledOnce();
    expect(f.backend.resume).toHaveBeenCalledOnce();
  });

  it.each(["reattach", "fork"] as const)("rejects missing/different %s identity during inspection before restoration, callback or preparation", async mode => {
    for (const [actual, expected] of [[binding(), undefined], [undefined, binding()],
      [binding(), { ...binding(), resolverId: "fixture/skills@2" }],
      [binding(), { ...binding(), resourceSetDigest: "b".repeat(64) }]]) {
      const f = fixture();
      const source = f.seed({ policy: { promptBinding: actual } });
      const before = structuredClone(source);
      const preparePrompt = vi.fn((text: string) => ({ text }));
      const host = f.host({ promptBinding: expected, preparePrompt });
      const callback = vi.fn();
      await expect(host.spawnChild({ [mode]: { sessionFile: source.reference.sessionFile }, prompt: "/ignored", withSession: callback }))
        .rejects.toThrow(i18n.t("promptBinding.mismatch"));
      expect(f.backend.reattach).not.toHaveBeenCalled();
      expect(f.backend.fork).not.toHaveBeenCalled();
      expect(f.backend.run).not.toHaveBeenCalled();
      expect(f.backend.resume).not.toHaveBeenCalled();
      expect(f.backend.shutdown).not.toHaveBeenCalled();
      expect(preparePrompt).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(source).toEqual(before);
    }
  });

  it("validates acquired destination identity too, without preparing or sending into a mismatched fork", async () => {
    const f = fixture();
    const source = f.seed({ policy: { promptBinding: binding() } });
    f.backend.fork.mockImplementationOnce(async () => f.handle(f.seed()));
    const preparePrompt = vi.fn((text: string) => ({ text }));
    const host = f.host({ promptBinding: binding(), preparePrompt });
    const callback = vi.fn();
    await expect(host.spawnChild({ fork: { sessionFile: source.reference.sessionFile }, prompt: "/ignored", withSession: callback }))
      .rejects.toThrow(i18n.t("promptBinding.mismatch"));
    expect(f.backend.fork).toHaveBeenCalledOnce();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("retains the existing canonical cwd guard for matched bindings", async () => {
    const f = fixture();
    const source = f.seed({ policy: { promptBinding: binding(), cwd: f.sessionDir } });
    const host = f.host({ promptBinding: binding() });
    await expect(host.spawnChild({ reattach: { sessionFile: source.reference.sessionFile }, prompt: "ignored", withSession: async () => {} }))
      .rejects.toThrow(i18n.t("workflowExecution.cwdMismatch"));
    expect(f.backend.reattach).not.toHaveBeenCalled();
  });

  it("rejects invalid factory binding before constructing contexts, backends or manager timers", () => {
    const f = fixture();
    const getContext = vi.fn(() => f.ctx);
    const createBackend = vi.fn(() => f.backend);
    const invalid = { ...binding(), assetMode: "bundle" } as unknown as PromptBinding;
    expect(() => createWorkflowExecutionProvider({ pi: f.pi, getContext, createBackend, inspectSession: f.backend.inspect,
      promptBinding: invalid })).toThrow(i18n.t("promptBinding.invalid"));
    expect(getContext).not.toHaveBeenCalled();
    expect(createBackend).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const count = vi.getTimerCount();
      expect(() => f.host({ promptBinding: invalid })).toThrow(i18n.t("promptBinding.invalid"));
      expect(vi.getTimerCount()).toBe(count);
    } finally { vi.useRealTimers(); }
  });
});
