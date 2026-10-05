import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSessionLease } from "../src/backends/session-lease.js";
import { i18n } from "../src/i18n.js";

// Keep real filesystem behavior, with configurable exports for narrow fault injection.
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

let directory: string;
let sessionFile: string;
let lockDirectory: string;
let ownerFile: string;

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-session-lease-")));
  sessionFile = join(directory, "session.jsonl");
  lockDirectory = `${sessionFile}.pi-subagents.lock`;
  ownerFile = join(lockDirectory, "owner.json");
  fs.writeFileSync(sessionFile, '{"type":"session","id":"test"}\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function owner(): { token: string; pid: number } {
  return JSON.parse(fs.readFileSync(ownerFile, "utf8"));
}

function expectLost(operation: () => void): void {
  expect(operation).toThrow(i18n.t("sessionStore.leaseLost"));
}

function childAttempt(leaveLocked = false): string {
  const moduleUrl = new URL("../src/backends/session-lease.ts", import.meta.url).href;
  const i18nUrl = new URL("../src/i18n.ts", import.meta.url).href;
  return execFileSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", `
      import { acquireSessionLease } from ${JSON.stringify(moduleUrl)};
      import { i18n } from ${JSON.stringify(i18nUrl)};
      try {
        const lease = acquireSessionLease(${JSON.stringify(sessionFile)});
        lease.assertOwned();
        if (!${leaveLocked}) lease.release();
        console.log("acquired");
      } catch (error) {
        if (error.message !== i18n.t("sessionStore.busy")) throw error;
        console.log("busy");
      }
    `,
  ], { encoding: "utf8", timeout: 10_000 }).trim();
}

describe("managed session leases", () => {
  it("uses private adjacent artifacts without rewriting the transcript", () => {
    const original = fs.readFileSync(sessionFile, "utf8");
    const lease = acquireSessionLease(sessionFile);
    expect(lease.sessionFile).toBe(fs.realpathSync(sessionFile));
    expect(fs.statSync(lockDirectory).isDirectory()).toBe(true);
    expect(owner()).toEqual({ token: expect.any(String), pid: process.pid });
    expect(owner().token).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(lockDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(ownerFile).mode & 0o777).toBe(0o600);
    }
    lease.assertOwned();
    fs.appendFileSync(sessionFile, '{"type":"message"}\n');
    lease.assertOwned();
    lease.release();
    expect(fs.existsSync(lockDirectory)).toBe(false);
    expect(fs.readFileSync(sessionFile, "utf8")).toBe(`${original}{"type":"message"}\n`);
  });

  it.each(["relative", "empty", "missing", "directory", "dangling symlink"])("rejects a %s session", (kind) => {
    const missing = join(directory, "missing.jsonl");
    const dangling = join(directory, "dangling.jsonl");
    if (kind === "dangling symlink") fs.symlinkSync(missing, dangling);
    const input = kind === "relative" ? "session.jsonl" : kind === "empty" ? ""
      : kind === "directory" ? directory : kind === "dangling symlink" ? dangling : missing;
    expect(() => acquireSessionLease(input)).toThrow(i18n.t("sessionStore.invalidFile"));
    expect(fs.existsSync(`${input}.pi-subagents.lock`)).toBe(false);
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("canonicalizes file symlinks, directory symlinks, and lexical aliases", () => {
    const fileAlias = join(directory, "alias.jsonl");
    const directoryAlias = join(directory, "alias-directory");
    fs.symlinkSync(sessionFile, fileAlias);
    fs.symlinkSync(directory, directoryAlias, "dir");
    fs.mkdirSync(join(directory, "nested"));
    const lease = acquireSessionLease(fileAlias);
    expect(lease.sessionFile).toBe(sessionFile);
    for (const alias of [sessionFile, fileAlias, join(directoryAlias, "session.jsonl"), `${directory}/nested/../session.jsonl`]) {
      expect(() => acquireSessionLease(alias)).toThrow(i18n.t("sessionStore.busy"));
    }
    expect(fs.existsSync(`${fileAlias}.pi-subagents.lock`)).toBe(false);
    lease.release();
    const next = acquireSessionLease(join(directoryAlias, "session.jsonl"));
    expect(next.sessionFile).toBe(sessionFile);
    next.release();
  });

  it("rejects every hardlink alias instead of granting separate locks", () => {
    const alias = join(directory, "hardlink.jsonl");
    fs.linkSync(sessionFile, alias);
    for (const path of [sessionFile, alias]) {
      expect(() => acquireSessionLease(path)).toThrow(i18n.t("sessionStore.invalidFile"));
      expect(fs.existsSync(`${path}.pi-subagents.lock`)).toBe(false);
    }
  });

  it("excludes competing instances and generates a fresh token after release", () => {
    const first = acquireSessionLease(sessionFile);
    const firstOwner = owner();
    expect(() => acquireSessionLease(sessionFile)).toThrow(i18n.t("sessionStore.busy"));
    expect(owner()).toEqual(firstOwner);
    first.assertOwned();
    first.release();
    const second = acquireSessionLease(sessionFile);
    expect(owner().token).not.toBe(firstOwner.token);
    // A successful release is permanently idempotent, including after reacquisition.
    first.release();
    first.release();
    expectLost(() => first.assertOwned());
    second.assertOwned();
    second.release();
  });

  it("proves cross-process exclusion and release without model or network access", () => {
    const lease = acquireSessionLease(sessionFile);
    expect(childAttempt()).toBe("busy");
    lease.assertOwned();
    lease.release();
    expect(childAttempt()).toBe("acquired");
    expect(fs.existsSync(lockDirectory)).toBe(false);
  }, 25_000);

  it("does not steal a lock after its owning process exits", () => {
    expect(childAttempt(true)).toBe("acquired");
    const previous = fs.readFileSync(ownerFile, "utf8");
    expect(owner().pid).not.toBe(process.pid);
    expect(() => acquireSessionLease(sessionFile)).toThrow(i18n.t("sessionStore.busy"));
    expect(fs.readFileSync(ownerFile, "utf8")).toBe(previous);
  }, 15_000);

  it.each(["empty directory", "malformed owner", "file", "symlink"])("never cleans up a preexisting %s lock", (kind) => {
    if (kind === "file") fs.writeFileSync(lockDirectory, "foreign lock");
    else if (kind === "symlink") fs.symlinkSync(directory, lockDirectory, "dir");
    else {
      fs.mkdirSync(lockDirectory);
      if (kind === "malformed owner") fs.writeFileSync(ownerFile, "incomplete");
    }
    const previous = fs.lstatSync(lockDirectory);
    expect(() => acquireSessionLease(sessionFile)).toThrow(i18n.t("sessionStore.busy"));
    expect(fs.lstatSync(lockDirectory).ino).toBe(previous.ino);
    if (kind === "malformed owner") expect(fs.readFileSync(ownerFile, "utf8")).toBe("incomplete");
  });

  it("uses the token rather than the diagnostic PID as proof of ownership", () => {
    const lease = acquireSessionLease(sessionFile);
    fs.writeFileSync(ownerFile, JSON.stringify({ ...owner(), pid: -1 }));
    lease.assertOwned();
    lease.release();
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it.each(["token", "malformed", "missing", "owner inode", "owner symlink", "owner hardlink"])("detects %s replacement without deleting foreign artifacts", (kind) => {
    const lease = acquireSessionLease(sessionFile);
    const original = fs.readFileSync(ownerFile, "utf8");
    const moved = join(directory, "original-owner.json");
    if (kind === "token") fs.writeFileSync(ownerFile, JSON.stringify({ ...owner(), token: "another-owner" }));
    if (kind === "malformed") fs.writeFileSync(ownerFile, "{");
    if (kind === "missing") fs.unlinkSync(ownerFile);
    if (kind === "owner inode" || kind === "owner symlink") {
      fs.renameSync(ownerFile, moved);
      if (kind === "owner inode") fs.writeFileSync(ownerFile, original);
      else fs.symlinkSync(moved, ownerFile);
    }
    if (kind === "owner hardlink") fs.linkSync(ownerFile, moved);
    const expected = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, "utf8") : undefined;
    expectLost(() => lease.assertOwned());
    expectLost(() => lease.release());
    expectLost(() => lease.release());
    expect(fs.existsSync(lockDirectory)).toBe(true);
    if (expected !== undefined) expect(fs.readFileSync(ownerFile, "utf8")).toBe(expected);
  });

  it.each(["new directory", "symlink"])("rejects a lock replaced by a %s even with an identical token", (kind) => {
    const lease = acquireSessionLease(sessionFile);
    const original = fs.readFileSync(ownerFile, "utf8");
    const moved = `${lockDirectory}.original`;
    fs.renameSync(lockDirectory, moved);
    if (kind === "symlink") fs.symlinkSync(moved, lockDirectory, "dir");
    else {
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(ownerFile, original);
    }
    expectLost(() => lease.assertOwned());
    expectLost(() => lease.release());
    expect(fs.readFileSync(ownerFile, "utf8")).toBe(original);
    expect(fs.readFileSync(join(moved, "owner.json"), "utf8")).toBe(original);
  });

  it.each(["replaced", "removed", "symlink", "directory", "hardlinked"])("releases its own lock even when the transcript is %s", (kind) => {
    const lease = acquireSessionLease(sessionFile);
    const moved = join(directory, "old-session.jsonl");
    if (kind === "hardlinked") fs.linkSync(sessionFile, moved);
    else {
      fs.renameSync(sessionFile, moved);
      if (kind === "replaced") fs.writeFileSync(sessionFile, "new session\n");
      if (kind === "symlink") fs.symlinkSync(moved, sessionFile);
      if (kind === "directory") fs.mkdirSync(sessionFile);
    }
    expectLost(() => lease.assertOwned());
    lease.release();
    lease.release();
    expect(fs.existsSync(lockDirectory)).toBe(false);
    expect(fs.existsSync(moved)).toBe(true);
    if (kind === "replaced") expect(fs.readFileSync(sessionFile, "utf8")).toBe("new session\n");
  });

  it("does not recursively delete unexpected contents and can retry its own directory cleanup", () => {
    const lease = acquireSessionLease(sessionFile);
    const unexpected = join(lockDirectory, "foreign-data");
    fs.writeFileSync(unexpected, "preserve");
    expect(() => lease.release()).toThrow();
    expect(fs.readFileSync(unexpected, "utf8")).toBe("preserve");
    expect(fs.existsSync(ownerFile)).toBe(false);
    expectLost(() => lease.assertOwned());
    fs.unlinkSync(unexpected);
    lease.release();
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("does not remove a new owner when retrying an incomplete release", () => {
    const lease = acquireSessionLease(sessionFile);
    const unexpected = join(lockDirectory, "foreign-data");
    fs.writeFileSync(unexpected, "preserve");
    expect(() => lease.release()).toThrow();
    fs.unlinkSync(unexpected);
    fs.writeFileSync(ownerFile, "foreign owner");
    expectLost(() => lease.release());
    expect(fs.readFileSync(ownerFile, "utf8")).toBe("foreign owner");
  });

  it("cleans its own empty directory if exclusive owner creation fails", () => {
    const failure = new Error("injected exclusive open failure");
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => { throw failure; });
    expect(() => acquireSessionLease(sessionFile)).toThrow(failure);
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("preserves an owner file it did not exclusively create", () => {
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((path, flags, mode) => {
      fs.writeFileSync(ownerFile, "foreign owner");
      return open(path, flags, mode);
    });
    expect(() => acquireSessionLease(sessionFile)).toThrow();
    expect(fs.readFileSync(ownerFile, "utf8")).toBe("foreign owner");
  });

  it("rechecks transcript identity before returning a new lease", () => {
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((path, content) => {
      write(path, content);
      fs.renameSync(sessionFile, join(directory, "original-session.jsonl"));
      write(sessionFile, "replaced");
    });
    expectLost(() => acquireSessionLease(sessionFile));
    expect(fs.existsSync(lockDirectory)).toBe(false);
    expect(fs.readFileSync(sessionFile, "utf8")).toBe("replaced");
  });

  it.each(["empty", "partial", "complete"])("cleans only its own %s owner write after acquisition fails", (kind) => {
    const write = fs.writeFileSync;
    const failure = new Error("injected owner write failure");
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((path, content) => {
      if (kind !== "empty") write(path, kind === "partial" ? String(content).slice(0, 12) : content);
      throw failure;
    });
    expect(() => acquireSessionLease(sessionFile)).toThrow(failure);
    expect(fs.existsSync(lockDirectory)).toBe(false);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("preserves a foreign owner inserted during failed acquisition", () => {
    const write = fs.writeFileSync;
    const failure = new Error("injected owner write failure");
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((path) => {
      write(path, '{"token":"foreign-owner"}\n');
      throw failure;
    });
    expect(() => acquireSessionLease(sessionFile)).toThrow(failure);
    expect(fs.readFileSync(ownerFile, "utf8")).toBe('{"token":"foreign-owner"}\n');
  });

  it("preserves a lock directory replaced during failed acquisition", () => {
    const write = fs.writeFileSync;
    const moved = `${lockDirectory}.original`;
    const failure = new Error("injected owner write failure");
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      fs.renameSync(lockDirectory, moved);
      fs.mkdirSync(lockDirectory);
      write(ownerFile, "foreign owner");
      throw failure;
    });
    expect(() => acquireSessionLease(sessionFile)).toThrow(failure);
    expect(fs.readFileSync(ownerFile, "utf8")).toBe("foreign owner");
    expect(fs.existsSync(join(moved, "owner.json"))).toBe(true);
  });
});
