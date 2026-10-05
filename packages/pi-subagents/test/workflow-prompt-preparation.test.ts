import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import type { ManagedWorkflowExecution, ManagedWorkflowSessionContext } from "../src/workflow/execution-contract.js";
import { createWorkflowExecutionProvider, type WorkflowExecutionProviderOptions } from "../src/workflow/execution-provider.js";
import {
  MAX_PREPARED_PROMPT_BYTES, snapshotPreparedPrompt, type PreparedWorkflowPrompt,
  type WorkflowPromptPreparer, type WorkflowPromptResource,
} from "../src/workflow/prompt-preparation.js";
import { createWorkflowSkillPreparer } from "../src/workflow/skill-resources.js";
import { ConsumerCancellation, deferred, executionFixture, flush } from "./helpers/workflow-execution.js";

const fixtures: ReturnType<typeof executionFixture>[] = [];
const executions: ManagedWorkflowExecution[] = [];
function fixture() {
  const f = executionFixture();
  fixtures.push(f);
  return f;
}
const diagnostic = (key: string) => i18n.t(`workflowExecution.${key}`);
function resource(root: string): WorkflowPromptResource {
  return { kind: "skill", name: "approved", filePath: join(root, "SKILL.md"), baseDir: root,
    sha256: "a".repeat(64), format: "pi" };
}

afterEach(async () => {
  executions.forEach(execution => execution.dispose());
  await Promise.all(fixtures.splice(0).map(f => f.close()));
  await Promise.all(executions.splice(0).map(execution => execution.close()));
  vi.restoreAllMocks();
});

describe("prepared workflow prompt snapshots", () => {
  it("detaches and freezes exact tool names and resource provenance, without freezing caller objects", () => {
    const f = fixture();
    const source = { text: "  expanded text mentioning /skill:approved\n", requiredTools: ["read", "Read", "mcp__service__lookup"],
      resources: [{ ...resource(f.root), callerMetadata: { mutable: true } }], receipt: "not a receipt" };
    const snapshot = snapshotPreparedPrompt(source);
    expect(snapshot).toEqual({ text: source.text, requiredTools: source.requiredTools, resources: [resource(f.root)] });
    expect(snapshot).not.toHaveProperty("receipt");
    expect(snapshot.resources![0]).not.toHaveProperty("callerMetadata");
    for (const value of [snapshot, snapshot.requiredTools, snapshot.resources, snapshot.resources![0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.requiredTools)).toBe(false);
    source.text = "changed";
    source.requiredTools.push("write");
    source.resources[0].name = "changed";
    source.resources.splice(0);
    expect(snapshot.text).toBe("  expanded text mentioning /skill:approved\n");
    expect(snapshot.requiredTools).toEqual(["read", "Read", "mcp__service__lookup"]);
    expect(snapshot.resources).toEqual([resource(f.root)]);
    expect(Reflect.set(snapshot, "text", "replacement")).toBe(false);
    expect(Reflect.set(snapshot.requiredTools!, "0", "write")).toBe(false);
    expect(Reflect.set(snapshot.resources![0], "sha256", "b".repeat(64))).toBe(false);
  });

  it("bounds UTF-8 bytes rather than characters, accepting exactly 512 KiB", () => {
    expect(MAX_PREPARED_PROMPT_BYTES).toBe(512 * 1024);
    const text = "é".repeat(MAX_PREPARED_PROMPT_BYTES / 2);
    expect(Buffer.byteLength(text)).toBe(MAX_PREPARED_PROMPT_BYTES);
    expect(snapshotPreparedPrompt({ text }).text).toBe(text);
    expect(() => snapshotPreparedPrompt({ text: `${text}x` })).toThrow();
  });

  const invalid: Array<[string, (root: string) => unknown]> = [
    ["undefined", () => undefined], ["null", () => null], ["string", () => "plain"],
    ["array", () => [{ text: "plain" }]], ["missing text", () => ({ requiredTools: [] })],
    ["nontext", () => ({ text: 42 })], ["empty text", () => ({ text: " \n\t" })],
    ["unexpanded skill", () => ({ text: " \n/skill:approved arg" })],
    ["unexpanded command", () => ({ text: "/template arg" })],
    ["oversized UTF-8", () => ({ text: "界".repeat(Math.floor(MAX_PREPARED_PROMPT_BYTES / 3) + 1) })],
    ["nonarray tools", () => ({ text: "plain", requiredTools: "read" })],
    ["tool selector", () => ({ text: "plain", requiredTools: ["read*"] })],
    ["nonexact tool", () => ({ text: "plain", requiredTools: [" read"] })],
    ["nonarray resources", () => ({ text: "plain", resources: {} })],
    ["relative resource path", root => ({ text: "plain", resources: [{ ...resource(root), filePath: "SKILL.md" }] })],
    ["invalid provenance hash", root => ({ text: "plain", resources: [{ ...resource(root), sha256: "unverified" }] })],
    ["invalid resource kind", root => ({ text: "plain", resources: [{ ...resource(root), kind: "extension" }] })],
  ];
  it.each(invalid)("rejects %s before any fresh backend dispatch", async (_name, value) => {
    const f = fixture();
    const output = value(f.root) as PreparedWorkflowPrompt;
    expect(() => snapshotPreparedPrompt(output)).toThrow();
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(() => output);
    const callback = vi.fn();
    await expect(f.host({ preparePrompt }).spawnChild({ prompt: "/skill:approved", withSession: callback })).rejects.toThrow();
    expect(preparePrompt).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.reattach).not.toHaveBeenCalled();
    expect(f.backend.inspect).not.toHaveBeenCalled();
    expect(f.pi.exec).not.toHaveBeenCalled();
  });
});

