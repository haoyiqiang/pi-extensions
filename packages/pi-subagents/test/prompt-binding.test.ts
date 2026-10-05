import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedPolicy } from "../src/backends/managed-policy.js";
import { inspectManagedSession, ManagedSession, type ManagedSessionSeed } from "../src/backends/managed-session.js";
import { assertPromptBindingMatches, snapshotPromptBinding, type PromptBinding } from "../src/backends/prompt-binding.js";
import * as leases from "../src/backends/session-lease.js";
import type { ExecutionBackendKind } from "../src/backends/session-reference.js";
import { i18n } from "../src/i18n.js";

vi.mock("../src/backends/session-lease.js", async original => ({ ...await original<typeof import("../src/backends/session-lease.js")>() }));
const binding = (): PromptBinding => ({ resolverId: "fixture/skills@1", resourceSetDigest: "a".repeat(64), assetMode: "live" });
const mismatch = () => i18n.t("promptBinding.mismatch");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture<K extends ExecutionBackendKind>(backend: K, promptBinding?: PromptBinding) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `binding-${backend}-`)));
  roots.push(root);
  const policy: ManagedPolicy = { type: "general-purpose", name: "managed", cwd: root,
    model: { provider: "fixture", id: "offline" }, tools: ["read"], systemPrompt: "saved", promptBinding };
  const seed: ManagedSessionSeed<K> = vi.fn(resolved => {
    const sessionId = randomUUID();
    const sessionFile = join(root, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "now", cwd: resolved.cwd }) + "\n");
    return { backend, sessionId, sessionFile };
  });
  const managed = ManagedSession.create(policy, seed);
  const bytes = () => ({ transcript: readFileSync(managed.reference.sessionFile), record: readFileSync(`${managed.reference.sessionFile}.pi-subagents.json`) });
  return { root, policy, seed, managed, bytes };
}

describe("data-only prompt binding", () => {
  it("snapshots and freezes only the explicit identity fields", () => {
    const mutable = { ...binding(), privateCredential: "not-for-persistence" };
    const snapshot = snapshotPromptBinding(mutable);
    mutable.resolverId = "changed";
    mutable.resourceSetDigest = "b".repeat(64);
    expect(snapshot).toEqual(binding());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("privateCredential");
    expect(snapshotPromptBinding(undefined)).toBeUndefined();
  });

  it.each([null, false, [], {}, { ...binding(), resolverId: "" }, { ...binding(), resolverId: " padded " },
    { ...binding(), resolverId: "line\nbreak" }, { ...binding(), resourceSetDigest: "A".repeat(64) },
    { ...binding(), resourceSetDigest: "a".repeat(63) }, { ...binding(), resourceSetDigest: `${"a".repeat(64)}\n` },
    { ...binding(), resourceSetDigest: 3 }, { ...binding(), assetMode: "snapshot" }, { ...binding(), assetMode: undefined }])(
    "rejects malformed binding %j", value => {
      expect(() => snapshotPromptBinding(value)).toThrow(i18n.t("promptBinding.invalid"));
    },
  );

  it("requires exact resolver, digest and presence instead of guessing from an absent binding", () => {
    expect(() => assertPromptBindingMatches(undefined, undefined)).not.toThrow();
    expect(() => assertPromptBindingMatches(binding(), binding())).not.toThrow();
    for (const [actual, expected] of [[binding(), undefined], [undefined, binding()],
      [binding(), { ...binding(), resolverId: "fixture/skills@2" }],
      [binding(), { ...binding(), resourceSetDigest: "b".repeat(64) }]]) {
      expect(() => assertPromptBindingMatches(actual, expected)).toThrow(mismatch());
    }
  });
});

