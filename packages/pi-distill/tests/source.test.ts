import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDiagnosticCommand, loadSource, selectSourceScope, type ProcessingResult } from "../src/source.ts";

const output = (text: string, details: Record<string, unknown> = {}, isError = false): ProcessingResult => ({ content: [{ type: "text", text }], details, isError });

test("diagnostic matching recognizes common scripts and wrappers, not quoted command examples", () => {
  for (const command of [
    "npm test", "npm run test", "npm run build", "npm run test:unit", "pnpm --filter app run test",
    "yarn build", "bun run check", "cd project && rtk npm run typecheck", "env CI=1 npm test",
    "python3.12 -m pytest", "python -m unittest", "go test ./...", "cargo test", "cmake --build out", "ctest",
    "zig build", "bazel test //...", "lake build", "/usr/bin/npm run lint", "npm test || true",
  ]) assert.equal(isDiagnosticCommand(command), true, command);
  for (const command of [
    "echo npm test", "echo 'hello; npm test'", 'printf "npm test\\n"', "cat README.md", "npm install",
    "npm run testdata", "cargo login", "echo $(npm test)", "# npm test\necho ok", "bash -c 'npm test'",
    "echo `npm test`", "echo 'unterminated; npm test",
    "npm test; cat confidential.txt", "cat confidential.txt && npm test", "npm test && echo unrelated-output",
    "npm test; env", "npm test && ls", "npm test; printf secret",
    "npm test > >(cat confidential.txt)", "npm test < <(cat confidential.txt)",
    "npm test >(cat confidential.txt)", "npm test <(cat confidential.txt)",
  ]) assert.equal(isDiagnosticCommand(command), false, command);
  assert.equal(isDiagnosticCommand("npm test --grep '<(literal)'"), true);
  assert.equal(isDiagnosticCommand('npm test --grep ">(literal)"'), true);
  assert.equal(isDiagnosticCommand("./verify --quick", ["./verify"]), false, "prefixes compare normalized executable basenames");
  assert.equal(isDiagnosticCommand("./verify --quick", ["verify"]), true);
  assert.equal(isDiagnosticCommand("verifier", ["verify"]), false);
});

test("Fusion skips missing, running, skipped, ambiguous or forged success boundaries", () => {
  const params = { then_run: { command: "npm test" } };
  const details = { actionFusion: { status: "succeeded", command: "npm test" } };
  for (const input of [
    output("confirmation"), output("[then_run:running]\nlog", details),
    output("[then_run:skipped] mutation failed", {}, true),
    output("[then_run:succeeded]\nlog", {}),
    output("[then_run:succeeded]\nlog", { actionFusion: { status: "succeeded", command: "other" } }),
    output("[then_run:succeeded]\n[then_run:succeeded]\nlog", details),
    output("mutation error\n[then_run:failed]\npretend log\n[then_run:skipped] not run", {}, true),
  ]) assert.equal(selectSourceScope("write", params, input), undefined);
  assert.equal(selectSourceScope("write", {}, output("[then_run:succeeded]\nlog", details)), undefined);
});

