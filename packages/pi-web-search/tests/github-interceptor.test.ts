import assert from "node:assert/strict";
import childProcess, { ChildProcess, execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { mock } from "node:test";
import { GitHubInterceptor, parseGitHubUrl, resolveGitHubCloneDir, resolveGitHubOptions } from "../src/api-providers/interceptors/github.ts";

type CommandCall = { command: string; args: string[] };

// Stub every gh/git invocation in-process: no subprocesses, credentials or network.
// These tests run serially because the builtin ESM binding is shared.
async function withExecFileStub(
  respond: (command: string, args: string[]) => string | Error,
  run: (calls: CommandCall[]) => Promise<void>,
) {
  const calls: CommandCall[] = [];
  const stub = mock.method(childProcess, "execFile", (
    command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ command, args: [...args] });
    const child = new ChildProcess();
    queueMicrotask(() => {
      const result = respond(command, args);
      callback(result instanceof Error ? result : null, typeof result === "string" ? result : "", "");
      child.emit("exit", result instanceof Error ? 1 : 0);
    });
    return child;
  });
  try {
    syncBuiltinESMExports();
    assert.equal(execFile, stub);
    await run(calls);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
}

test("GitHub interceptor remains opt-in and preserves original option defaults", () => {
  assert.equal(resolveGitHubOptions(undefined, undefined).enabled, false);
  assert.equal(resolveGitHubOptions(true, undefined).enabled, true);
  assert.equal(resolveGitHubOptions({ maxRepoSizeMB: 123 }, undefined).enabled, true);
  assert.deepEqual(parseGitHubUrl("https://github.com/example/project/tree/main/src"), {
    owner: "example",
    repo: "project",
    ref: "main",
    refIsFullSha: false,
    path: "src",
    type: "tree",
  });
  assert.equal(parseGitHubUrl("https://example.com/example/project"), null);
});