describe("explicit workflow prompt preparation", () => {
  it("leaves the default plain-only profile unchanged and refuses slash commands before dispatch", async () => {
    const f = fixture();
    const host = f.host();
    expect(host.capabilities).toMatchObject({ plainPromptsOnly: true, promptPreparation: false });
    expect(Object.isFrozen(host.capabilities)).toBe(true);
    for (const prompt of ["/skill:approved args", " \n/template", "/unknown"]) {
      await expect(host.spawnChild({ prompt, withSession: async () => {} })).rejects.toThrow(diagnostic("commandUnsupported"));
    }
    expect(f.backend.run).not.toHaveBeenCalled();
    await host.spawnChild({ prompt: "Plain text mentioning /skill:approved", withSession: async child => {
      await expect(child.sendUserMessage("/skill:approved args")).rejects.toThrow(diagnostic("commandUnsupported"));
    } });
    expect(f.backend.resume).not.toHaveBeenCalled();
  });

  it("prepares once per fresh/send with immutable context and snapshots before backend work yields", async () => {
    const f = fixture();
    const outputs = [
      { text: "expanded initial", requiredTools: ["read"], resources: [resource(f.root)] },
      { text: "expanded continuation", requiredTools: ["read", "bash"], resources: [resource(f.root)] },
    ];
    const expected = structuredClone(outputs);
    const preparePrompt = vi.fn<WorkflowPromptPreparer>()
      .mockImplementationOnce((_input, context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.cwd).toBe(f.root);
        expect(context.session).toBeUndefined();
        expect(Reflect.set(context, "cwd", join(f.root, "retargeted"))).toBe(false);
        return outputs[0];
      })
      .mockImplementationOnce((_input, context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.session)).toBe(true);
        expect(context.session).toEqual(f.handles[0].reference);
        expect(context.session).not.toBe(f.handles[0].reference);
        expect(context.session!.sessionId).not.toBe(f.backend.run.mock.calls[0][3].agentId);
        expect(context.session!.sessionId).not.toBe(f.observer.sessionManager.getSessionId());
        expect(context.cwd).toBe(f.root);
        expect(Reflect.set(context.session!, "sessionId", "parent-id")).toBe(false);
        return outputs[1];
      });
    const host = f.host({ preparePrompt });
    expect(host.capabilities).toMatchObject({ plainPromptsOnly: false, promptPreparation: true });
    expect(Object.isFrozen(host.capabilities)).toBe(true);
    const run = f.blockRun();
    const resume = f.blockResume();
    const callbackResult = { routed: "next", metadata: { retained: true } };
    const operation = host.spawnChild({ prompt: "/skill:approved initial", withSession: async child => {
      const first = child.preparation!;
      expect(first).toEqual(expected[0]);
      expect(Object.getOwnPropertyDescriptor(child, "preparation")?.set).toBeUndefined();
      expect(Reflect.set(child, "preparation", { text: "forged receipt" })).toBe(false);
      const sending = child.sendUserMessage("/skill:approved next");
      const dispatched = await resume.started;
      expect(dispatched.prompt).toBe(expected[1].text);
      expect(dispatched.options?.requiredTools).toEqual(expected[1].requiredTools);
      expect(child.preparation).toEqual(expected[1]); // Input is observable before completion, not a receipt.
      expect(child.preparation).not.toBe(first);
      expect(Object.isFrozen(child.preparation)).toBe(true);
      expect(Object.isFrozen(child.preparation!.resources![0])).toBe(true);
      expect(preparePrompt.mock.calls[1][1].signal).toBe(child.signal);
      outputs[1].text = "late continuation replacement";
      outputs[1].requiredTools.push("write");
      outputs[1].resources[0] = { ...resource(f.root), sha256: "b".repeat(64) };
      expect(child.preparation).toEqual(expected[1]);
      expect(dispatched.options?.requiredTools).toEqual(expected[1].requiredTools);
      expect(first).toEqual(expected[0]);
      resume.finish();
      await sending;
      await child.waitForIdle();
      return callbackResult;
    } });
    const dispatched = await run.started;
    expect(dispatched.prompt).toBe(expected[0].text);
    expect(dispatched.options.requiredTools).toEqual(["read"]);
    expect(Object.isFrozen(dispatched.options.requiredTools)).toBe(true);
    outputs[0].text = "late fresh replacement";
    outputs[0].requiredTools.push("write");
    outputs[0].resources[0] = { ...resource(f.root), name: "changed" };
    run.finish();
    await expect(operation).resolves.toBe(callbackResult);
    expect(preparePrompt.mock.calls.map(([input]) => input)).toEqual(["/skill:approved initial", "/skill:approved next"]);
    expect(f.backend.run).toHaveBeenCalledOnce();
    expect(f.backend.resume).toHaveBeenCalledOnce();
    expect(f.backend.steer).not.toHaveBeenCalled();
  });

  it.each(["reattach", "fork"] as const)("never prepares the supplied %s prompt, then uses the actual persistent destination", async mode => {
    const f = fixture();
    const source = f.seed({ id: "actual-saved-identity", file: join(f.root, "old-run", "unrelated-name.jsonl") });
    const preparePrompt = vi.fn<WorkflowPromptPreparer>((input, context) => ({
      text: `${input} for ${context.session!.sessionId}`, requiredTools: ["read"],
    }));
    const host = f.host({ preparePrompt });
    await host.spawnChild({ [mode]: { sessionFile: source.reference.sessionFile }, prompt: "/unapproved:must-not-prepare",
      withSession: async child => {
        expect(child.preparation).toBeUndefined();
        expect(preparePrompt).not.toHaveBeenCalled();
        expect(f.backend.run).not.toHaveBeenCalled();
        expect(f.backend.resume).not.toHaveBeenCalled();
        await child.waitForIdle();
        await host.waitForIdle();
        await child.sendUserMessage("explicit continuation");
        const context = preparePrompt.mock.calls[0][1];
        expect(context.session).toEqual(child.reference);
        expect(context.signal).toBe(child.signal);
        expect(context.cwd).toBe(f.root);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.session)).toBe(true);
        expect(context.session!.sessionId).not.toBe("observer-id");
        if (mode === "fork") expect(context.session!.sessionId).not.toBe(source.reference.sessionId);
        else expect(context.session).toEqual(source.reference);
        expect(child.preparation).toEqual({ text: `explicit continuation for ${child.reference.sessionId}`, requiredTools: ["read"] });
        expect(f.backend.resume.mock.calls[0][0].reference).toEqual(context.session);
      },
    });
    expect(preparePrompt).toHaveBeenCalledOnce();
  });

  it.each(["pi", "positional-v1"] as const)("shares one approved %s file snapshot across provider hosts, edits and continuation", async format => {
    const f = fixture();
    const baseDir = join(f.root, "approved");
    mkdirSync(baseDir);
    const filePath = join(baseDir, "SKILL.md");
    const body = "APPROVED_ORIGINAL first=$1 assets=${SKILL_DIR}";
    const raw = `---\nname: approved\ndescription: Explicit fixture\n---\n${body}\n`;
    writeFileSync(filePath, raw);
    const digest = createHash("sha256").update(raw).digest("hex");
    const preparePrompt = vi.fn(createWorkflowSkillPreparer([{ name: "approved", filePath, baseDir, format,
      requiredTools: ["read"], expectedSha256: digest }]));
    const options: WorkflowExecutionProviderOptions = { pi: f.pi, getContext: () => f.ctx,
      createBackend: () => f.backend, inspectSession: file => f.backend.inspect(file), preparePrompt };
    const provider = createWorkflowExecutionProvider(options);
    options.preparePrompt = () => { throw new Error("caller retargeted provider options"); };
    writeFileSync(filePath, "REPLACED_AFTER_APPROVAL");
    const seen: PreparedWorkflowPrompt[] = [];
    for (const runId of ["first-owner", "second-owner"]) {
      const execution = provider.createHost(f.observer, { runId, childSessionsDir: dirname(f.sessionDir) });
      executions.push(execution);
      expect(execution.host.capabilities).toMatchObject({ plainPromptsOnly: false, promptPreparation: true });
      await execution.host.spawnChild({ prompt: '/skill:approved "two words"', withSession: async child => {
        seen.push(child.preparation!);
        writeFileSync(filePath, `REPLACED_DURING_${runId}`);
        await child.sendUserMessage("/skill:approved next");
        seen.push(child.preparation!);
      } });
      await execution.close();
    }
    expect(preparePrompt).toHaveBeenCalledTimes(4);
    expect(seen).toHaveLength(4);
    for (const prepared of seen) {
      expect(prepared.text).toContain('<skill name="approved"');
      expect(prepared.text).toContain("APPROVED_ORIGINAL");
      expect(prepared.text).not.toContain("REPLACED_");
      expect(prepared.text).not.toContain("/skill:");
      expect(prepared.resources).toEqual([{ kind: "skill", name: "approved", filePath, baseDir, sha256: digest, format }]);
      expect(prepared.requiredTools).toEqual(["read"]);
    }
    expect(seen[0].text).toContain(format === "pi" ? body : `first=two words assets=${baseDir}`);
    expect(seen[1].text).toContain(format === "pi" ? body : `first=next assets=${baseDir}`);
    expect(seen[0]).toEqual(seen[2]);
    expect(f.backend.run.mock.calls.map(call => call[2])).toEqual([seen[0].text, seen[2].text]);
    expect(f.backend.resume.mock.calls.map(call => call[1])).toEqual([seen[1].text, seen[3].text]);
  });

  it("rejects invalid continuation output without resuming or replacing the last valid preparation", async () => {
    const f = fixture();
    const preparePrompt = vi.fn<WorkflowPromptPreparer>().mockReturnValueOnce({ text: "initial expanded", requiredTools: ["read"] })
      .mockReturnValueOnce({ text: "/still-unexpanded" });
    let last!: PreparedWorkflowPrompt;
    const operation = f.host({ preparePrompt }).spawnChild({ prompt: "/skill:approved", withSession: async child => {
      last = child.preparation!;
      await expect(child.sendUserMessage("/skill:broken")).rejects.toThrow();
      expect(child.preparation).toBe(last);
      await expect(child.waitForIdle()).rejects.toThrow();
      return "a caught invocation failure must not become callback success";
    } });
    await expect(operation).rejects.toThrow();
    expect(f.backend.run).toHaveBeenCalledOnce();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
  });
});

