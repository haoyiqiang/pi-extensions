import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { i18n } from "../i18n.js";
import type { EffectiveThinkingLevel } from "../types.js";
import type { ExecutionRestoreOptions, ExecutionSessionSnapshot } from "./types.js";
import type { ExecutionBackendKind, PersistentSessionReference } from "./session-reference.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";
import { compileInvocationSchema } from "./invocation-policy.js";
import { validateManagedPolicy, type ManagedPolicy } from "./managed-policy.js";
import { sessionWitness, type SessionWitness } from "./session-witness.js";
import { assertPromptBindingMatches, snapshotPromptBinding } from "./prompt-binding.js";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_POLICY_BYTES = 4 * 1024 * 1024;
const recordPath = (file: string) => `${file}.pi-subagents.json`;
const hash = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function fail(key: string): never { throw new Error(i18n.t(key)); }
interface Checkpoint extends SessionWitness { bytes: number }
interface PolicyRecord<K extends ExecutionBackendKind> {
  version: 1;
  reference: PersistentSessionReference<K>;
  policy: ManagedPolicy;
  state: "ready" | "running" | "quarantined";
  checkpoint: Checkpoint;
  runId?: string;
}

/** The backend exclusively creates a private v3 seed; the store then owns its lease and metadata. */
export type ManagedSessionSeed<K extends ExecutionBackendKind> = (policy: ManagedPolicy) => PersistentSessionReference<K>;

function sameFile(actual: Stats, expected: Stats): boolean {
  return actual.isFile() && actual.nlink === 1 && actual.dev === expected.dev && actual.ino === expected.ino
    && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}

