import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubInterceptor, parseGitHubUrl, resolveGitHubCloneDir, resolveGitHubOptions } from "../src/api-providers/interceptors/index.ts";

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
  assert.equal(parseGitHubUrl("https://github.com/owner/repo/tree/main%2foutside/src"), null);
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
