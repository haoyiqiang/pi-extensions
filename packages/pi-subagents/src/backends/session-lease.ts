import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { i18n } from "../i18n.js";

export interface SessionLease {
  readonly sessionFile: string;
  assertOwned(): void;
  release(): void;
}

type Identity = Pick<Stats, "dev" | "ino">;

function sameIdentity(actual: Identity, expected: Identity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function leaseLost(): Error {
  return new Error(i18n.t("sessionStore.leaseLost"));
}

/**
 * A same-user cooperation protocol, not an OS sandbox against filesystem mutation.
 * Existing locks are never stolen, even when their diagnostic PID has exited.
 */
export function acquireSessionLease(sessionFile: string): SessionLease {
  let canonical: string;
  let fileIdentity: Stats;
  try {
    if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) throw new Error();
    canonical = realpathSync(sessionFile);
    fileIdentity = lstatSync(canonical);
    if (!fileIdentity.isFile() || fileIdentity.nlink !== 1) throw new Error();
  } catch (cause) {
    throw new Error(i18n.t("sessionStore.invalidFile"), { cause });
  }

  const lockDirectory = `${canonical}.pi-subagents.lock`;
  const ownerFile = join(lockDirectory, "owner.json");
  const token = randomUUID();
  // The PID is diagnostic only: the token, not process liveness, proves ownership.
  const ownerContent = `${JSON.stringify({ token, pid: process.pid })}\n`;
  let lockIdentity: Stats | undefined;
  let ownerIdentity: Stats | undefined;
  let ownerRemoved = false;
  let released = false;

  function ownsDirectory(): boolean {
    try {
      const current = lstatSync(lockDirectory);
      return lockIdentity !== undefined && current.isDirectory() && sameIdentity(current, lockIdentity);
    } catch {
      return false;
    }
  }

  function readOwnOwner(): string | undefined {
    try {
      const current = lstatSync(ownerFile);
      if (!ownerIdentity || !current.isFile() || current.nlink !== 1 || !sameIdentity(current, ownerIdentity)) {
        return undefined;
      }
      const content = readFileSync(ownerFile, "utf8");
      if (!sameIdentity(lstatSync(ownerFile), ownerIdentity) || !ownsDirectory()) return undefined;
      return content;
    } catch {
      return undefined;
    }
  }

  function ownsLock(): boolean {
    if (!ownsDirectory()) return false;
    const content = readOwnOwner();
    if (content === undefined) return false;
    try {
      const owner: unknown = JSON.parse(content);
      return owner !== null && typeof owner === "object" && "token" in owner && owner.token === token;
    } catch {
      return false;
    }
  }

  function assertOwned(): void {
    if (released || ownerRemoved || !ownsLock()) throw leaseLost();
    try {
      const current = lstatSync(canonical);
      if (current.isFile() && current.nlink === 1 && sameIdentity(current, fileIdentity)) return;
    } catch {
      // Missing or inaccessible transcripts also invalidate ownership.
    }
    throw leaseLost();
  }

  function release(): void {
    if (released) return;
    if (!ownerRemoved) {
      if (!ownsLock()) throw leaseLost();
      // Transcript identity is deliberately irrelevant when releasing our own lock.
      unlinkSync(ownerFile);
      ownerRemoved = true;
    }
    if (!ownsDirectory()) throw leaseLost();
    try {
      lstatSync(ownerFile);
      throw leaseLost();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Never recursively delete: unexpected contents must survive a failed release.
    rmdirSync(lockDirectory);
    released = true;
  }

  try {
    mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(i18n.t("sessionStore.busy"), { cause: error });
    }
    throw error;
  }

  try {
    lockIdentity = lstatSync(lockDirectory);
    if (!lockIdentity.isDirectory()) throw leaseLost();
    const descriptor = openSync(ownerFile, "wx", 0o600);
    try {
      ownerIdentity = fstatSync(descriptor);
      writeFileSync(descriptor, ownerContent, "utf8");
    } finally {
      closeSync(descriptor);
    }
    assertOwned();
  } catch (error) {
    // An exclusive open plus inode checks can identify our own partial write.
    // If identity/content changed, leave the artifacts for explicit recovery.
    try {
      if (ownsDirectory()) {
        const content = readOwnOwner();
        if (content !== undefined && ownerContent.startsWith(content)) unlinkSync(ownerFile);
        if (ownsDirectory()) rmdirSync(lockDirectory);
      }
    } catch {
      // Keep the original acquisition error, and never broaden cleanup to rm -r.
    }
    throw error;
  }

  return Object.freeze({ sessionFile: canonical, assertOwned, release });
}
