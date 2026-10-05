import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { i18n } from "../../i18n.js";
import type { EffectiveThinkingLevel } from "../../types.js";
import type { ExecutionRestoreOptions } from "../types.js";
import type { PersistentSessionReference } from "../session-reference.js";
import { acquireSessionLease, type SessionLease } from "../session-lease.js";
import { compileTerminalSchema } from "./run-policy.js";
import { createTerminalSession, validatePolicy, type TerminalBackendConfig, type TerminalPolicy } from "./prepare.js";
import { sessionWitness, type SessionWitness } from "./session-witness.js";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_POLICY_BYTES = 4 * 1024 * 1024;
const recordPath = (file: string) => `${file}.pi-subagents.json`;
const hash = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function fail(key: string): never { throw new Error(i18n.t(key)); }
interface Checkpoint extends SessionWitness { bytes: number }
interface PolicyRecord {
  version: 1;
  reference: PersistentSessionReference<"terminal">;
  policy: TerminalPolicy;
  state: "ready" | "running" | "quarantined";
  checkpoint: Checkpoint;
  runId?: string;
}

function privateRead(path: string, max: number, key: string): Buffer {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) fail(key);
    fd = openSync(path, "r");
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail(key);
    const raw = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < raw.length) {
      const read = readSync(fd, raw, length, raw.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length !== stat.size || fstatSync(fd).size !== stat.size) fail(key);
    return raw.subarray(0, length);
  } catch { return fail(key); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Strict v3 input before invoking Pi's tolerant parser. Never opens or migrates the source. */
function transcript(reference: PersistentSessionReference<"terminal">, policy: TerminalPolicy) {
  const raw = privateRead(reference.sessionFile, MAX_TRANSCRIPT_BYTES, "sessionStore.invalidFile");
  try {
    if (!raw.length || raw.at(-1) !== 10) fail("sessionStore.invalidFile");
    const lines = raw.toString("utf8").slice(0, -1).split("\n");
    const entries: unknown[] = lines.map((line) => JSON.parse(line));
    const header = entries[0];
    if (!object(header) || header.type !== "session" || header.version !== 3 || header.id !== reference.sessionId
      || !text(header.timestamp) || !text(header.cwd) || resolve(header.cwd) !== resolve(policy.cwd)) fail("sessionStore.invalidFile");
    const ids = new Set<string>();
    for (const entry of entries.slice(1)) {
      if (!object(entry) || !text(entry.type) || entry.type === "session" || !text(entry.id) || ids.has(entry.id)
        || !text(entry.timestamp) || (entry.parentId !== null && (!text(entry.parentId) || !ids.has(entry.parentId)))) fail("sessionStore.invalidFile");
      if (entry.type === "message" && (!object(entry.message) || !text(entry.message.role))) fail("sessionStore.invalidFile");
      ids.add(entry.id);
    }
    const manager = SessionManager.inMemory(policy.cwd, undefined, entries as FileEntry[]);
    // Force projection validation while the source is still only an in-memory snapshot.
    manager.buildSessionProjection();
    return { raw, manager, checkpoint: { ...sessionWitness(manager), bytes: raw.length, digest: hash(raw) } };
  } catch { return fail("sessionStore.invalidFile"); }
}

function snapshotPolicy(value: unknown): TerminalPolicy {
  try {
    validatePolicy(value);
    const policy: TerminalPolicy = {
      type: value.type, name: value.name, cwd: value.cwd,
      model: Object.freeze({ provider: value.model.provider, id: value.model.id }),
      ...(value.modelFingerprint !== undefined ? { modelFingerprint: value.modelFingerprint } : {}),
      ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
      tools: Object.freeze([...value.tools]), systemPrompt: value.systemPrompt,
      ...(value.structuredSchema !== undefined ? { structuredSchema: compileTerminalSchema(value.structuredSchema).schema } : {}),
      ...(value.maxTurns !== undefined ? { maxTurns: value.maxTurns, graceTurns: value.graceTurns } : {}),
    };
    return Object.freeze(policy);
  } catch { return fail("sessionStore.invalidRecord"); }
}

function validateRestore(policy: TerminalPolicy, options: ExecutionRestoreOptions): void {
  if (policy.structuredSchema === undefined) {
    if (options.structuredOutput !== undefined) fail("sessionStore.schemaMismatch");
    return;
  }
  if (!options.structuredOutput || typeof options.structuredOutput.check !== "function") fail("sessionStore.validatorRequired");
  const supplied = compileTerminalSchema(options.structuredOutput.schema);
  if (!isDeepStrictEqual(supplied.schema, policy.structuredSchema)) fail("sessionStore.schemaMismatch");
}

/** A lease covers the handle lifetime, not just its current subprocess. No stale-lock stealing. */
export class ManagedTerminalSession {
  readonly reference: PersistentSessionReference<"terminal">;
  private record: PolicyRecord;
  private expectedRecord: Buffer;
  private closed = false;
  private constructor(private readonly lease: SessionLease, record: PolicyRecord, expectedRecord: Buffer) {
    this.reference = Object.freeze({ backend: "terminal", sessionId: record.reference.sessionId, sessionFile: lease.sessionFile });
    this.record = record;
    this.expectedRecord = expectedRecord;
  }
  get policy(): TerminalPolicy { return this.record.policy; }

  static create(policy: TerminalPolicy, config: TerminalBackendConfig, source?: ManagedTerminalSession): ManagedTerminalSession {
    const resolved = snapshotPolicy(policy);
    const sourceSnapshot = source?.readReady();
    const seed = createTerminalSession(resolved, config);
    let lease: SessionLease | undefined;
    try {
      lease = acquireSessionLease(seed.sessionFile);
      const reference = { ...seed, sessionFile: lease.sessionFile };
      if (sourceSnapshot) {
        // Keep raw active-branch entries, including system checkpoints, context edits and opaque metadata.
        const fork = SessionManager.inMemory(resolved.cwd, { id: reference.sessionId, parentSession: source!.reference.sessionFile }, sourceSnapshot.manager.getBranch());
        const contents = [fork.getHeader(), ...fork.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
        writeFileSync(reference.sessionFile, contents, { mode: 0o600 });
      }
      lease.assertOwned();
      const checkpoint = transcript(reference, resolved).checkpoint;
      const record: PolicyRecord = { version: 1, reference, policy: resolved, state: "ready", checkpoint };
      const raw = Buffer.from(JSON.stringify(record) + "\n");
      if (raw.length > MAX_POLICY_BYTES) fail("sessionStore.invalidRecord");
      writeFileSync(recordPath(reference.sessionFile), raw, { flag: "wx", mode: 0o600 });
      return new ManagedTerminalSession(lease, record, raw);
    } catch (error) {
      // The UUID transcript is ours. Leave unowned/colliding metadata untouched.
      if (lease) {
        try { lease.assertOwned(); rmSync(lease.sessionFile, { force: true }); lease.release(); }
        catch { /* retain artifacts if ownership cannot be proved */ }
      }
      throw error;
    }
  }

  static open(reference: PersistentSessionReference, options: ExecutionRestoreOptions = {}): ManagedTerminalSession {
    if (!reference || reference.backend !== "terminal" || !text(reference.sessionId)
      || !text(reference.sessionFile) || !isAbsolute(reference.sessionFile)) fail("sessionStore.invalidRecord");
    const lease = acquireSessionLease(reference.sessionFile);
    try {
      const raw = privateRead(recordPath(lease.sessionFile), MAX_POLICY_BYTES, "sessionStore.invalidRecord");
      let record: unknown;
      try { record = JSON.parse(raw.toString("utf8")); } catch { fail("sessionStore.invalidRecord"); }
      if (!object(record) || record.version !== 1 || !object(record.reference)
        || record.reference.backend !== "terminal" || record.reference.sessionId !== reference.sessionId
        || record.reference.sessionFile !== lease.sessionFile || !object(record.checkpoint)
        || (record.checkpoint.leafId !== null && typeof record.checkpoint.leafId !== "string")
        || !Number.isSafeInteger(record.checkpoint.entries) || record.checkpoint.entries < 0
        || !Number.isSafeInteger(record.checkpoint.bytes) || record.checkpoint.bytes < 0
        || typeof record.checkpoint.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.checkpoint.digest)) fail("sessionStore.invalidRecord");
      if (record.state !== "ready") fail("sessionStore.unsafe");
      const policy = snapshotPolicy(record.policy);
      validateRestore(policy, options);
      const managed = new ManagedTerminalSession(lease, { ...record, policy } as PolicyRecord, raw);
      managed.readReady();
      return managed;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private assertRecord(): void {
    if (this.closed) fail("sessionStore.leaseLost");
    this.lease.assertOwned();
    if (!privateRead(recordPath(this.reference.sessionFile), MAX_POLICY_BYTES, "sessionStore.invalidRecord").equals(this.expectedRecord)) fail("sessionStore.invalidRecord");
  }
  readReady() {
    this.assertRecord();
    if (this.record.state !== "ready") fail("sessionStore.unsafe");
    const current = transcript(this.reference, this.policy);
    if (!isDeepStrictEqual(current.checkpoint, this.record.checkpoint)) fail("sessionStore.invalidFile");
    return current;
  }
  private save(record: PolicyRecord): void {
    this.assertRecord();
    const raw = Buffer.from(JSON.stringify(record) + "\n");
    if (raw.length > MAX_POLICY_BYTES) fail("sessionStore.invalidRecord");
    const temporary = `${recordPath(this.reference.sessionFile)}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(temporary, "wx", 0o600);
      created = true;
      writeFileSync(fd, raw);
      closeSync(fd);
      fd = undefined;
      this.lease.assertOwned();
      renameSync(temporary, recordPath(this.reference.sessionFile));
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) rmSync(temporary, { force: true });
    }
    this.record = record;
    this.expectedRecord = raw;
  }
  beginRun(runId: string): void {
    this.readReady();
    if (!text(runId)) fail("sessionStore.invalidRecord");
    this.save({ ...this.record, state: "running", runId });
  }
  checkpoint(thinkingLevel?: EffectiveThinkingLevel, witness?: SessionWitness): void {
    this.assertRecord();
    if (this.record.state !== "running") fail("sessionStore.unsafe");
    const current = transcript(this.reference, this.policy);
    const before = this.record.checkpoint;
    if (!witness || !isDeepStrictEqual(witness, sessionWitness(current.manager)) || witness.digest !== current.checkpoint.digest) fail("sessionStore.invalidFile");
    if (current.raw.length < before.bytes || hash(current.raw.subarray(0, before.bytes)) !== before.digest) fail("sessionStore.invalidFile");
    const policy = snapshotPolicy({ ...this.policy, thinkingLevel: thinkingLevel ?? this.policy.thinkingLevel });
    this.save({ version: 1, reference: this.reference, policy, state: "ready", checkpoint: current.checkpoint });
  }
  quarantine(): void {
    try { this.save({ ...this.record, state: "quarantined" }); } catch { /* never release uncertain ownership */ }
  }
  fork(config: TerminalBackendConfig, options: ExecutionRestoreOptions = {}): ManagedTerminalSession {
    this.readReady();
    validateRestore(this.policy, options);
    return ManagedTerminalSession.create(this.policy, config, this);
  }
  release(): void {
    if (this.closed) return;
    // A dirty/crashed writer requires explicit future recovery, never mere owner-PID guessing.
    this.readReady();
    this.lease.release();
    this.closed = true;
  }
}
