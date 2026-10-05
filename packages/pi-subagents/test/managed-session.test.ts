import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedPolicy } from "../src/backends/managed-policy.js";
import { ManagedSession, type ManagedSessionSeed } from "../src/backends/managed-session.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "../src/backends/session-reference.js";
import { sessionWitness } from "../src/backends/session-witness.js";
import { i18n } from "../src/i18n.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture<K extends ExecutionBackendKind>(backend: K, extra: Partial<ManagedPolicy> = {}) {
  const root = mkdtempSync(join(tmpdir(), `managed-${backend}-`));
  roots.push(root);
  const policy: ManagedPolicy = { type: "general-purpose", name: "managed", cwd: root,
    model: { provider: "faux", id: "model" }, tools: ["read"], systemPrompt: "saved prompt", maxTurns: 3, graceTurns: 2, ...extra };
  const createSeed: ManagedSessionSeed<K> = vi.fn((resolved: ManagedPolicy) => {
    const sessionId = randomUUID();
    const sessionFile = join(root, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "now", cwd: resolved.cwd }) + "\n",
      { flag: "wx", mode: 0o600 });
    return Object.freeze({ backend, sessionId, sessionFile });
  });
  const managed = ManagedSession.create(policy, createSeed);
  return { root, policy, createSeed, managed };
}
function serialize(manager: SessionManager): string {
  return [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
function persist(managed: ManagedSession<ExecutionBackendKind>, change: (manager: SessionManager) => void) {
  const manager = managed.readReady().manager;
  managed.beginRun(randomUUID());
  change(manager);
  writeFileSync(managed.reference.sessionFile, serialize(manager));
  managed.checkpoint("low", sessionWitness(manager));
}
function schema() {
  const result = compileJsonSchema({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] });
  if (result.ok === false) throw new Error(result.message);
  return result.compiled;
}

// The same private store contract applies without either execution adapter or a model call.
describe.each(["terminal", "embedded"] as const)("shared managed %s persistence", (backend) => {
  const foreignBackend = backend === "terminal" ? "embedded" : "terminal";

  it("snapshots credential-free policy before seed creation and holds one lease across clean runs", () => {
    const f = fixture(backend, { model: { provider: "faux", id: "model", headers: { authorization: "never-serialize" } } as any });
    expect(f.createSeed).toHaveBeenCalledWith(f.managed.policy);
    expect(Object.isFrozen(f.managed.policy)).toBe(true);
    expect(Object.isFrozen(f.managed.policy.model)).toBe(true);
    expect(Object.isFrozen(f.managed.policy.tools)).toBe(true);
    expect(f.managed.policy.model).toEqual({ provider: "faux", id: "model" });
    expect(readFileSync(`${f.managed.reference.sessionFile}.pi-subagents.json`, "utf8")).not.toContain("never-serialize");
    expect(f.managed.reference.backend).toBe(backend);
    expect(() => ManagedSession.open(f.managed.reference, backend)).toThrow(i18n.t("sessionStore.busy"));
    persist(f.managed, (manager) => { manager.appendMessage({ role: "user", content: "saved turn", timestamp: 1 }); });
    expect(() => ManagedSession.open(f.managed.reference, backend)).toThrow(i18n.t("sessionStore.busy"));
    const before = readFileSync(f.managed.reference.sessionFile);
    f.managed.release();
    f.managed.release();
    const restored = ManagedSession.open(f.managed.reference, backend);
    expect(restored.reference).toEqual(f.managed.reference);
    expect(restored.policy).toMatchObject({ thinkingLevel: "low", maxTurns: 3, graceTurns: 2 });
    expect(restored.readReady().manager.buildSessionProjection().messages).toEqual([{ role: "user", content: "saved turn", timestamp: 1 }]);
    expect(readFileSync(restored.reference.sessionFile)).toEqual(before);
    restored.release();
    expect(() => restored.beginRun("closed")).toThrow(i18n.t("sessionStore.leaseLost"));
  });

  it("checks the backend discriminator in both the caller reference and persisted record", () => {
    const f = fixture(backend);
    f.managed.release();
    expect(() => ManagedSession.open(f.managed.reference, foreignBackend)).toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(() => ManagedSession.open({ ...f.managed.reference, backend: foreignBackend }, foreignBackend)).toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(existsSync(`${f.managed.reference.sessionFile}.pi-subagents.lock`)).toBe(false);
    const recordFile = `${f.managed.reference.sessionFile}.pi-subagents.json`;
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    writeFileSync(recordFile, JSON.stringify({ ...record, reference: { ...record.reference, backend: foreignBackend } }) + "\n");
    expect(() => ManagedSession.open(f.managed.reference, backend)).toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(existsSync(`${f.managed.reference.sessionFile}.pi-subagents.lock`)).toBe(false);
  });

  it("forks raw active history and saved policy under a new same-backend identity", () => {
    const f = fixture(backend);
    persist(f.managed, (manager) => {
      manager.appendMessage({ role: "system", content: "", sections: { preamble: "saved system" }, timestamp: 1 });
      const branch = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
      manager.appendMessage({ role: "user", content: "abandoned", timestamp: 3 });
      manager.branch(branch);
      manager.appendCompaction("summary", branch, 10);
      manager.appendContextEdit(branch, { content: "edited" });
      manager.appendCustomEntry("opaque", { value: 1 });
    });
    const before = readFileSync(f.managed.reference.sessionFile);
    const source = f.managed.readReady().manager;
    const fork = f.managed.fork(f.createSeed);
    expect(fork.reference.backend).toBe(backend);
    expect(fork.reference.sessionId).not.toBe(f.managed.reference.sessionId);
    expect(fork.reference.sessionFile).not.toBe(f.managed.reference.sessionFile);
    expect(fork.policy).toEqual(f.managed.policy);
    expect(fork.readReady().manager.getHeader()?.parentSession).toBe(f.managed.reference.sessionFile);
    expect(fork.readReady().manager.getEntries()).toEqual(source.getBranch());
    expect(fork.readReady().manager.buildSessionProjection()).toEqual(source.buildSessionProjection());
    expect(readFileSync(f.managed.reference.sessionFile)).toEqual(before);
    fork.release();
    f.managed.release();
  });

  it("requires matching caller validation before either restoring or seeding a structured fork", () => {
    const compiled = schema();
    const f = fixture(backend, { structuredSchema: compiled.schema });
    expect(() => f.managed.fork(f.createSeed)).toThrow(i18n.t("sessionStore.validatorRequired"));
    expect(f.createSeed).toHaveBeenCalledTimes(1);
    const fork = f.managed.fork(f.createSeed, { structuredOutput: compiled });
    fork.release();
    f.managed.release();
    expect(() => ManagedSession.open(f.managed.reference, backend)).toThrow(i18n.t("sessionStore.validatorRequired"));
    expect(() => ManagedSession.open(f.managed.reference, backend, { structuredOutput: { ...compiled, schema: { type: "object" } } }))
      .toThrow(i18n.t("sessionStore.schemaMismatch"));
    const restored = ManagedSession.open(f.managed.reference, backend, { structuredOutput: compiled });
    restored.release();
  });

  it("rejects a rewritten prefix even when the finalized witness agrees with the new file", () => {
    const f = fixture(backend);
    persist(f.managed, (manager) => { manager.appendMessage({ role: "user", content: "original", timestamp: 1 }); });
    f.managed.beginRun("rewrite");
    const rows = readFileSync(f.managed.reference.sessionFile, "utf8").trimEnd().split("\n").map((row) => JSON.parse(row));
    rows[1].message.content = "rewritten content";
    const modified = SessionManager.inMemory(f.policy.cwd, undefined, rows);
    writeFileSync(f.managed.reference.sessionFile, serialize(modified));
    expect(() => f.managed.checkpoint("low", sessionWitness(modified))).toThrow(i18n.t("sessionStore.invalidFile"));
    expect(() => f.managed.release()).toThrow(i18n.t("sessionStore.unsafe"));
    expect(existsSync(`${f.managed.reference.sessionFile}.pi-subagents.lock`)).toBe(true);
  });

  it.each(["running", "quarantined"])("does not release or reopen %s state", (state) => {
    const f = fixture(backend);
    f.managed.beginRun("uncertain");
    if (state === "quarantined") f.managed.quarantine();
    expect(() => f.managed.release()).toThrow(i18n.t("sessionStore.unsafe"));
    expect(() => f.managed.fork(f.createSeed)).toThrow(i18n.t("sessionStore.unsafe"));
    expect(f.createSeed).toHaveBeenCalledTimes(1);
    rmSync(`${f.managed.reference.sessionFile}.pi-subagents.lock`, { recursive: true }); // simulate an operator, never recovery
    expect(() => ManagedSession.open(f.managed.reference, backend)).toThrow(i18n.t("sessionStore.unsafe"));
  });

  it("rejects a backend-changing fork callback even when invoked without static types", () => {
    const f = fixture(backend);
    const createForeign: ManagedSessionSeed<ExecutionBackendKind> = (policy) => ({ ...f.createSeed(policy), backend: foreignBackend });
    expect(() => f.managed.fork(createForeign as ManagedSessionSeed<typeof backend>)).toThrow(i18n.t("sessionStore.invalidRecord"));
    f.managed.release();
  });

  it("rejects malformed seed identities instead of persisting an unopenable record", () => {
    const f = fixture(backend);
    const seed = vi.fn(() => ({ ...f.managed.reference, sessionId: "" } satisfies PersistentSessionReference));
    expect(() => ManagedSession.create(f.policy, seed)).toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(f.managed.readReady().manager.getHeader()?.id).toBe(f.managed.reference.sessionId);
    f.managed.release();
  });
});