describe.each(["embedded", "terminal"] as const)("%s managed prompt binding persistence", backend => {
  it("serializes immutable policy identity and preserves it on matched open and fork", () => {
    const mutable = { ...binding(), ignored: "private-field" };
    const f = fixture(backend, mutable);
    mutable.resolverId = "mutated";
    expect(f.managed.policy.promptBinding).toEqual(binding());
    expect(Object.isFrozen(f.managed.policy.promptBinding)).toBe(true);
    expect(JSON.parse(f.bytes().record.toString()).policy.promptBinding).toEqual(binding());
    expect(f.bytes().record.toString()).not.toContain("private-field");
    const initial = f.bytes();
    const fork = f.managed.fork(f.seed, { promptBinding: binding() });
    expect(fork.policy.promptBinding).toEqual(binding());
    expect(inspectManagedSession(fork.reference.sessionFile, backend).policy.promptBinding).toEqual(binding());
    expect(f.bytes()).toEqual(initial);
    fork.release();
    f.managed.release();
    const restored = ManagedSession.open(f.managed.reference, backend, { promptBinding: binding() });
    expect(restored.policy.promptBinding).toEqual(binding());
    restored.release();
    expect(f.bytes()).toEqual(initial);
  });

  it("rejects every mismatch before acquiring a source lease or seeding a fork", () => {
    for (const [actual, expected] of [[binding(), undefined], [undefined, binding()],
      [binding(), { ...binding(), resolverId: "fixture/other@1" }],
      [binding(), { ...binding(), resourceSetDigest: "b".repeat(64) }]]) {
      const f = fixture(backend, actual);
      const lease = vi.spyOn(leases, "acquireSessionLease");
      const initial = f.bytes();
      expect(() => f.managed.fork(f.seed, { promptBinding: expected })).toThrow(mismatch());
      expect(f.seed).toHaveBeenCalledTimes(1);
      expect(() => ManagedSession.open(f.managed.reference, backend, { promptBinding: expected })).toThrow(mismatch());
      expect(lease).not.toHaveBeenCalled();
      f.managed.release();
      const files = readdirSync(f.root);
      expect(() => ManagedSession.open(f.managed.reference, backend, { promptBinding: expected })).toThrow(mismatch());
      expect(lease).not.toHaveBeenCalled();
      expect(f.bytes()).toEqual(initial);
      expect(readdirSync(f.root)).toEqual(files);
      lease.mockRestore();
    }
  });

  it("preserves lease/busy diagnostics for matched or unbound quarantined owners", () => {
    for (const promptBinding of [undefined, binding()]) {
      const f = fixture(backend, promptBinding);
      f.managed.beginRun("uncertain");
      f.managed.quarantine();
      const initial = f.bytes();
      expect(() => ManagedSession.open(f.managed.reference, backend, { promptBinding })).toThrow(i18n.t("sessionStore.busy"));
      const lease = vi.spyOn(leases, "acquireSessionLease");
      const expected = promptBinding ? undefined : binding();
      expect(() => ManagedSession.open(f.managed.reference, backend, { promptBinding: expected })).toThrow(mismatch());
      expect(lease).not.toHaveBeenCalled();
      expect(f.bytes()).toEqual(initial);
      lease.mockRestore();
    }
  });

  it("validates persisted binding data instead of trusting raw policy fields", () => {
    const f = fixture(backend, binding());
    f.managed.release();
    const file = `${f.managed.reference.sessionFile}.pi-subagents.json`;
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.policy.promptBinding.resourceSetDigest = "NOT-A-DIGEST";
    writeFileSync(file, JSON.stringify(record) + "\n");
    const initial = f.bytes();
    const lease = vi.spyOn(leases, "acquireSessionLease");
    expect(() => ManagedSession.open(f.managed.reference, backend, { promptBinding: binding() }))
      .toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(() => inspectManagedSession(f.managed.reference.sessionFile, backend)).toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(lease).not.toHaveBeenCalled();
    expect(f.bytes()).toEqual(initial);
  });

  it("keeps unbound policies compatible when the caller also omits identity", () => {
    const f = fixture(backend);
    expect(JSON.parse(f.bytes().record.toString()).policy).not.toHaveProperty("promptBinding");
    const fork = f.managed.fork(f.seed);
    expect(fork.policy.promptBinding).toBeUndefined();
    fork.release();
    f.managed.release();
    ManagedSession.open(f.managed.reference, backend).release();
  });
});
