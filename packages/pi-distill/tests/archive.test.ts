import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { archiveSource, type SourceKind } from "../src/archive.ts";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

async function temporary<T>(action: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-distill-archive-"));
  try {
    return await action(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

function options(agentDir: string, sessionId = "session-1", kind: SourceKind = "tool-output") {
  return {
    agentDir,
    sessionId,
    kind,
    maxSourceBytes: 1024 * 1024,
    maxSessionBytes: 4 * 1024 * 1024,
  };
}

function errorCode(reason: unknown): unknown {
  return reason && typeof reason === "object" ? (reason as { code?: unknown }).code : undefined;
}

async function directorySymlinkOrSkip(t: TestContext, target: string, path: string, type: "dir" | "file" = "dir"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && errorCode(error) === "EPERM") {
      t.skip("directory symlinks require permission on this Win32 host");
      return false;
    }
    throw error;
  }
}

function childMessage(child: ChildProcess, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`archive child exited ${code}`));
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function waitForLockDirectory(sessionDir: string): Promise<() => void> {
  let watcher!: ReturnType<typeof watch>;
  await new Promise<void>((resolveWait, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("archive lock observation timed out")), 10000);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); watcher?.close(); reject(error);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); resolveWait();
    };
    try {
      watcher = watch(sessionDir, (_event, filename) => {
        if (filename?.toString() === ".pi-distill-archive.lock") finish();
      });
      watcher.once("error", fail);
      void lstat(join(sessionDir, ".pi-distill-archive.lock")).then(finish, (error: unknown) => {
        if (errorCode(error) !== "ENOENT") fail(error);
      });
    } catch (error) { fail(error); }
  });
  return () => watcher.close();
}

test("archives exact UTF-8 and CRLF bytes with native-read line semantics", async () => {
  await temporary(async (agentDir) => {
    const body = "开头\r\nsecond\n尾部\n";
    const artifact = await archiveSource(body, options(agentDir, "utf8-session", "full-log"));

    assert.equal(await readFile(artifact.path, "utf8"), body);
    assert.equal(artifact.sha256, sha256(body));
    assert.equal(artifact.bytes, Buffer.byteLength(body, "utf8"));
    assert.equal(artifact.lines, body.split("\n").length);
    assert.equal(artifact.lines, 4, "the trailing newline contributes an empty native-read line");
    assert.equal(artifact.kind, "full-log");
    if (process.platform !== "win32") {
      assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(artifact.path))).mode & 0o777, 0o700);
    }
    assert.ok((await readdir(dirname(artifact.path))).every((name) => !name.startsWith(".pi-distill-stage-")));

    const read = createReadToolDefinition(agentDir);
    const tail = await read.execute(
      "archive-tail",
      { path: artifact.path, offset: artifact.lines - 1, limit: 2 },
      undefined,
      undefined,
      { cwd: agentDir } as Parameters<typeof read.execute>[4],
    );
    assert.match(JSON.stringify(tail.content), /尾部/);

    const empty = await archiveSource("", options(agentDir, "empty-session", "preview"));
    assert.equal(empty.lines, "".split("\n").length);
    assert.equal(empty.lines, 1);
  });
});

test("deduplicates by content while checking the existing object", async () => {
  await temporary(async (agentDir) => {
    const body = "same body\n";
    const first = await archiveSource(body, options(agentDir));
    const second = await archiveSource(body, options(agentDir, "session-1", "preview"));

    assert.equal(second.path, first.path);
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.kind, "preview");
    assert.deepEqual(await readdir(dirname(first.path)), [`${sha256(body)}.txt`]);
    assert.equal(await readFile(first.path, "utf8"), body);
  });
});

test("rejects a corrupt existing object without deleting it", async () => {
  await temporary(async (agentDir) => {
    const body = "trusted source";
    const artifact = await archiveSource(body, options(agentDir, "tamper-session"));
    await writeFile(artifact.path, "tampered", { mode: 0o600 });

    await assert.rejects(
      archiveSource(body, options(agentDir, "tamper-session")),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY",
    );
    assert.equal(await readFile(artifact.path, "utf8"), "tampered");
  });
});