function privateRead(path: string, max: number, key: string): Buffer {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) fail(key);
    fd = openSync(path, "r");
    const opened = fstatSync(fd);
    if (!sameFile(opened, stat)) fail(key);
    const raw = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < raw.length) {
      const read = readSync(fd, raw, length, raw.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length !== stat.size || !sameFile(fstatSync(fd), stat) || !sameFile(lstatSync(path), stat)) fail(key);
    return raw.subarray(0, length);
  } catch { return fail(key); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Strict v3 input before invoking Pi's tolerant parser. Never opens or migrates the source. */
function transcript(reference: PersistentSessionReference, policy: ManagedPolicy) {
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

function snapshotPolicy(value: unknown): ManagedPolicy {
  try {
    validateManagedPolicy(value);
    const policy: ManagedPolicy = {
      type: value.type, name: value.name, cwd: value.cwd,
      ...(value.promptBinding !== undefined ? { promptBinding: snapshotPromptBinding(value.promptBinding) } : {}),
      model: Object.freeze({ provider: value.model.provider, id: value.model.id }),
      ...(value.modelFingerprint !== undefined ? { modelFingerprint: value.modelFingerprint } : {}),
      ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
      tools: Object.freeze([...value.tools]), systemPrompt: value.systemPrompt,
      ...(value.structuredSchema !== undefined ? { structuredSchema: compileInvocationSchema(value.structuredSchema).schema } : {}),
      ...(value.maxTurns !== undefined ? { maxTurns: value.maxTurns, graceTurns: value.graceTurns } : {}),
    };
    return Object.freeze(policy);
  } catch { return fail("sessionStore.invalidRecord"); }
}

function validateReference(reference: PersistentSessionReference, expectedBackend: ExecutionBackendKind): void {
  if (!reference || (expectedBackend !== "terminal" && expectedBackend !== "embedded")
    || reference.backend !== expectedBackend || !text(reference.sessionId)
    || !text(reference.sessionFile) || !isAbsolute(reference.sessionFile)) fail("sessionStore.invalidRecord");
}

function parseRecord<K extends ExecutionBackendKind>(raw: Buffer, file: string, expectedBackend: K, sessionId?: string, requireReady = true): PolicyRecord<K> {
  let record: unknown;
  try { record = JSON.parse(raw.toString("utf8")); } catch { fail("sessionStore.invalidRecord"); }
  if (!object(record) || record.version !== 1 || !object(record.reference)) fail("sessionStore.invalidRecord");
  validateReference(record.reference as PersistentSessionReference, expectedBackend);
  if ((sessionId !== undefined && record.reference.sessionId !== sessionId)
    || record.reference.sessionFile !== file || !object(record.checkpoint)
    || (record.checkpoint.leafId !== null && typeof record.checkpoint.leafId !== "string")
    || !Number.isSafeInteger(record.checkpoint.entries) || record.checkpoint.entries < 0
    || !Number.isSafeInteger(record.checkpoint.bytes) || record.checkpoint.bytes < 0
    || typeof record.checkpoint.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.checkpoint.digest)) fail("sessionStore.invalidRecord");
  if (record.state !== "ready" && (requireReady || (record.state !== "running" && record.state !== "quarantined"))) fail("sessionStore.unsafe");
  return { ...record, policy: snapshotPolicy(record.policy) } as PolicyRecord<K>;
}

function readyTranscript(record: PolicyRecord<ExecutionBackendKind>) {
  const current = transcript(record.reference, record.policy);
  if (!isDeepStrictEqual(current.checkpoint, record.checkpoint)) fail("sessionStore.invalidFile");
  return current;
}

/** Inspect a bounded, ready managed snapshot without leases, SDK open/repair or source writes. */
export function inspectManagedSession(file: string, expectedBackend: ExecutionBackendKind): ExecutionSessionSnapshot {
  let canonical: string;
  try {
    if (!text(file) || !isAbsolute(file)) fail("sessionStore.invalidFile");
    canonical = realpathSync(file);
  } catch { return fail("sessionStore.invalidFile"); }
  const raw = privateRead(recordPath(canonical), MAX_POLICY_BYTES, "sessionStore.invalidRecord");
  const record = parseRecord(raw, canonical, expectedBackend);
  const current = readyTranscript(record);
  // A cooperating writer must reserve running state before changing the transcript.
  if (!privateRead(recordPath(canonical), MAX_POLICY_BYTES, "sessionStore.invalidRecord").equals(raw)) fail("sessionStore.invalidRecord");
  return Object.freeze({
    reference: Object.freeze({ backend: record.reference.backend, sessionId: record.reference.sessionId, sessionFile: canonical }),
    policy: record.policy,
    branch: Object.freeze(current.manager.getBranch()),
  });
}

function validateRestore(policy: ManagedPolicy, options: ExecutionRestoreOptions): void {
  assertPromptBindingMatches(policy.promptBinding, options.promptBinding);
  if (policy.structuredSchema === undefined) {
    if (options.structuredOutput !== undefined) fail("sessionStore.schemaMismatch");
    return;
  }
  if (!options.structuredOutput || typeof options.structuredOutput.check !== "function") fail("sessionStore.validatorRequired");
  const supplied = compileInvocationSchema(options.structuredOutput.schema);
  if (!isDeepStrictEqual(supplied.schema, policy.structuredSchema)) fail("sessionStore.schemaMismatch");
}

/** A lease covers the handle lifetime, not just its current invocation. No stale-lock stealing. */
export class ManagedSession<K extends ExecutionBackendKind> {
  readonly reference: PersistentSessionReference<K>;
  private record: PolicyRecord<K>;
  private expectedRecord: Buffer;
  private closed = false;
  private constructor(private readonly lease: SessionLease, record: PolicyRecord<K>, expectedRecord: Buffer) {
    this.reference = Object.freeze({ backend: record.reference.backend, sessionId: record.reference.sessionId, sessionFile: lease.sessionFile });
    this.record = record;
    this.expectedRecord = expectedRecord;
  }
  get policy(): ManagedPolicy { return this.record.policy; }

  static create<K extends ExecutionBackendKind>(policy: ManagedPolicy, createSeed: ManagedSessionSeed<K>, source?: ManagedSession<K>): ManagedSession<K> {
    const resolved = snapshotPolicy(policy);
    const sourceSnapshot = source?.readReady();
    const seed = createSeed(resolved);
    validateReference(seed, source?.reference.backend ?? seed?.backend);
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
      const record: PolicyRecord<K> = { version: 1, reference, policy: resolved, state: "ready", checkpoint };
      const raw = Buffer.from(JSON.stringify(record) + "\n");
      if (raw.length > MAX_POLICY_BYTES) fail("sessionStore.invalidRecord");
      writeFileSync(recordPath(reference.sessionFile), raw, { flag: "wx", mode: 0o600 });
      return new ManagedSession(lease, record, raw);
    } catch (error) {
      // The UUID transcript is ours. Leave unowned/colliding metadata untouched.
      if (lease) {
        try { lease.assertOwned(); rmSync(lease.sessionFile, { force: true }); lease.release(); }
        catch { /* retain artifacts if ownership cannot be proved */ }
      }
      throw error;
    }
  }

  static open<K extends ExecutionBackendKind>(reference: PersistentSessionReference, expectedBackend: K, options: ExecutionRestoreOptions = {}): ManagedSession<K> {
    validateReference(reference, expectedBackend);
    options = { ...options, promptBinding: snapshotPromptBinding(options.promptBinding) };
    let canonical: string;
    try { canonical = realpathSync(reference.sessionFile); } catch { return fail("sessionStore.invalidFile"); }
    // Reject incompatible identity before creating even a temporary writer lease.
    const before = privateRead(recordPath(canonical), MAX_POLICY_BYTES, "sessionStore.invalidRecord");
    // Leave running/quarantined ownership diagnostics unchanged for matching/unbound callers.
    const candidate = parseRecord(before, canonical, expectedBackend, reference.sessionId, false);
    assertPromptBindingMatches(candidate.policy.promptBinding, options.promptBinding);
    const lease = acquireSessionLease(canonical);
    try {
      const raw = privateRead(recordPath(lease.sessionFile), MAX_POLICY_BYTES, "sessionStore.invalidRecord");
      if (!raw.equals(before)) fail("sessionStore.invalidRecord");
      const record = parseRecord(raw, lease.sessionFile, expectedBackend, reference.sessionId);
      validateRestore(record.policy, options);
      const managed = new ManagedSession<K>(lease, record, raw);
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
    return readyTranscript(this.record);
  }
  private save(record: PolicyRecord<K>): void {
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
  fork(createSeed: ManagedSessionSeed<K>, options: ExecutionRestoreOptions = {}): ManagedSession<K> {
    this.readReady();
    validateRestore(this.policy, options);
    return ManagedSession.create(this.policy, createSeed, this);
  }
  release(): void {
    if (this.closed) return;
    // A dirty/crashed writer requires explicit future recovery, never mere owner-PID guessing.
    this.readReady();
    this.lease.release();
    this.closed = true;
  }
}