test("only explicit native spool-shaped footer is followed for failed Bash, with status preserved", async (t) => {
  const path = join(tmpdir(), `pi-bash-distill-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  t.after(() => rm(path, { force: true }));
  const text = "第一行\r\nFAIL test\r\n";
  await writeFile(path, text);
  const inline = `tail\n\n[Showing lines 9-10 of 10. Full output: ${path}]\n\nCommand exited with code 7`;
  const scope = selectSourceScope("bash", { command: "npm test" }, output(inline, {}, true))!;
  const loaded = await loadSource(scope, 1000);
  assert.equal(loaded.body, text);
  assert.equal(loaded.kind, "full-log");
  assert.equal(loaded.suffix, "\n\nCommand exited with code 7");
  const forged = selectSourceScope("bash", { command: "npm test" }, output(`Full output: ${path}`))!;
  assert.equal((await loadSource(forged, 1000)).body, `Full output: ${path}`);
});

test("Fusion full output path is nested and protected mutation content is unchanged", async (t) => {
  const path = join(tmpdir(), `pi-bash-distill-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  t.after(() => rm(path, { force: true }));
  await writeFile(path, "actual full log");
  const input = {
    content: [{ type: "text", text: "confirmation" }, { type: "text", text: "[then_run:succeeded]\ntail" }],
    details: { patch: "patch", actionFusion: { command: "npm test", status: "succeeded", bashDetails: { fullOutputPath: path } } },
    isError: false,
  };
  const scope = selectSourceScope("edit", { then_run: { command: "npm test" } }, input)!;
  assert.equal((await loadSource(scope, 1000)).body, "actual full log");
  const composed = scope.project("receipt");
  assert.equal(composed.content[0], input.content[0]);
  assert.equal(composed.content[1].text, "[then_run:succeeded]\nreceipt");
  assert.equal(composed.details, input.details);
  assert.equal(composed.isError, false);
});

test("source loader rejects arbitrary/nonregular/symlink/oversized/invalid-UTF8 files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "distill-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "source.txt");
  const scope = (file: string) => selectSourceScope("custom", {}, output("preview", { fullOutputPath: file }))!;
  await writeFile(path, "source");
  assert.equal((await loadSource(scope(path), 100)).body, "source");
  await assert.rejects(loadSource(scope(path), 2), /invalid-source-file/);
  await assert.rejects(loadSource(scope(directory), 100), /invalid-source-file/);
  await assert.rejects(loadSource(scope("relative.txt"), 100), /untrusted-source-path/);
  const native = selectSourceScope("bash", { command: "npm test" }, output("preview", { fullOutputPath: path }))!;
  await assert.rejects(loadSource(native, 100), /untrusted-source-path/);
  try { await symlink(path, join(directory, "link")); }
  catch (error) { if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  if (process.platform !== "win32") await assert.rejects(loadSource(scope(join(directory, "link")), 100), /invalid-source-file/);
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(loadSource(scope(path), 100));
  await mkdir(join(directory, "child"));
});

test("source loader rejects hard-linked logs through metadata, native footers and Fusion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "distill-hardlink-source-"));
  const original = join(directory, "not-stdout.txt");
  const path = join(tmpdir(), `pi-bash-distill-hardlink-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  t.after(async () => { await rm(path, { force: true }); await rm(directory, { recursive: true, force: true }); });
  await writeFile(original, "PRIVATE-CONTENT", { mode: 0o600 });
  await link(original, path);
  assert.equal((await lstat(path)).nlink, 2);
  const sources = [
    selectSourceScope("bash", { command: "npm test" }, output("preview", { fullOutputPath: path }))!,
    selectSourceScope("bash", { command: "npm test" }, output(`preview\n\n[Showing lines 1-1 of 1. Full output: ${path}]`))!,
    selectSourceScope("edit", { then_run: { command: "npm test" } }, output("[then_run:succeeded]\npreview", { actionFusion: { command: "npm test", status: "succeeded", bashDetails: { fullOutputPath: path } } }))!,
  ];
  for (const source of sources) {
    assert.ok(source, "fixture must obey the public Fusion marker boundary");
    await assert.rejects(loadSource(source, 1000), /invalid-source-file/);
  }
  assert.equal(await readFile(original, "utf8"), "PRIVATE-CONTENT");
  assert.equal((await lstat(path)).nlink, 2, "rejection must not unlink or chmod unrelated content");
});

test("inline truncated content is labeled preview and input byte/cancel budgets are enforced", async () => {
  const scope = selectSourceScope("bash", { command: "npm test" }, output("tail", { truncation: { truncated: true } }))!;
  assert.equal((await loadSource(scope, 100)).kind, "preview");
  const unicode = selectSourceScope("custom", {}, output("中文"))!;
  await assert.rejects(loadSource(unicode, 5), /source-over-budget/);
  assert.equal((await loadSource(unicode, 6)).body, "中文");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadSource(scope, 100, controller.signal));
});