test("rejects a symlink object target without following or replacing it", async (t) => {
  await temporary(async (agentDir) => {
    const body = "symlink source";
    const sessionId = "symlink-session";
    const objectsDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId), "objects");
    const outside = join(agentDir, "outside.txt");
    const target = join(objectsDir, `${sha256(body)}.txt`);
    await mkdir(objectsDir, { recursive: true, mode: 0o700 });
    await writeFile(outside, "outside", { mode: 0o600 });
    if (!await directorySymlinkOrSkip(t, outside, target, "file")) return;

    await assert.rejects(
      archiveSource(body, options(agentDir, sessionId)),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY",
    );
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.equal(await readlink(target), outside);
    assert.equal(await readFile(outside, "utf8"), "outside");
  });
});

test("serializes concurrent session quota checks", async () => {
  await temporary(async (agentDir) => {
    const limited = { ...options(agentDir, "concurrent-session"), maxSourceBytes: 10, maxSessionBytes: 10 };
    const settled = await Promise.allSettled([
      archiveSource("aaaaaa", limited),
      archiveSource("bbbbbb", limited),
    ]);

    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(errorCode(rejected?.reason), "PI_DISTILL_ARCHIVE_SESSION_QUOTA");

    const objectsDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256("concurrent-session"), "objects");
    const names = await readdir(objectsDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^[a-f0-9]{64}\.txt$/);
  });
});

test("counts objects restored on disk when enforcing the session quota", async () => {
  await temporary(async (agentDir) => {
    const restored = await archiveSource("123456", {
      ...options(agentDir, "restart-session"),
      maxSourceBytes: 10,
      maxSessionBytes: 20,
    });

    await assert.rejects(
      archiveSource("abcdef", {
        ...options(agentDir, "restart-session"),
        maxSourceBytes: 10,
        maxSessionBytes: 10,
      }),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_SESSION_QUOTA",
    );
    assert.equal(await readFile(restored.path, "utf8"), "123456");
    assert.deepEqual(await readdir(dirname(restored.path)), [`${sha256("123456")}.txt`]);
  });
});

test("honors abort before publication and leaves no staging file", async () => {
  await temporary(async (agentDir) => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      archiveSource("never publish", { ...options(agentDir, "abort-session"), signal: controller.signal }),
      (error) => error === controller.signal.reason,
    );

    const artifacts = join(agentDir, "extensions", "pi-distill", "artifacts");
    await assert.rejects(readdir(artifacts), (error: unknown) => errorCode(error) === "ENOENT");
  });
});

test("hashes traversal-shaped session IDs instead of using them as paths", async () => {
  await temporary(async (agentDir) => {
    const sessionId = "../../../../escape";
    const artifact = await archiveSource("contained", options(agentDir, sessionId));
    const artifacts = join(await realpath(agentDir), "extensions", "pi-distill", "artifacts");
    const expectedSessionDir = join(artifacts, sha256(sessionId));

    assert.equal(dirname(dirname(artifact.path)), expectedSessionDir);
    assert.equal(basename(dirname(dirname(artifact.path))), sha256(sessionId));
    assert.ok(!relative(artifacts, artifact.path).startsWith(".."));
    assert.equal(await readFile(artifact.path, "utf8"), "contained");
    await assert.rejects(stat(join(agentDir, "escape")), (error: unknown) => errorCode(error) === "ENOENT");
  });
});

test("validates session IDs and byte budgets with stable internal codes", async () => {
  await temporary(async (agentDir) => {
    await assert.rejects(
      archiveSource("x", options(agentDir, "")),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INVALID_ARGUMENT",
    );
    await assert.rejects(
      archiveSource("x", { ...options(agentDir), maxSourceBytes: 0 }),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INVALID_ARGUMENT",
    );
    await assert.rejects(
      archiveSource("é", { ...options(agentDir), maxSourceBytes: 1 }),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_SOURCE_QUOTA",
    );
    await assert.rejects(
      archiveSource("xx", { ...options(agentDir), maxSessionBytes: 1 }),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_SESSION_QUOTA",
    );
  });
});