describe("preparation admission, pending work and cancellation", () => {
  it("queues async preparation inside the same permit as fresh/resume work and isolates idle observers", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const prepareGate = f.gate();
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(async input => {
      if (input === "/skill:block") { entered.resolve(); await prepareGate.promise; }
      return { text: `expanded ${input}` };
    });
    const host = f.host({ maxConcurrency: 1, preparePrompt });
    const ready = deferred<ManagedWorkflowSessionContext>();
    const held = f.gate();
    const source = host.spawnChild({ prompt: "ignored", reattach: { sessionFile: f.seed().reference.sessionFile },
      withSession: async child => { ready.resolve(child); await held.promise; } });
    const child = await ready.promise;
    const run = f.blockRun();
    const fresh = host.spawnChild({ prompt: "/skill:block", withSession: async () => {} });
    await entered.promise;
    await child.waitForIdle(); // A sibling's preparer must not make an idle child busy.
    const sending = child.sendUserMessage("/skill:queued-send");
    const sibling = host.spawnChild({ prompt: "/skill:queued-fresh", withSession: async () => "sibling" });
    const idle = vi.fn();
    const waiting = host.waitForIdle().then(idle);
    await flush();
    expect(preparePrompt.mock.calls.map(([input]) => input)).toEqual(["/skill:block"]);
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();
    await expect(child.sendUserMessage("/skill:concurrent")).rejects.toThrow(diagnostic("busy"));
    expect(() => child.sessionManager.getBranch()).toThrow(diagnostic("busy"));
    prepareGate.resolve();
    await run.started;
    expect(preparePrompt).toHaveBeenCalledOnce();
    run.finish();
    await Promise.all([fresh, sending, sibling, waiting]);
    expect(preparePrompt.mock.calls.map(([input]) => input)).toEqual(["/skill:block", "/skill:queued-send", "/skill:queued-fresh"]);
    expect(idle).toHaveBeenCalledOnce();
    expect(f.observer.waitForIdle).not.toHaveBeenCalled();
    expect(f.backend.steer).not.toHaveBeenCalled();
    held.resolve();
    await source;
  });

  it("reports preparation errors to root idle observers while releasing capacity for a healthy sibling", async () => {
    const f = fixture();
    const gate = f.gate();
    const entered = deferred<void>();
    const failure = new Error("owner preparation failed");
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(async input => {
      if (input === "failing") { entered.resolve(); await gate.promise; throw failure; }
      return { text: `expanded ${input}` };
    });
    const host = f.host({ preparePrompt, maxConcurrency: 1 });
    const callback = vi.fn();
    const failing = host.spawnChild({ prompt: "failing", withSession: callback });
    const failed = expect(failing).rejects.toBe(failure);
    await entered.promise;
    const sibling = host.spawnChild({ prompt: "healthy", withSession: async child => {
      expect(child.signal?.aborted).toBe(false);
      await child.sendUserMessage("healthy continuation");
    } });
    const idleFailure = expect(host.waitForIdle()).rejects.toBe(failure);
    expect(preparePrompt).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([failed, idleFailure, sibling]);
    await host.waitForIdle();
    expect(callback).not.toHaveBeenCalled();
    expect(host.signal.aborted).toBe(false);
    expect(f.backend.run.mock.calls.map(call => call[2])).toEqual(["expanded healthy"]);
    expect(f.backend.resume.mock.calls.map(call => call[1])).toEqual(["expanded healthy continuation"]);
    expect(f.observer.waitForIdle).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"] as const)("observes an unawaited preparer %s and rejects callback success", async mode => {
    const f = fixture();
    const failure = new Error("preparation failed before continuation dispatch");
    const failed = deferred<void>();
    const preparePrompt: WorkflowPromptPreparer = input => {
      if (input === "first") return { text: input };
      failed.resolve();
      if (mode === "throw") throw failure;
      return Promise.reject(failure);
    };
    let child!: ManagedWorkflowSessionContext;
    const operation = f.host({ preparePrompt }).spawnChild({ prompt: "first", withSession: async current => {
      child = current;
      void child.sendUserMessage("unawaited"); // The host, not the test, observes this rejection.
      await failed.promise;
      await flush();
      await expect(child.waitForIdle()).rejects.toBe(failure);
      return "not success";
    } });
    await expect(operation).rejects.toBe(failure);
    expect(child.preparation).toEqual({ text: "first" });
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
  });

  it("rejects callback exit with pending preparation and prevents its late result from resuming", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const gate = f.gate();
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(async input => {
      if (input === "late") { entered.resolve(); await gate.promise; }
      return { text: `expanded ${input}` };
    });
    let pending!: Promise<void>;
    let child!: ManagedWorkflowSessionContext;
    const operation = f.host({ preparePrompt }).spawnChild({ prompt: "first", withSession: async current => {
      child = current;
      pending = child.sendUserMessage("late");
      void pending.catch(() => {});
      await entered.promise;
      return "premature success";
    } });
    await expect(operation).rejects.toThrow(diagnostic("unfinishedInvocation"));
    expect(f.backend.shutdown).toHaveBeenCalledOnce();
    expect(f.backend.resume).not.toHaveBeenCalled();
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(child.preparation).toEqual({ text: "expanded first" });
    expect(f.backend.resume).not.toHaveBeenCalled();
  });

  it("cancels queued preparation without evaluating it and does not block the next sibling", async () => {
    const f = fixture();
    const gate = f.gate();
    const entered = deferred<void>();
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(async input => {
      if (input === "blocker") { entered.resolve(); await gate.promise; }
      return { text: `expanded ${input}` };
    });
    const host = f.host({ preparePrompt, maxConcurrency: 1 });
    const blocker = host.spawnChild({ prompt: "blocker", withSession: async () => {} });
    await entered.promise;
    const controller = new AbortController();
    const callback = vi.fn();
    const cancelled = host.spawnChild({ prompt: "cancelled", signal: controller.signal, withSession: callback });
    const rejected = expect(cancelled).rejects.toBeInstanceOf(ConsumerCancellation);
    const next = host.spawnChild({ prompt: "next", withSession: async () => "next result" });
    controller.abort("queued preparation cancelled");
    await rejected;
    expect(preparePrompt).toHaveBeenCalledOnce();
    gate.resolve();
    await blocker;
    await expect(next).resolves.toBe("next result");
    expect(preparePrompt.mock.calls.map(([input]) => input)).toEqual(["blocker", "next"]);
    expect(f.backend.run.mock.calls.map(call => call[2])).toEqual(["expanded blocker", "expanded next"]);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["fresh", "resume"] as const)("retains capacity for cancelled %s preparation, discards its late result and never crosses sibling sessions", async mode => {
    const f = fixture();
    const gate = f.gate();
    const entered = deferred<void>();
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(async input => {
      if (input === "cancel me") { entered.resolve(); await gate.promise; }
      return { text: `expanded ${input}`, requiredTools: ["read"] };
    });
    const host = f.host({ preparePrompt, maxConcurrency: 1 });
    const controller = new AbortController();
    const callback = vi.fn();
    let child: ManagedWorkflowSessionContext | undefined;
    const cancelled = host.spawnChild({ prompt: mode === "fresh" ? "cancel me" : "initial", signal: controller.signal,
      withSession: async current => {
        child = current;
        callback();
        if (mode === "resume") await current.sendUserMessage("cancel me");
      } });
    const rejected = expect(cancelled).rejects.toMatchObject({ constructor: ConsumerCancellation, cause: "cancel only this preparation" });
    await entered.promise;
    const source = child?.reference;
    const before = child?.preparation;
    const siblingCallback = vi.fn(async (sibling: ManagedWorkflowSessionContext) => {
      expect(sibling.signal?.aborted).toBe(false);
      if (source) expect(sibling.reference.sessionId).not.toBe(source.sessionId);
      await sibling.sendUserMessage("sibling continuation");
      return sibling.reference;
    });
    const sibling = host.spawnChild({ prompt: "sibling", withSession: siblingCallback });
    const callsBeforeCancel = preparePrompt.mock.calls.length;
    controller.abort("cancel only this preparation");
    await rejected;
    await flush();
    expect(host.signal.aborted).toBe(false);
    expect(preparePrompt.mock.calls.at(-1)![1].signal.aborted).toBe(true);
    expect(preparePrompt).toHaveBeenCalledTimes(callsBeforeCancel);
    expect(siblingCallback).not.toHaveBeenCalled();
    expect(f.backend.resume).not.toHaveBeenCalled();
    expect(f.backend.run).toHaveBeenCalledTimes(mode === "fresh" ? 0 : 1);
    gate.resolve();
    const siblingRef = await sibling;
    expect(f.backend.run.mock.calls.map(call => call[2])).not.toContain("expanded cancel me");
    expect(f.backend.resume.mock.calls.map(call => call[1])).toEqual(["expanded sibling continuation"]);
    expect(f.backend.resume.mock.calls[0][0].reference).toEqual(siblingRef);
    expect(child?.preparation).toBe(before);
    expect(callback).toHaveBeenCalledTimes(mode === "fresh" ? 0 : 1);
  });

  it("cancels an active preparer on disposal and observes a late rejection without dispatch", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const gate = f.gate();
    const failure = new Error("late preparation failure after run close");
    const preparePrompt = vi.fn<WorkflowPromptPreparer>(async () => { entered.resolve(); await gate.promise; throw failure; });
    const host = f.host({ preparePrompt });
    const callback = vi.fn();
    const operation = host.spawnChild({ prompt: "/skill:approved", withSession: callback });
    const rejection = expect(operation).rejects.toBeInstanceOf(ConsumerCancellation);
    await entered.promise;
    await host.dispose(); // No backend handle exists; an opaque owner callback cannot hold teardown forever.
    await rejection;
    expect(preparePrompt.mock.calls[0][1].signal.aborted).toBe(true);
    gate.resolve();
    await flush();
    expect(callback).not.toHaveBeenCalled();
    expect(f.backend.run).not.toHaveBeenCalled();
    expect(f.backend.shutdown).not.toHaveBeenCalled();
  });
});
