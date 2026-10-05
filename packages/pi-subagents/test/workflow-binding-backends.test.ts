/** Binding admission across real offline SDK sessions and Pi CLI children. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embedded from "../src/backends/embedded-managed.js";
import { inspectManagedSession, ManagedSession } from "../src/backends/managed-session.js";
import * as leases from "../src/backends/session-lease.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "../src/backends/session-reference.js";
import type { AgentExecutionBackend } from "../src/backends/types.js";
import { i18n } from "../src/i18n.js";
import * as workflowProvider from "../src/workflow/execution-provider.js";
import { createWorkflowSkillPreparer } from "../src/workflow/skill-resources.js";
import { prompt, workflowRealBackend } from "./helpers/workflow-real-backends.js";

vi.mock("../src/backends/session-lease.js", async original => ({ ...await original<typeof import("../src/backends/session-lease.js")>() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const createProvider = workflowProvider.createWorkflowExecutionProvider;
const createEmbedded = embedded.createManagedEmbeddedExecutionBackend;
const fixtures: ReturnType<typeof workflowRealBackend>[] = [];
let previousOffline: string | undefined;
let previousVersionCheck: string | undefined;
beforeEach(() => {
  previousOffline = process.env.PI_OFFLINE;
  previousVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
});
afterEach(async () => {
  try { for (const f of fixtures.splice(0)) await f.cleanup(); }
  finally {
    vi.restoreAllMocks();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousVersionCheck;
  }
});
const saved = (file: string) => ({ transcript: readFileSync(file), policy: readFileSync(`${file}.pi-subagents.json`) });
const lock = (file: string) => `${file}.pi-subagents.lock`;

for (const kind of ["embedded", "terminal"] as const) {
  describe.skipIf(kind === "terminal" && process.platform === "win32")(`real offline ${kind} prompt binding`, () => {
    it("persists and propagates identity through fresh/owned fork/reattach/send, and rejects mismatches before lease/native/prompt work", async () => {
      const preparer = createWorkflowSkillPreparer([]);
      const preparePrompt = vi.fn(preparer);
      const native = vi.fn(createAgentSession);
      vi.spyOn(embedded, "createManagedEmbeddedExecutionBackend")
        .mockImplementation((config, ports) => createEmbedded(config, { ...ports, createSession: native }));
      let providerOptions!: workflowProvider.WorkflowExecutionProviderOptions;
      let ctx!: ExtensionContext;
      const backends: AgentExecutionBackend[] = [];
      const inject = vi.spyOn(workflowProvider, "createWorkflowExecutionProvider").mockImplementation(options => {
        providerOptions = options;
        return createProvider({ ...options, preparePrompt, promptBinding: preparer.promptBinding,
          getContext(observer, run) { return ctx = options.getContext(observer, run); },
          createBackend(input) { const backend = options.createBackend(input); backends.push(backend); return backend; },
        });
      });
      let f: ReturnType<typeof workflowRealBackend>;
      try { f = workflowRealBackend(kind); fixtures.push(f); }
      finally { inject.mockRestore(); }
      const first = f.execution("bound-source");
      expect(first.host.promptBinding).toEqual(preparer.promptBinding);
      f.script("bound-seed");
      const source = await first.host.spawnChild({ prompt: prompt("bound-seed"), withSession: async child => {
        const reference = child.reference;
        expect(inspectManagedSession(reference.sessionFile, kind).policy.promptBinding).toEqual(preparer.promptBinding);
        expect(JSON.parse(saved(reference.sessionFile).policy.toString()).policy.promptBinding).toEqual(preparer.promptBinding);
        const before = saved(reference.sessionFile);
        const lease = vi.spyOn(leases, "acquireSessionLease");
        const nativeCalls = native.mock.calls.length;
        const calls = f.calls();
        const entries = readdirSync(join(first.childSessionsDir, "managed"));
        for (const expected of [undefined, { ...preparer.promptBinding, resolverId: "other/resolver@1" },
          { ...preparer.promptBinding, resourceSetDigest: "f".repeat(64) }]) {
          await expect(backends[0].fork!(reference, { ctx, structuredOutput: providerOptions.structuredOutput, promptBinding: expected }))
            .rejects.toThrow(i18n.t("promptBinding.mismatch"));
        }
        expect(lease).not.toHaveBeenCalled();
        lease.mockRestore();
        expect(native).toHaveBeenCalledTimes(nativeCalls);
        expect(f.calls()).toBe(calls);
        expect(readdirSync(join(first.childSessionsDir, "managed"))).toEqual(entries);
        expect(saved(reference.sessionFile)).toEqual(before);
        const initialBranch = child.sessionManager.getBranch();
        await first.host.spawnChild({ fork: { sessionFile: reference.sessionFile }, prompt: "/ignored-fork", withSession: async forked => {
          expect(forked.reference.sessionId).not.toBe(reference.sessionId);
          expect(forked.sessionManager.getBranch()).toEqual(initialBranch);
          expect(forked.preparation).toBeUndefined();
          expect(inspectManagedSession(forked.reference.sessionFile, kind).policy.promptBinding).toEqual(preparer.promptBinding);
        } });
        expect(preparePrompt).toHaveBeenCalledOnce();
        expect(saved(reference.sessionFile)).toEqual(before);
        return reference;
      } });
      await first.close();
      expect(existsSync(lock(source.sessionFile))).toBe(false);

      // Exercise the backend directly too: host preflight is not the sole protection.
      const run = { runId: "direct-admission", childSessionsDir: join(f.root, "direct") };
      const direct = providerOptions.createBackend({ run, sessionDir: join(run.childSessionsDir, "managed") });
      const before = saved(source.sessionFile);
      const calls = f.calls();
      const nativeCalls = native.mock.calls.length;
      const lease = vi.spyOn(leases, "acquireSessionLease");
      for (const mode of ["reattach", "fork"] as const) {
        for (const expected of [undefined, { ...preparer.promptBinding, resolverId: "other/resolver@1" },
          { ...preparer.promptBinding, resourceSetDigest: "f".repeat(64) }]) {
          await expect(direct[mode]!(source, { ctx, structuredOutput: providerOptions.structuredOutput, promptBinding: expected }))
            .rejects.toThrow(i18n.t("promptBinding.mismatch"));
        }
      }
      expect(lease).not.toHaveBeenCalled();
      lease.mockRestore();
      expect(native).toHaveBeenCalledTimes(nativeCalls);
      expect(f.calls()).toBe(calls);
      expect(preparePrompt).toHaveBeenCalledOnce();
      expect(saved(source.sessionFile)).toEqual(before);
      expect(existsSync(lock(source.sessionFile))).toBe(false);
      expect(existsSync(join(run.childSessionsDir, "managed"))).toBe(false);

      // A bound consumer must also reject a clean legacy/unbound managed source.
      const policy = inspectManagedSession(source.sessionFile, kind).policy;
      const unbound = ManagedSession.create({ ...policy, promptBinding: undefined }, resolved => {
        const sessionId = randomUUID();
        const dir = join(f.root, "unbound");
        mkdirSync(dir, { recursive: true });
        const sessionFile = join(dir, `${sessionId}.jsonl`);
        writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "now", cwd: resolved.cwd }) + "\n");
        return { backend: kind, sessionId, sessionFile } satisfies PersistentSessionReference<ExecutionBackendKind>;
      });
      unbound.release();
      const legacyBytes = saved(unbound.reference.sessionFile);
      const legacyLease = vi.spyOn(leases, "acquireSessionLease");
      for (const mode of ["reattach", "fork"] as const) {
        await expect(direct[mode]!(unbound.reference, { ctx, structuredOutput: providerOptions.structuredOutput, promptBinding: preparer.promptBinding }))
          .rejects.toThrow(i18n.t("promptBinding.mismatch"));
      }
      expect(legacyLease).not.toHaveBeenCalled();
      legacyLease.mockRestore();
      expect(native).toHaveBeenCalledTimes(nativeCalls);
      expect(f.calls()).toBe(calls);
      expect(saved(unbound.reference.sessionFile)).toEqual(legacyBytes);

      const second = f.execution("bound-reattach");
      await second.host.spawnChild({ reattach: { sessionFile: source.sessionFile }, prompt: "/ignored-reattach", withSession: async child => {
        expect(child.reference).toEqual(source);
        expect(child.preparation).toBeUndefined();
        expect(preparePrompt).toHaveBeenCalledOnce();
        expect(f.calls()).toBe(calls);
        expect(inspectManagedSession(source.sessionFile, kind).policy.promptBinding).toEqual(preparer.promptBinding);
        f.script("bound-continue");
        await child.sendUserMessage(prompt("bound-continue"));
        expect(inspectManagedSession(source.sessionFile, kind).policy.promptBinding).toEqual(preparer.promptBinding);
      } });
      await second.close();
      expect(preparePrompt).toHaveBeenCalledTimes(2);
      expect(existsSync(lock(source.sessionFile))).toBe(false);
      await f.transport.assertRetired();
    });
  });
}