test("allows an explicit agent-root symlink but rejects every descendant symlink ancestor", async (t) => {
  await temporary(async (container) => {
    const actualRoot = join(container, "actual-agent");
    const rootLink = join(container, "agent-link");
    await mkdir(actualRoot, { mode: 0o700 });
    if (!await directorySymlinkOrSkip(t, actualRoot, rootLink)) return;

    const artifact = await archiveSource("through root link", options(rootLink, "root-link-session"));
    assert.equal(await readFile(artifact.path, "utf8"), "through root link");
    assert.ok(artifact.path.startsWith(`${await realpath(actualRoot)}/`));
  });

  if (t.signal.aborted) return;
  const sessionId = "ancestor-link-session";
  const sessionHash = sha256(sessionId);
  const cases = [
    ["extensions"],
    ["extensions", "pi-distill"],
    ["extensions", "pi-distill", "artifacts"],
    ["extensions", "pi-distill", "artifacts", sessionHash],
    ["extensions", "pi-distill", "artifacts", sessionHash, "objects"],
  ];
  for (const components of cases) {
    await temporary(async (agentDir) => {
      const outside = await mkdtemp(join(tmpdir(), "pi-distill-outside-"));
      try {
        const linkPath = join(agentDir, ...components);
        await mkdir(dirname(linkPath), { recursive: true, mode: 0o711 });
        const outsideMode = (await stat(outside)).mode & 0o777;
        if (!await directorySymlinkOrSkip(t, outside, linkPath)) return;

        await assert.rejects(
          archiveSource("must stay inside", options(agentDir, sessionId)),
          (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY",
        );
        assert.deepEqual(await readdir(outside), []);
        assert.equal((await stat(outside)).mode & 0o777, outsideMode);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
    if (t.signal.aborted) return;
  }
});

test("rejects a matching hardlinked object without mutating external bytes or permissions", async () => {
  await temporary(async (agentDir) => {
    const body = "externally linked source";
    const sessionId = "hardlink-session";
    const objectsDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId), "objects");
    const outside = join(agentDir, "external.txt");
    const target = join(objectsDir, `${sha256(body)}.txt`);
    await mkdir(objectsDir, { recursive: true, mode: 0o700 });
    await writeFile(outside, body, { mode: 0o640 });
    await link(outside, target);
    const beforeMode = (await stat(outside)).mode & 0o777;

    await assert.rejects(
      archiveSource(body, options(agentDir, sessionId)),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY",
    );

    assert.equal(await readFile(outside, "utf8"), body);
    assert.equal((await stat(outside)).mode & 0o777, beforeMode);
    assert.equal((await stat(outside)).nlink, 2);
  });
});

test("counts stale staging and unknown regular files without deleting them", async () => {
  await temporary(async (agentDir) => {
    const sessionId = "foreign-files-session";
    const objectsDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId), "objects");
    await mkdir(objectsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(objectsDir, ".pi-distill-stage-stale.tmp"), "123456", { mode: 0o600 });
    await writeFile(join(objectsDir, "unknown.bin"), "789", { mode: 0o600 });

    await assert.rejects(
      archiveSource("abc", { ...options(agentDir, sessionId), maxSourceBytes: 10, maxSessionBytes: 10 }),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_SESSION_QUOTA",
    );
    assert.deepEqual((await readdir(objectsDir)).sort(), [".pi-distill-stage-stale.tmp", "unknown.bin"]);
  });
});

