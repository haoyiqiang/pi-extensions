/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Content-addressed archive design adapted from NVlabs/SoL-Pi.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export type SourceKind = "tool-output" | "full-log" | "preview";

export interface SourceArtifact {
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
  kind: SourceKind;
}

type ArchiveErrorCode =
  | "PI_DISTILL_ARCHIVE_INVALID_ARGUMENT"
  | "PI_DISTILL_ARCHIVE_INVALID_UTF8"
  | "PI_DISTILL_ARCHIVE_SOURCE_QUOTA"
  | "PI_DISTILL_ARCHIVE_SESSION_QUOTA"
  | "PI_DISTILL_ARCHIVE_BUSY"
  | "PI_DISTILL_ARCHIVE_INTEGRITY"
  | "PI_DISTILL_ARCHIVE_IO";

type ArchiveError = Error & { code: ArchiveErrorCode };
type FileIdentity = { dev: number | bigint; ino: number | bigint };

const LOCK_NAME = ".pi-distill-archive.lock";
const LOCK_OWNER_NAME = "owner";
const sessionLocks = new Map<string, Promise<void>>();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function failure(code: ArchiveErrorCode, cause?: unknown): ArchiveError {
  const error = new Error(code, cause === undefined ? undefined : { cause }) as ArchiveError;
  error.name = "DistillArchiveError";
  error.code = code;
  return error;
}

function isArchiveError(error: unknown): error is ArchiveError {
  return error instanceof Error && typeof (error as Partial<ArchiveError>).code === "string"
    && (error as Partial<ArchiveError>).code!.startsWith("PI_DISTILL_ARCHIVE_");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function sameIdentity(stats: FileIdentity, expected: FileIdentity): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

function identity(stats: FileIdentity): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function validateOptions(
  body: string,
  options: {
    agentDir: string;
    sessionId: string;
    kind: SourceKind;
    maxSourceBytes: number;
    maxSessionBytes: number;
  },
): void {
  if (!options || typeof body !== "string"
    || typeof options.agentDir !== "string" || options.agentDir.length === 0 || options.agentDir.includes("\0")
    || typeof options.sessionId !== "string" || options.sessionId.length === 0
    || !(["tool-output", "full-log", "preview"] as const).includes(options.kind)
    || !Number.isSafeInteger(options.maxSourceBytes) || options.maxSourceBytes <= 0
    || !Number.isSafeInteger(options.maxSessionBytes) || options.maxSessionBytes <= 0) {
    throw failure("PI_DISTILL_ARCHIVE_INVALID_ARGUMENT");
  }
}

async function waitForSessionTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (!signal) return previous;
  await new Promise<void>((resolveWait, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

async function withSessionLock<T>(key: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  sessionLocks.set(key, tail);
  try {
    await waitForSessionTurn(previous, signal);
    checkAbort(signal);
    return await action();
  } finally {
    release();
    // Cancelled waiters return immediately, but their tail must still depend on
    // the preceding writer. Removing it early would let later writers overtake.
    void tail.then(() => {
      if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
    });
  }
}

async function ensureDirectory(path: string, owned: boolean): Promise<void> {
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
  }
  if (!owned) return;

  await chmod(path, 0o700);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(after, before)) {
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
  }
}

async function prepareArchiveDirectories(agentDir: string, sessionHash: string): Promise<{
  sessionDir: string;
  objectsDir: string;
}> {
  const agentRoot = await realpath(resolve(agentDir));
  const rootStats = await lstat(agentRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
  }

  let current = agentRoot;
  for (const component of ["extensions", "pi-distill"] as const) {
    current = join(current, component);
    await ensureDirectory(current, false);
  }
  for (const component of ["artifacts", sessionHash] as const) {
    current = join(current, component);
    await ensureDirectory(current, true);
  }

  return { sessionDir: current, objectsDir: join(current, "objects") };
}

async function targetExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function readExact(handle: FileHandle, byteLength: number, signal?: AbortSignal): Promise<Buffer> {
  const actual = Buffer.alloc(byteLength + 1);
  let length = 0;
  while (length < actual.byteLength) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(actual, length, actual.byteLength - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  checkAbort(signal);
  return actual.subarray(0, length);
}

async function verifyExistingObject(
  path: string,
  expected: Buffer,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== expected.byteLength) {
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrno(error, "ELOOP")) throw failure("PI_DISTILL_ARCHIVE_INTEGRITY", error);
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, before) || opened.size !== expected.byteLength) {
      throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    }

    const actual = await readExact(handle, expected.byteLength, signal);
    const after = await handle.stat();
    const current = await lstat(path);
    if (actual.byteLength !== expected.byteLength
      || !sameIdentity(after, opened) || after.nlink !== 1
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !sameIdentity(current, opened)
      || !actual.equals(expected)
      || sha256(actual) !== expectedHash) {
      throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    }
  } finally {
    await handle.close();
  }
}

