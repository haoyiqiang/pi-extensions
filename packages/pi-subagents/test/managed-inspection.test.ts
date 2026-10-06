import { randomUUID } from "node:crypto";
import {
  existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedEmbeddedExecutionBackend } from "../src/backends/embedded-managed.js";
import type { ManagedPolicy } from "../src/backends/managed-policy.js";
import { inspectManagedSession, ManagedSession } from "../src/backends/managed-session.js";
import * as leases from "../src/backends/session-lease.js";
import type { ExecutionBackendKind } from "../src/backends/session-reference.js";
import { sessionWitness } from "../src/backends/session-witness.js";
import { createTerminalExecutionBackend } from "../src/backends/terminal/backend.js";
import type { TerminalBridge } from "../src/backends/terminal/bridge-server.js";
import type { ChildFeedback, TerminalSnapshot } from "../src/backends/terminal/bridge-protocol.js";
import type { ExecutionSession } from "../src/backends/session.js";
import { i18n } from "../src/i18n.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture<K extends ExecutionBackendKind>(backend: K, extra: Partial<ManagedPolicy> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `managed-inspect-${backend}-`)));
  roots.push(root);
  const policy: ManagedPolicy = { type: "general-purpose", name: "saved", cwd: root,
    model: { provider: "faux", id: "model" }, tools: ["read"], systemPrompt: "saved policy", ...extra };
  const managed = ManagedSession.create(policy, () => {
    const sessionId = randomUUID();
    const sessionFile = join(root, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root, timestamp: "now" }) + "\n");
    return { backend, sessionId, sessionFile };
  });
  const file = managed.reference.sessionFile;
  const recordFile = `${file}.pi-subagents.json`;
  return { root, managed, file, recordFile, lock: `${file}.pi-subagents.lock` };
}

function persist(managed: ManagedSession<ExecutionBackendKind>, change: (manager: SessionManager) => void) {
  const manager = managed.readReady().manager;
  managed.beginRun(randomUUID());
  change(manager);
  writeFileSync(managed.reference.sessionFile, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  managed.checkpoint(undefined, sessionWitness(manager));
  return manager;
}

function history(managed: ManagedSession<ExecutionBackendKind>) {
  return persist(managed, manager => {
    manager.appendMessage({ role: "system", content: "", sections: { preamble: "original system" }, timestamp: 1 });
    const kept = manager.appendMessage({ role: "user", content: "original user", timestamp: 2 });
    manager.appendMessage({ role: "user", content: "abandoned branch", timestamp: 3 });
    manager.branch(kept);
    manager.appendCompaction("saved summary", kept, 42, { opaqueCompaction: true });
    manager.appendContextEdit(kept, { content: "projected replacement" });
    const opaque = manager.appendCustomEntry("workflow-offset", { offset: 17 });
    Object.assign(manager.getEntry(opaque)!, { extraEnvelope: { preserved: true } });
  });
}

function diskSnapshot(root: string): unknown {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return { name, dev: stat.dev, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs, mode: stat.mode, nlink: stat.nlink,
      contents: stat.isDirectory() ? diskSnapshot(path) : readFileSync(path) };
  });
}

function editRecord(file: string, change: (record: any) => void) {
  const record = JSON.parse(readFileSync(file, "utf8"));
  change(record);
  writeFileSync(file, JSON.stringify(record) + "\n");
}

function refusesUnchanged(f: ReturnType<typeof fixture>, backend: ExecutionBackendKind, diagnostic: string) {
  const before = diskSnapshot(f.root);
  expect(() => inspectManagedSession(f.file, backend)).toThrow(i18n.t(diagnostic));
  expect(diskSnapshot(f.root)).toEqual(before);
}