test("deduplication still validates restored physical quota and foreign entry types", async (t) => {
  await temporary(async (agentDir) => {
    const sessionId = "dedupe-quota";
    const artifact = await archiveSource("same", options(agentDir, sessionId));
    const objectsDir = dirname(artifact.path);
    await writeFile(join(objectsDir, "unrelated.tmp"), "over-quota", { mode: 0o600 });
    await assert.rejects(archiveSource("same", { ...options(agentDir, sessionId), maxSessionBytes: 5 }), (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_SESSION_QUOTA");
    await rm(join(objectsDir, "unrelated.tmp"));
    if (!await directorySymlinkOrSkip(t, artifact.path, join(objectsDir, "foreign-link"), "file")) return;
    await assert.rejects(archiveSource("same", options(agentDir, sessionId)), (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY");
  });
});

test("rejects symlink and directory foreign entries in the objects directory", async (t) => {
  await temporary(async (agentDir) => {
    const sessionId = "foreign-entry-session";
    const objectsDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId), "objects");
    const outside = join(agentDir, "outside.txt");
    await mkdir(objectsDir, { recursive: true, mode: 0o700 });
    await writeFile(outside, "outside", { mode: 0o600 });
    if (!await directorySymlinkOrSkip(t, outside, join(objectsDir, "unknown-link"), "file")) return;

    await assert.rejects(
      archiveSource("new body", options(agentDir, sessionId)),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY",
    );
    assert.equal((await lstat(join(objectsDir, "unknown-link"))).isSymbolicLink(), true);
    await rm(join(objectsDir, "unknown-link"));
    await mkdir(join(objectsDir, "unknown-directory"));

    await assert.rejects(
      archiveSource("new body", options(agentDir, sessionId)),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INTEGRITY",
    );
    assert.equal((await lstat(join(objectsDir, "unknown-directory"))).isDirectory(), true);
  });
});

test("rejects non-round-tripping UTF-16 before creating archive files", async () => {
  await temporary(async (agentDir) => {
    await assert.rejects(
      archiveSource("isolated: \uD800", options(agentDir, "malformed-session")),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_INVALID_UTF8",
    );
    await assert.rejects(lstat(join(agentDir, "extensions")), (error: unknown) => errorCode(error) === "ENOENT");
  });
});

test("fails fast on a preexisting filesystem lock and releases its own lock", async () => {
  await temporary(async (agentDir) => {
    const sessionId = "busy-session";
    const sessionDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId));
    const lockDir = join(sessionDir, ".pi-distill-archive.lock");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(join(lockDir, "foreign"), "do not remove", { mode: 0o600 });

    await assert.rejects(
      archiveSource("busy", options(agentDir, sessionId)),
      (error) => errorCode(error) === "PI_DISTILL_ARCHIVE_BUSY",
    );
    assert.equal(await readFile(join(lockDir, "foreign"), "utf8"), "do not remove");

    await rm(lockDir, { recursive: true });
    const artifact = await archiveSource("released", options(agentDir, sessionId));
    assert.equal(await readFile(artifact.path, "utf8"), "released");
    await assert.rejects(lstat(lockDir), (error: unknown) => errorCode(error) === "ENOENT");
  });
});

test("serializes separate processes with a fail-fast session lock under a tight quota", { timeout: 30000 }, async (t) => {
  await temporary(async (agentDir) => {
    const sessionId = "process-race-session";
    const sessionDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId));
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const scriptPath = join(agentDir, "archive-child.mts");
    const archiveUrl = pathToFileURL(join(import.meta.dirname, "../src/archive.ts")).href;
    await writeFile(scriptPath, `
import { archiveSource } from ${JSON.stringify(archiveUrl)};
const [agentDir, sessionId, fill] = process.argv.slice(2);
process.send?.({ type: "ready" });
process.once("message", async () => {
  try {
    await archiveSource(fill.repeat(16 * 1024 * 1024), {
      agentDir, sessionId, kind: "tool-output", maxSourceBytes: 20 * 1024 * 1024, maxSessionBytes: 20 * 1024 * 1024,
    });
    process.send?.({ type: "result", status: "ok" });
  } catch (error) {
    process.send?.({ type: "result", status: "error", code: error?.code });
  }
});
`, { mode: 0o600 });

    const spawnChild = (fill: string): ChildProcess => fork(scriptPath, [agentDir, sessionId, fill], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      signal: t.signal,
    });
    const first = spawnChild("a");
    const second = spawnChild("b");
    first.on("error", () => {});
    second.on("error", () => {});
    t.after(() => { first.kill(); second.kill(); });
    try {
      const ready = await Promise.all([childMessage(first, "ready"), childMessage(second, "ready")]);
      assert.deepEqual(ready, [{ type: "ready" }, { type: "ready" }]);
      const firstResult = childMessage(first, "result");
      const secondResult = childMessage(second, "result");
      // Release both workers from the same barrier. Either contender can win;
      // a loser may observe the live lock or the winner's committed quota.
      first.send("go"); second.send("go");
      const results = await Promise.all([firstResult, secondResult]) as Array<{ type: string; status: string; code?: string }>;
      assert.equal(results.filter((result) => result.status === "ok").length, 1);
      const rejected = results.find((result) => result.status === "error")!;
      assert.ok(["PI_DISTILL_ARCHIVE_BUSY", "PI_DISTILL_ARCHIVE_SESSION_QUOTA"].includes(rejected.code!));

      const objectsDir = join(sessionDir, "objects");
      const names = await readdir(objectsDir);
      assert.equal(names.length, 1);
      assert.equal((await stat(join(objectsDir, names[0]))).size, 16 * 1024 * 1024);
    } finally {
      first.kill();
      second.kill();
    }
  });
});