async function restoredSessionBytes(objectsDir: string, maxSessionBytes: number): Promise<number> {
  let total = 0;
  for (const entry of await readdir(objectsDir)) {
    const stats = await lstat(join(objectsDir, entry));
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    }
    if (!Number.isSafeInteger(stats.size) || stats.size > maxSessionBytes - total) {
      throw failure("PI_DISTILL_ARCHIVE_SESSION_QUOTA");
    }
    total += stats.size;
  }
  return total;
}

async function writeAll(handle: FileHandle, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    checkAbort(signal);
    const { bytesWritten } = await handle.write(bytes, offset, Math.min(64 * 1024, bytes.byteLength - offset), offset);
    if (bytesWritten <= 0) throw failure("PI_DISTILL_ARCHIVE_IO");
    offset += bytesWritten;
  }
}

async function ownedPathState(path: string, owned: FileIdentity): Promise<"owned" | "missing" | "foreign"> {
  try {
    const stats = await lstat(path);
    return !stats.isSymbolicLink() && stats.isFile() && sameIdentity(stats, owned) ? "owned" : "foreign";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function removeOwnedFile(path: string, owned: FileIdentity): Promise<"removed" | "missing" | "foreign"> {
  const state = await ownedPathState(path, owned);
  if (state !== "owned") return state;
  await unlink(path);
  return "removed";
}

type SessionFsLock = {
  lockDir: string;
  ownerPath: string;
  token: Buffer;
  directoryIdentity: FileIdentity;
  ownerIdentity: FileIdentity;
  ownerHandle: FileHandle;
};

async function acquireSessionFsLock(sessionDir: string): Promise<SessionFsLock> {
  const lockDir = join(sessionDir, LOCK_NAME);
  try {
    await mkdir(lockDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw failure("PI_DISTILL_ARCHIVE_BUSY", error);
    throw error;
  }

  const directoryStats = await lstat(lockDir);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
  }

  const ownerPath = join(lockDir, LOCK_OWNER_NAME);
  const token = Buffer.from(`${randomUUID()}\n`, "utf8");
  let ownerHandle: FileHandle;
  try {
    ownerHandle = await open(
      ownerPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    // A partially acquired or externally changed lock is deliberately left in
    // place. Stale locks require explicit user cleanup; no stealing heuristic.
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY", error);
  }

  try {
    await writeAll(ownerHandle, token);
    await ownerHandle.sync();
    const ownerStats = await ownerHandle.stat();
    if (!ownerStats.isFile() || ownerStats.nlink !== 1) {
      throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    }
    return {
      lockDir,
      ownerPath,
      token,
      directoryIdentity: identity(directoryStats),
      ownerIdentity: identity(ownerStats),
      ownerHandle,
    };
  } catch (error) {
    await ownerHandle.close();
    throw error;
  }
}

async function releaseSessionFsLock(lock: SessionFsLock): Promise<void> {
  let releaseAllowed = false;
  try {
    const directoryStats = await lstat(lock.lockDir);
    const ownerPathStats = await lstat(lock.ownerPath);
    const ownerHandleStats = await lock.ownerHandle.stat();
    const token = await readExact(lock.ownerHandle, lock.token.byteLength);
    releaseAllowed = !directoryStats.isSymbolicLink() && directoryStats.isDirectory()
      && sameIdentity(directoryStats, lock.directoryIdentity)
      && !ownerPathStats.isSymbolicLink() && ownerPathStats.isFile() && ownerPathStats.nlink === 1
      && sameIdentity(ownerPathStats, lock.ownerIdentity)
      && ownerHandleStats.isFile() && ownerHandleStats.nlink === 1
      && sameIdentity(ownerHandleStats, lock.ownerIdentity)
      && token.equals(lock.token);
  } catch {
    releaseAllowed = false;
  } finally {
    await lock.ownerHandle.close();
  }

  if (!releaseAllowed) throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");

  const removed = await removeOwnedFile(lock.ownerPath, lock.ownerIdentity);
  if (removed !== "removed") throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");

  const directoryStats = await lstat(lock.lockDir);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()
    || !sameIdentity(directoryStats, lock.directoryIdentity)) {
    throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
  }
  await rmdir(lock.lockDir);
}

async function withFilesystemLock<T>(sessionDir: string, action: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionFsLock(sessionDir);
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await action();
  } catch (error) {
    primaryError = error;
  }

  try {
    await releaseSessionFsLock(lock);
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }

  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

async function publishObject(
  stagingPath: string,
  objectPath: string,
  bytes: Buffer,
  bodyHash: string,
  signal?: AbortSignal,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      stagingPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    throw error;
  }

  let owned: FileIdentity | undefined;
  let primaryError: unknown;
  try {
    const created = await handle.stat();
    if (!created.isFile() || created.nlink !== 1) throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    owned = identity(created);

    await writeAll(handle, bytes, signal);
    await handle.sync();
    checkAbort(signal);

    const written = await handle.stat();
    const stagingStats = await lstat(stagingPath);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.byteLength || !sameIdentity(written, owned)
      || stagingStats.isSymbolicLink() || !stagingStats.isFile() || stagingStats.nlink !== 1
      || !sameIdentity(stagingStats, owned)) {
      throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    }

    try {
      await link(stagingPath, objectPath);
      const published = await lstat(objectPath);
      const linked = await handle.stat();
      if (published.isSymbolicLink() || !published.isFile() || !sameIdentity(published, owned)
        || !linked.isFile() || !sameIdentity(linked, owned) || linked.nlink !== 2) {
        throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      await verifyExistingObject(objectPath, bytes, bodyHash, signal);
    }
  } catch (error) {
    primaryError = error;
  }

  if (owned !== undefined) {
    try {
      const removed = await removeOwnedFile(stagingPath, owned);
      if (removed === "foreign") throw failure("PI_DISTILL_ARCHIVE_INTEGRITY");
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
  }

  try {
    await handle.close();
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }

  if (primaryError !== undefined) throw primaryError;
  await verifyExistingObject(objectPath, bytes, bodyHash, signal);
}

/**
 * Archive exact UTF-8 source bytes under session- and content-derived names.
 *
 * Session writes are serialized in-process and by a fail-fast filesystem lock.
 * A lock left by a crashed process intentionally remains fail-closed until the
 * user removes it; this code never waits, steals locks, or deletes stale files.
 */
export async function archiveSource(
  body: string,
  options: {
    agentDir: string;
    sessionId: string;
    kind: SourceKind;
    maxSourceBytes: number;
    maxSessionBytes: number;
    signal?: AbortSignal;
  },
): Promise<SourceArtifact> {
  const signal = options?.signal;
  try {
    validateOptions(body, options);
    checkAbort(options.signal);

    const byteLength = Buffer.byteLength(body, "utf8");
    if (byteLength > options.maxSourceBytes) throw failure("PI_DISTILL_ARCHIVE_SOURCE_QUOTA");
    if (byteLength > options.maxSessionBytes) throw failure("PI_DISTILL_ARCHIVE_SESSION_QUOTA");
    const encoded = Buffer.from(body, "utf8");
    if (encoded.toString("utf8") !== body) throw failure("PI_DISTILL_ARCHIVE_INVALID_UTF8");

    const sessionHash = sha256(options.sessionId);
    const bodyHash = sha256(encoded);
    const { sessionDir, objectsDir } = await prepareArchiveDirectories(options.agentDir, sessionHash);
    const objectPath = join(objectsDir, `${bodyHash}.txt`);
    const artifact: SourceArtifact = {
      path: objectPath,
      sha256: bodyHash,
      bytes: encoded.byteLength,
      lines: body.split("\n").length,
      kind: options.kind,
    };

    return await withSessionLock(sessionDir, options.signal, async () => withFilesystemLock(sessionDir, async () => {
      checkAbort(options.signal);
      await ensureDirectory(objectsDir, true);
      checkAbort(options.signal);

      const used = await restoredSessionBytes(objectsDir, options.maxSessionBytes);
      if (await targetExists(objectPath)) {
        await verifyExistingObject(objectPath, encoded, bodyHash, options.signal);
        return artifact;
      }

      if (encoded.byteLength > options.maxSessionBytes - used) {
        throw failure("PI_DISTILL_ARCHIVE_SESSION_QUOTA");
      }

      const stagingPath = join(objectsDir, `.pi-distill-stage-${randomUUID()}.tmp`);
      await publishObject(stagingPath, objectPath, encoded, bodyHash, options.signal);
      return artifact;
    }));
  } catch (error) {
    if (isArchiveError(error) || error === signal?.reason) throw error;
    throw failure("PI_DISTILL_ARCHIVE_IO", error);
  }
}