test("GitHub interceptor rejects encoded path separators before clone cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-path-test-"));
  const clonePath = join(dir, "clone-root", "a", "b");
  const escapedPath = join(clonePath, "foo/../../..", "repo");
  const sentinel = join(escapedPath, "sentinel.txt");
  await mkdir(escapedPath, { recursive: true });
  await writeFile(sentinel, "keep");

  const maliciousUrl = "https://github.com/foo%2f%2e%2e%2f%2e%2e%2f%2e%2e/repo";
  assert.equal(parseGitHubUrl(maliciousUrl), null);
  assert.equal(parseGitHubUrl("https://github.com/owner/repo%2foutside"), null);
  assert.equal(parseGitHubUrl("https://github.com/owner/repo/tree/main%2f..%2foutside/src"), null);
  assert.equal(parseGitHubUrl("https://github.com/owner%5coutside/repo"), null);
  assert.throws(
    () => resolveGitHubCloneDir(clonePath, "foo/../../..", "repo"),
    /clone|克隆/i,
  );

  const interceptor = new GitHubInterceptor({ enabled: true, clonePath });
  try {
    const result = await interceptor.intercept(maliciousUrl, {
      raw: false,
      signal: new AbortController().signal,
    });
    assert.equal(result, null);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    interceptor.reset();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub interceptor returns cached clone content before provider fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-test-"));
  const repoPath = join(dir, "example", "project");
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "cached repository readme");

  const interceptor = new GitHubInterceptor({ enabled: true, clonePath: dir });
  interceptor._seedCache("example/project", {
    localPath: repoPath,
    clonePromise: Promise.resolve(repoPath),
  });
  try {
    const result = await interceptor.intercept("https://github.com/example/project", {
      raw: false,
      signal: new AbortController().signal,
    });
    assert.ok(result);
    assert.equal(result.contentType, "text/plain");
    assert.match(result.text, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.text, /cached repository readme/);
  } finally {
    interceptor.reset();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub README reads skip external symlinks but allow safe fallback and internal symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-readme-test-"));
  const repoPath = join(dir, "repo");
  const sentinel = join(dir, "repo-outside", "sentinel.txt");
  const secret = "synthetic README sentinel: must not be disclosed";
  const interceptor = new GitHubInterceptor({ enabled: true, clonePath: dir });
  try {
    await mkdir(repoPath);
    await mkdir(dirname(sentinel));
    await writeFile(sentinel, secret);
    interceptor._seedCache("example/project", { localPath: repoPath, clonePromise: Promise.resolve(repoPath) });

    for (const name of ["README.md", "readme.md", "README", "README.txt", "README.rst"]) {
      const link = join(repoPath, name);
      await symlink(sentinel, link);
      const result = await interceptor.intercept("https://github.com/example/project", { raw: false });
      assert.ok(result);
      assert.ok(!result.text.includes(secret), name);
      assert.match(result.text, /outside repository skipped/);
      assert.ok(!result.text.includes("## README.md"), name);
      await rm(link);
    }

    await symlink(sentinel, join(repoPath, "README.md"));
    await writeFile(join(repoPath, "README.rst"), "safe fallback README");
    const fallback = await interceptor.intercept("https://github.com/example/project", { raw: false });
    assert.match(fallback.text, /safe fallback README/);
    assert.ok(!fallback.text.includes(secret));

    await rm(join(repoPath, "README.md"));
    await mkdir(join(repoPath, "docs"));
    await writeFile(join(repoPath, "docs", "intro.md"), "safe internal README " + "x".repeat(9000));
    await symlink("docs/intro.md", join(repoPath, "README.md"));
    const internal = await interceptor.intercept("https://github.com/example/project", { raw: false });
    assert.match(internal.text, /safe internal README/);
    assert.match(internal.text, /README truncated at 8K chars/);
    assert.equal(await readFile(sentinel, "utf8"), secret);
  } finally {
    interceptor.reset();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub slash refs parse correctly and use distinct single-segment cache directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-ref-test-"));
  try {
    for (const type of ["blob", "tree"]) {
      assert.deepEqual(parseGitHubUrl(`https://github.com/example/project/${type}/feature%2Fone/src/a%23b.txt`), {
        owner: "example", repo: "project", ref: "feature/one", refIsFullSha: false, path: "src/a#b.txt", type,
      });
    }

    const paths = ["main", "feature/one", "feature%2Fone"].map((ref) => {
      const path = resolveGitHubCloneDir(dir, "example", "project", ref);
      assert.equal(dirname(path), join(dir, "example"));
      assert.equal(basename(path), `project@${encodeURIComponent(ref)}`);
      return path;
    });
    assert.equal(new Set(paths).size, paths.length);

    for (const ref of [".", "..", "feature/../outside", "/absolute", "feature//one", "feature\\one", "feature\0one"]) {
      assert.throws(() => resolveGitHubCloneDir(dir, "example", "project", ref), /outside the GitHub clone root/);
    }
    for (const segment of [".", "..", "../outside", "feature/one", "feature\\one", "feature\0one"]) {
      assert.throws(() => resolveGitHubCloneDir(dir, segment, "project"), /outside the GitHub clone root/);
      assert.throws(() => resolveGitHubCloneDir(dir, "example", segment), /outside the GitHub clone root/);
    }
    for (const segment of ["feature/one", "feature\\one", "feature\0one"]) {
      assert.equal(parseGitHubUrl(`https://github.com/${encodeURIComponent(segment)}/project`), null);
      assert.equal(parseGitHubUrl(`https://github.com/example/${encodeURIComponent(segment)}`), null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub cloning passes slash refs unchanged to stub gh/git and reuses the safe cache path", async (t) => {
  for (const hasGh of [true, false]) {
    await t.test(hasGh ? "gh clone" : "git fallback", async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-clone-test-"));
      const clonePath = join(dir, "clones");
      const interceptor = new GitHubInterceptor({ enabled: true, clonePath });
      try {
        await withExecFileStub((command, args) => {
          if (command === "gh" && args[0] === "--version") return hasGh ? "stub gh" : new Error("no gh");
          if ((command === "gh" && args[0] === "repo") || (command === "git" && args[0] === "clone")) {
            const destination = command === "gh" ? args[3] : args.at(-1);
            mkdirSync(destination, { recursive: true });
            writeFileSync(join(destination, "a#b.txt"), "stub cloned file");
            return "";
          }
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        }, async (calls) => {
          const result = await interceptor.intercept("https://github.com/example/project/blob/feature%2fone/a%23b.txt", {
            raw: false, forceClone: true, signal: new AbortController().signal,
          });
          assert.ok(result);
          assert.match(result.text, /stub cloned file/);
          const cached = await interceptor.intercept("https://github.com/example/project/tree/feature%2Fone", { raw: false });
          assert.match(cached.text, /a#b\.txt/);
          assert.equal(calls.length, 2);
          const clone = calls[1];
          assert.equal(clone.command, hasGh ? "gh" : "git");
          assert.equal(clone.args[clone.args.indexOf("--branch") + 1], "feature/one");
          assert.ok(clone.args.includes(join(clonePath, "example", "project@feature%2Fone")));
          assert.ok(clone.args.includes(hasGh ? "example/project" : "https://github.com/example/project.git"));
        });
      } finally {
        interceptor.reset();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("GitHub clone path rejection starts no clone promise and emits no unhandledRejection", async (t) => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    for (const target of ["owner", "destination"]) {
      await t.test(target, async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-rejection-test-"));
        const clonePath = join(dir, "clones");
        const outsidePath = join(dir, "clones-outside");
        const sentinel = join(outsidePath, "sentinel.txt");
        const cloneCache = new Map();
        const interceptor = new GitHubInterceptor({ enabled: true, clonePath, cloneCache });
        try {
          await mkdir(outsidePath);
          await writeFile(sentinel, "keep synthetic sentinel");
          const link = target === "owner" ? join(clonePath, "example") : join(clonePath, "example", "project");
          await mkdir(dirname(link), { recursive: true });
          await symlink(outsidePath, link);
          await withExecFileStub(() => { throw new Error("No gh/git calls expected"); }, async (calls) => {
            await assert.rejects(interceptor.intercept("https://github.com/example/project", { raw: false, forceClone: true }),
              /outside the GitHub clone root/);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepEqual(rejections, []);
            assert.equal(calls.length, 0);
            assert.equal(cloneCache.size, 0);
            assert.equal(await readFile(sentinel, "utf8"), "keep synthetic sentinel");
          });
        } finally {
          interceptor.reset();
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("GitHub API encodes file path segments without turning hashes into fragments or double decoding", async () => {
  const sha = "a".repeat(40);
  const paths = ["a#b.txt", "nested dir/a#b?c&d%é.txt", "literal%23.txt"];
  const interceptor = new GitHubInterceptor({ enabled: true });
  await withExecFileStub((command, args) => {
    if (command === "gh" && args[0] === "--version") return "stub gh";
    if (command === "gh" && args[0] === "api") return Buffer.from("stub API file").toString("base64");
    throw new Error(`Unexpected command: ${command}`);
  }, async (calls) => {
    for (const path of paths) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const result = await interceptor.intercept(`https://github.com/example/project/blob/${sha}/${encodedPath}`, { raw: false });
      assert.ok(result);
      assert.match(result.text, /stub API file/);
    }
    assert.deepEqual(calls.map(({ command }) => command), ["gh", "gh", "gh", "gh"]);
    assert.deepEqual(calls.slice(1).map(({ args }) => args), paths.map((path) => [
      "api", `repos/example/project/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "--jq", ".content",
    ]));
  });
});

test("GitHub API encodes slash and reserved characters in explicit and default refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-github-api-ref-test-"));
  const interceptor = new GitHubInterceptor({ enabled: true, clonePath: dir, maxRepoSizeMB: 1 });
  try {
    await withExecFileStub((command, args) => {
      if (command === "gh" && args[0] === "--version") return "stub gh";
      if (command === "gh" && args[0] === "api") {
        if (args[3] === ".size") return "2048";
        if (args[3] === ".default_branch") return "feature/one#é&%";
        if (args[3] === ".tree[].path") return "a#b.txt\nsrc/file.ts";
        if (args[3] === ".content") return Buffer.from("stub API content").toString("base64");
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }, async (calls) => {
      for (const url of [
        "https://github.com/example/project/blob/feature%2Fone/a%23b.txt",
        "https://github.com/example/project/tree/feature%2Fone",
        "https://github.com/example/project",
      ]) {
        const result = await interceptor.intercept(url, { raw: false });
        assert.ok(result);
        assert.match(result.text, /stub API content/);
      }
      assert.ok(calls.every(({ command, args }) => command === "gh" && ["--version", "api"].includes(args[0])));
      const contentCalls = calls.filter(({ args }) => [".content", ".tree[].path"].includes(args[3]));
      assert.deepEqual(contentCalls.map(({ args }) => args[1]).sort(), [
        "repos/example/project/contents/a%23b.txt?ref=feature%2Fone",
        "repos/example/project/git/trees/feature%2Fone?recursive=1",
        "repos/example/project/readme?ref=feature%2Fone",
        "repos/example/project/git/trees/feature%2Fone%23%C3%A9%26%25?recursive=1",
        "repos/example/project/readme?ref=feature%2Fone%23%C3%A9%26%25",
      ].sort());
    });
  } finally {
    interceptor.reset();
    await rm(dir, { recursive: true, force: true });
  }
});