test("queued cancellation returns before a stalled writer and keeps later writers serialized", { timeout: 6000 }, async (t) => {
  await temporary(async (agentDir) => {
    const sessionId = "stalled-cancellation";
    const heldBody = "held source\n";
    const probe = await open(join(agentDir, "prototype-probe"), "w");
    const prototype = Object.getPrototypeOf(probe);
    const nativeWrite = prototype.write;
    await probe.close();
    let reached!: () => void;
    const writing = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(prototype, "write", async function (this: unknown, ...args: unknown[]) {
      if (Buffer.isBuffer(args[0]) && args[0].equals(Buffer.from(heldBody))) {
        reached();
        await barrier;
      }
      return nativeWrite.apply(this, args);
    });
    t.after(() => release());
    const first = archiveSource(heldBody, options(agentDir, sessionId));
    let firstSettled = false;
    void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await writing;
      const controller = new AbortController();
      const queued = archiveSource("cancelled source", { ...options(agentDir, sessionId), signal: controller.signal });
      const rejection = assert.rejects(queued, (error) => error === controller.signal.reason);
      controller.abort();
      await Promise.race([rejection, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("queued cancellation waited for the stalled writer")), 2000);
      })]);
      clearTimeout(deadline);
      assert.equal(firstSettled, false);
      const next = archiveSource("next source", options(agentDir, sessionId));
      release();
      await first;
      assert.equal(await readFile((await next).path, "utf8"), "next source");
      const names = await readdir(dirname((await first).path));
      assert.deepEqual(names.sort(), [`${sha256(heldBody)}.txt`, `${sha256("next source")}.txt`].sort());
    } finally {
      clearTimeout(deadline);
      release();
      await first.catch(() => {});
    }
  });
});

test("an aborted queued call releases the in-process queue for the next writer", { timeout: 20000 }, async () => {
  await temporary(async (agentDir) => {
    const sessionId = "abort-queue-session";
    const sessionDir = join(agentDir, "extensions", "pi-distill", "artifacts", sha256(sessionId));
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const large = "q".repeat(8 * 1024 * 1024);
    const limits = { ...options(agentDir, sessionId), maxSourceBytes: 10 * 1024 * 1024, maxSessionBytes: 20 * 1024 * 1024 };

    const first = archiveSource(large, limits);
    const closeWatcher = await waitForLockDirectory(sessionDir);
    closeWatcher();
    const controller = new AbortController();
    const queued = archiveSource("abort me", { ...limits, signal: controller.signal });
    const rejected = assert.rejects(queued, (error) => error === controller.signal.reason);
    controller.abort();
    const final = archiveSource("after abort", limits);

    await first;
    await rejected;
    assert.equal(await readFile((await final).path, "utf8"), "after abort");
    await assert.rejects(lstat(join(sessionDir, ".pi-distill-archive.lock")), (error: unknown) => errorCode(error) === "ENOENT");
  });
});