describe.each(["embedded", "terminal"] as const)("read-only managed %s inspection", backend => {
  it("resolves identity/policy and raw active envelopes without projected messages, opening or leases", () => {
    const f = fixture(backend);
    const manager = history(f.managed);
    const before = diskSnapshot(f.root);
    const open = vi.spyOn(SessionManager, "open").mockImplementation(() => { throw new Error("must not open"); });
    const acquire = vi.spyOn(leases, "acquireSessionLease").mockImplementation(() => { throw new Error("must not acquire"); });
    const inspected = inspectManagedSession(f.file, backend);
    expect(inspected.reference).toEqual(f.managed.reference);
    expect(inspected.policy).toEqual(f.managed.policy);
    expect(inspected.branch).toEqual(manager.getBranch());
    expect(inspected.branch.map(entry => entry.type)).toEqual(["message", "message", "compaction", "context_edit", "custom"]);
    expect(inspected.branch[1].message?.content).toBe("original user");
    expect(inspected.branch.at(-1)).toMatchObject({ data: { offset: 17 }, extraEnvelope: { preserved: true } });
    expect(inspected.branch).not.toEqual(manager.buildSessionProjection().messages);
    expect(JSON.stringify(inspected.branch)).not.toContain("abandoned branch");
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.reference)).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(diskSnapshot(f.root)).toEqual(before);
    f.managed.release();
    const released = diskSnapshot(f.root);
    expect(inspectManagedSession(f.file, backend)).toEqual(inspected);
    expect(existsSync(f.lock)).toBe(false);
    expect(diskSnapshot(f.root)).toEqual(released);
  });

  it("validates a structured policy without demanding the restore-only caller validator", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    const f = fixture(backend, { structuredSchema: schema, maxTurns: 2, graceTurns: 1 });
    expect(inspectManagedSession(f.file, backend)).toMatchObject({ policy: { structuredSchema: schema, maxTurns: 2, graceTurns: 1 }, branch: [] });
    f.managed.release();
    expect(() => ManagedSession.open(f.managed.reference, backend)).toThrow(i18n.t("sessionStore.validatorRequired"));
  });

  it("canonicalizes absolute aliases, rejects relative sources, and uses only canonical sidecars", () => {
    const f = fixture(backend);
    const alias = join(f.root, "alias.jsonl");
    symlinkSync(f.file, alias);
    writeFileSync(`${alias}.pi-subagents.json`, "untrusted alias metadata");
    expect(inspectManagedSession(alias, backend).reference).toEqual(f.managed.reference);
    expect(() => inspectManagedSession(relative(process.cwd(), f.file), backend)).toThrow(i18n.t("sessionStore.invalidFile"));
    expect(() => inspectManagedSession("", backend)).toThrow(i18n.t("sessionStore.invalidFile"));
    expect(() => inspectManagedSession(join(f.root, "missing.jsonl"), backend)).toThrow(i18n.t("sessionStore.invalidFile"));
    f.managed.release();
  });

  it("rejects a bare v3 transcript without repairing it or creating metadata", () => {
    const f = fixture(backend);
    f.managed.release();
    rmSync(f.recordFile);
    refusesUnchanged(f, backend, "sessionStore.invalidRecord");
  });

  it.each(["running", "quarantined", "unknown"])("fails closed on %s records even with an existing writer lease", state => {
    const f = fixture(backend);
    editRecord(f.recordFile, record => { record.state = state; });
    refusesUnchanged(f, backend, "sessionStore.unsafe");
  });

  it("rejects a source owned by the other backend", () => {
    const f = fixture(backend);
    refusesUnchanged(f, backend === "embedded" ? "terminal" : "embedded", "sessionStore.invalidRecord");
  });

  it.each([
    ["version", (record: any) => { record.version = 2; }],
    ["missing id", (record: any) => { delete record.reference.sessionId; }],
    ["empty id", (record: any) => { record.reference.sessionId = " "; }],
    ["path mismatch", (record: any) => { record.reference.sessionFile += ".other"; }],
    ["relative path", (record: any) => { record.reference.sessionFile = "relative.jsonl"; }],
    ["malformed checkpoint", (record: any) => { record.checkpoint.entries = -1; }],
    ["malformed leaf", (record: any) => { record.checkpoint.leafId = 3; }],
    ["malformed digest", (record: any) => { record.checkpoint.digest = "bad"; }],
    ["malformed bytes", (record: any) => { record.checkpoint.bytes = 1.5; }],
    ["malformed policy", (record: any) => { record.policy.tools = ["unknown-tool"]; }],
    ["malformed schema", (record: any) => { record.policy.structuredSchema = { type: "not-json-schema" }; }],
  ] as const)("uses shared strict record validation: %s", (_name, change) => {
    const f = fixture(backend);
    editRecord(f.recordFile, change);
    refusesUnchanged(f, backend, "sessionStore.invalidRecord");
  });

  it.each(["leafId", "entries", "bytes", "digest"] as const)("requires exact checkpoint %s", key => {
    const f = fixture(backend);
    history(f.managed);
    editRecord(f.recordFile, record => {
      record.checkpoint[key] = key === "leafId" ? "different-leaf" : key === "digest" ? "0".repeat(64) : record.checkpoint[key] + 1;
    });
    refusesUnchanged(f, backend, "sessionStore.invalidFile");
  });

  it.each([
    ["invalid JSON", (rows: any[]) => JSON.stringify(rows[0]) + "\n{broken\n"],
    ["partial final line", (rows: any[]) => JSON.stringify(rows[0])],
    ["legacy header", (rows: any[]) => JSON.stringify({ ...rows[0], version: 2 }) + "\n"],
    ["identity mismatch", (rows: any[]) => JSON.stringify({ ...rows[0], id: "other" }) + "\n"],
    ["workspace mismatch", (rows: any[]) => JSON.stringify({ ...rows[0], cwd: join(rows[0].cwd, "other") }) + "\n"],
    ["dangling parent", (rows: any[]) => rows.map((row, index) => JSON.stringify(index === 1 ? { ...row, parentId: "absent" } : row)).join("\n") + "\n"],
    ["duplicate id", (rows: any[]) => [...rows, rows[1]].map(row => JSON.stringify(row)).join("\n") + "\n"],
    ["malformed message", (rows: any[]) => rows.map((row, index) => JSON.stringify(index === 1 ? { ...row, message: null } : row)).join("\n") + "\n"],
  ] as const)("rejects dirty/malformed transcripts without SDK repair: %s", (_name, change) => {
    const f = fixture(backend);
    history(f.managed);
    f.managed.release();
    const rows = readFileSync(f.file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    writeFileSync(f.file, change(rows));
    refusesUnchanged(f, backend, "sessionStore.invalidFile");
  });

  it.each(["transcript", "record"] as const)("rejects hardlinked %s files without changing either link", target => {
    const f = fixture(backend);
    const path = target === "transcript" ? f.file : f.recordFile;
    linkSync(path, join(f.root, "hardlink"));
    refusesUnchanged(f, backend, target === "transcript" ? "sessionStore.invalidFile" : "sessionStore.invalidRecord");
  });

  it("rejects symlink sidecars", () => {
    const f = fixture(backend);
    renameSync(f.recordFile, `${f.recordFile}.saved`);
    symlinkSync(`${f.recordFile}.saved`, f.recordFile);
    refusesUnchanged(f, backend, "sessionStore.invalidRecord");
  });

  it.each(["transcript", "record"] as const)("bounds %s reads before allocating their contents", target => {
    const f = fixture(backend);
    const path = target === "transcript" ? f.file : f.recordFile;
    truncateSync(path, (target === "transcript" ? 64 : 4) * 1024 * 1024 + 1);
    const before = lstatSync(path);
    expect(() => inspectManagedSession(f.file, backend)).toThrow(i18n.t(target === "transcript" ? "sessionStore.invalidFile" : "sessionStore.invalidRecord"));
    const after = lstatSync(path);
    expect([after.ino, after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  });

  it("rechecks the sidecar after transcript parsing so a concurrent writer cannot publish a stale ready snapshot", () => {
    const f = fixture(backend);
    const inMemory = SessionManager.inMemory;
    vi.spyOn(SessionManager, "inMemory").mockImplementationOnce((...args) => {
      const manager = inMemory(...args);
      f.managed.beginRun("concurrent-transaction");
      return manager;
    });
    expect(() => inspectManagedSession(f.file, backend)).toThrow(i18n.t("sessionStore.invalidRecord"));
    expect(JSON.parse(readFileSync(f.recordFile, "utf8")).state).toBe("running");
    expect(existsSync(f.lock)).toBe(true);
  });
});

describe("managed backend branch observation ports", () => {
  it.each(["embedded", "terminal"] as const)("%s inspection works without runtime construction or writer acquisition", backend => {
    const f = fixture(backend);
    history(f.managed);
    f.managed.release();
    const createSession = vi.fn(() => { throw new Error("must not boot SDK"); });
    const subject = backend === "embedded"
      ? createManagedEmbeddedExecutionBackend({ agentDir: f.root }, { createSession })
      : createTerminalExecutionBackend();
    const before = diskSnapshot(f.root);
    expect(subject.inspect!(f.file)).toEqual(inspectManagedSession(f.file, backend));
    expect(createSession).not.toHaveBeenCalled();
    expect(diskSnapshot(f.root)).toEqual(before);
  });

  it("terminal handles expose only verified idle raw history, never a projected/wire branch", async () => {
    const f = fixture("terminal");
    const manager = history(f.managed);
    f.managed.release();
    const subject = createTerminalExecutionBackend();
    const handle = await subject.reattach!(f.managed.reference);
    const before = diskSnapshot(f.root);
    expect(handle.messages).toEqual(manager.buildSessionProjection().messages);
    expect(handle.getBranch!()).toEqual(manager.getBranch());
    expect(handle.getBranch!()).not.toEqual(handle.messages);
    expect(diskSnapshot(f.root)).toEqual(before);
    writeFileSync(f.file, readFileSync(f.file, "utf8") + "\n");
    expect(() => handle.getBranch!()).toThrow(i18n.t("sessionStore.invalidFile"));
    await expect(subject.shutdown(handle)).rejects.toThrow(i18n.t("sessionStore.invalidFile"));
    expect(() => handle.getBranch!()).toThrow(i18n.t("backend.closedSession"));
  });

  it("terminal raw branch reads reject while the child transaction is running", async () => {
    const f = fixture("terminal");
    f.managed.release();
    let feedback!: (value: ChildFeedback) => void;
    let created!: (handle: ExecutionSession) => void;
    let settle!: (value: Extract<ChildFeedback, { type: "settled" }>) => void;
    let exit!: (value: { reason: "sentinel"; exitCode: number }) => void;
    const ready = new Promise<ExecutionSession>(resolve => { created = resolve; });
    const settled = new Promise<Extract<ChildFeedback, { type: "settled" }>>(resolve => { settle = resolve; });
    const exited = new Promise<{ reason: "sentinel"; exitCode: number }>(resolve => { exit = resolve; });
    const snapshot: TerminalSnapshot = { messages: [], stats: { tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: null } } };
    const bridge: TerminalBridge = { endpoint: { host: "127.0.0.1", port: 1, token: "test-only" }, ready: Promise.resolve(snapshot), settled,
      start: () => {}, admit: () => {}, steer: async () => {}, interrupt: async () => {}, abort: () => {}, close: async () => {} };
    const subject = createTerminalExecutionBackend({ sessionDir: f.root, artifactDir: join(f.root, "runs") }, {
      bridge: async (_run, listener) => { feedback = listener; return bridge; },
      waitForExit: () => exited,
      dependencies: { transport: { createSurface: () => "fake", sendCommand: () => {}, sendEscape: () => {}, closeSurface: () => {}, waitForExit: () => exited },
        artifacts: { prepare: () => ({ byteOffset: 0 }), readSummary: () => "" }, now: Date.now, delay: async () => {} },
    });
    const ctx = { cwd: f.root, getSystemPrompt: () => "system", model: { provider: "faux", id: "model" },
      modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionContext;
    const operation = subject.run(ctx, "general-purpose", "task", { isolated: true,
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any, onSessionCreated: created });
    const handle = await ready;
    expect(() => handle.getBranch!()).toThrow(i18n.t("sessionStore.unsafe"));
    expect(() => subject.inspect!(handle.reference.sessionFile!)).toThrow(i18n.t("sessionStore.unsafe"));
    const manager = SessionManager.inMemory(f.root, undefined, readFileSync(handle.reference.sessionFile!, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)));
    const final = { type: "settled" as const, snapshot, text: "", aborted: false, witness: sessionWitness(manager) };
    feedback(final);
    settle(final);
    exit({ reason: "sentinel", exitCode: 0 });
    await operation;
    expect(handle.getBranch!()).toEqual(manager.getBranch());
    await subject.shutdown(handle);
  });
});
