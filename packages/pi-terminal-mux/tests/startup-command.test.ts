import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

let api: typeof import("../src/index.ts");
let directory = "";
let logPath = "";
let caller = "";
const owned: Array<{ backend: "tmux" | "orca" | "headless"; surface: string }> = [];
const keys = ["PATH", "TMUX", "TMUX_PANE", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE", "PI_TERMINAL_MUX", "PI_SUBAGENT_MUX", "MUX_STARTUP_TEST_LOG", "MUX_STARTUP_TEST_FAIL", "MUX_STARTUP_TEST_MALFORMED"];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function commands(): Array<{ executable: string; args: string[] }> {
  const text = readFileSync(logPath, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}
function created(surface: string, backend: "tmux" | "orca" | "headless"): string {
  owned.push({ backend, surface });
  return surface;
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "pi-mux-startup-test-"));
  caller = `term_${basename(directory)}`;
  logPath = join(directory, "commands.jsonl");
  const fake = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const executable = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.MUX_STARTUP_TEST_LOG, JSON.stringify({ executable, args }) + "\\n");
if (process.env.MUX_STARTUP_TEST_FAIL && args.includes(process.env.MUX_STARTUP_TEST_FAIL)) {
  process.stderr.write("simulated backend failure"); process.exit(1);
}
if (executable === "tmux") {
  if (args[0] === "split-window") process.stdout.write("%123\\n");
} else {
  const result = args[0] === "status" ? {} :
    args[1] === "create" ? { terminal: { handle: "term_created" } } :
    args[1] === "split" ? { split: { handle: "term_split" } } :
    args[1] === "list" ? { terminals: [] } :
    args[1] === "read" ? { terminal: { tail: ["ready"] } } : {};
  process.stdout.write(JSON.stringify({ ok: true, result: process.env.MUX_STARTUP_TEST_MALFORMED ? {} : result }));
}
`;
  for (const name of ["tmux", "orca"]) writeFileSync(join(directory, name), fake, { mode: 0o755 });
  process.env.PATH = `${directory}${delimiter}${original.PATH ?? ""}`;
  process.env.ORCA_TERMINAL_HANDLE = caller;
  process.env.MUX_STARTUP_TEST_LOG = logPath;
  api = await import("../src/index.ts");
});

beforeEach(() => {
  writeFileSync(logPath, "");
  process.env.TMUX = "/tmp/fake-tmux-socket,1,0";
  process.env.TMUX_PANE = "%parent";
  process.env.TERM_PROGRAM = "Orca";
  process.env.PI_TERMINAL_MUX = "tmux";
  delete process.env.PI_SUBAGENT_MUX;
  delete process.env.MUX_STARTUP_TEST_FAIL;
  delete process.env.MUX_STARTUP_TEST_MALFORMED;
});

afterEach(() => {
  delete process.env.MUX_STARTUP_TEST_FAIL;
  delete process.env.MUX_STARTUP_TEST_MALFORMED;
  for (const { backend, surface } of owned.splice(0)) {
    if (backend === "headless") api.drainHeadlessProcess(surface);
    else { process.env.PI_TERMINAL_MUX = backend; api.closeSurface(surface); }
  }
});

after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(join(tmpdir(), `orca-subagent-pane-${caller}.json`), { force: true });
  rmSync(directory, { recursive: true, force: true });
});

const command = `env FLAG='value with spaces' node '/tmp/path with spaces/probe.js' --prompt 'quotes: "double"; $HOME & |'`;

test("tmux creation without options keeps its existing arguments", () => {
  created(api.createSurface("worker"), "tmux");
  assert.deepEqual(commands(), [{ executable: "tmux", args: [
    "split-window", "-d", "-h", "-t", "%parent", "-P", "-F", "#{pane_id}",
  ] }]);
});

test("tmux create supplies the complete command to split-window, without send-keys", () => {
  created(api.createSurface("worker", { command }), "tmux");
  assert.deepEqual(commands(), [{ executable: "tmux", args: [
    "split-window", "-d", "-h", "-t", "%parent", "-P", "-F", "#{pane_id}", "--", command,
  ] }]);
});

test("tmux explicit split preserves its source and direction while forwarding startup options", () => {
  created(api.createSurfaceSplit("worker", "left", "%explicit", { command }), "tmux");
  assert.equal(api.getLastSplitSource(), "%explicit");
  assert.deepEqual(commands()[0].args, [
    "split-window", "-d", "-h", "-b", "-t", "%explicit", "-P", "-F", "#{pane_id}", "--", command,
  ]);
});

test("Orca automatic placement forwards --command through its native split", () => {
  process.env.PI_TERMINAL_MUX = "orca";
  created(api.createSurface("worker", { command }), "orca");
  const terminal = commands().filter((entry) => entry.args[0] === "terminal");
  assert.deepEqual(terminal, [{ executable: "orca", args: [
    "terminal", "split", "--terminal", caller, "--direction", "vertical", "--command", command, "--json",
  ] }]);
});

test("Orca explicit split forwards --command and never calls terminal send", () => {
  process.env.PI_TERMINAL_MUX = "orca";
  created(api.createSurfaceSplit("worker", "down", "term_explicit", { command }), "orca");
  const terminal = commands().filter((entry) => entry.args[0] === "terminal");
  assert.deepEqual(terminal, [{ executable: "orca", args: [
    "terminal", "split", "--terminal", "term_explicit", "--direction", "horizontal", "--command", command, "--json",
  ] }]);
});

test("Orca without a caller handle uses native terminal create --command", () => {
  const entrypoint = new URL("../src/index.ts", import.meta.url).href;
  const env: NodeJS.ProcessEnv = { ...process.env, PI_TERMINAL_MUX: "orca", MUX_STARTUP_TEST_COMMAND: command };
  delete env.ORCA_TERMINAL_HANDLE;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const api = await import(${JSON.stringify(entrypoint)});
    const surface = api.createSurface("worker", { command: process.env.MUX_STARTUP_TEST_COMMAND });
    api.closeSurface(surface);
    console.log(surface);
  `], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "term_created");
  assert.deepEqual(commands().find((entry) => entry.args[1] === "create")?.args, [
    "terminal", "create", "--title", "worker", "--command", command, "--json",
  ]);
  assert.equal(commands().some((entry) => entry.args[1] === "send"), false);
});

test("Orca creation without a command still opens an ordinary terminal", () => {
  process.env.PI_TERMINAL_MUX = "orca";
  created(api.createSurfaceSplit("worker", "right", "term_explicit"), "orca");
  assert.equal(commands().some((entry) => entry.args.includes("--command")), false);
});

test("native creation failures and malformed handles propagate", () => {
  process.env.MUX_STARTUP_TEST_FAIL = "split-window";
  assert.throws(() => api.createSurface("worker", { command }), /simulated backend failure/);
  process.env.PI_TERMINAL_MUX = "orca";
  process.env.MUX_STARTUP_TEST_FAIL = "split";
  assert.throws(() => api.createSurfaceSplit("worker", "right", caller, { command }), /simulated backend failure/);
  delete process.env.MUX_STARTUP_TEST_FAIL;
  process.env.MUX_STARTUP_TEST_MALFORMED = "1";
  assert.throws(() => api.createSurfaceSplit("worker", "right", caller, { command }), /Unexpected Orca terminal split output/);
});

test("Orca automatic placement does not resend a failed startup request", () => {
  process.env.PI_TERMINAL_MUX = "orca";
  created(api.createSurface("first", { command }), "orca");
  writeFileSync(logPath, "");
  process.env.MUX_STARTUP_TEST_FAIL = "split";
  assert.throws(() => api.createSurface("second", { command }), /simulated backend failure/);
  assert.equal(commands().filter((entry) => entry.args[0] === "terminal" && entry.args[1] === "split").length, 1);
});

test("Orca input and read failures no longer masquerade as success", () => {
  process.env.PI_TERMINAL_MUX = "orca";
  process.env.MUX_STARTUP_TEST_FAIL = "send";
  assert.throws(() => api.sendCommand("term_missing", "echo hello"), /simulated backend failure/);
  process.env.MUX_STARTUP_TEST_FAIL = "read";
  assert.throws(() => api.readScreen("term_missing"), /simulated backend failure/);
});

test("empty startup commands fail before creating a terminal", () => {
  for (const command of ["", " \n\t"]) {
    assert.throws(() => api.createSurface("worker", { command }), /Startup command must not be empty/);
    assert.throws(() => api.createSurfaceSplit("worker", "right", undefined, { command }), /Startup command must not be empty/);
  }
  assert.deepEqual(commands(), []);
});

async function waitForHeadless(surface: string): Promise<void> {
  assert.deepEqual(await api.getHeadlessProcessExit(surface), { exitCode: 7 });
  const deadline = Date.now() + 1_000;
  while (!api.readScreen(surface).includes("headless-started") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(api.readScreen(surface), /headless-started/);
}
function selectHeadless(): void {
  delete process.env.PI_TERMINAL_MUX;
  delete process.env.TMUX;
  delete process.env.TERM_PROGRAM;
}

test("headless create starts its command immediately", async () => {
  selectHeadless();
  const surface = created(api.createSurface("worker", { command: "printf headless-started; exit 7" }), "headless");
  assert.equal(api.isHeadlessSurface(surface), true);
  await waitForHeadless(surface);
  assert.deepEqual(commands(), []);
});

test("headless creation without options still supports the old sendLongCommand flow", async () => {
  selectHeadless();
  const surface = created(api.createSurface("worker"), "headless");
  assert.equal(api.getHeadlessProcessExit(surface), null);
  const scriptPath = join(directory, "launch with spaces.sh");
  api.sendLongCommand(surface, "printf headless-started; exit 7", { scriptPath });
  assert.equal(existsSync(scriptPath), true);
  await waitForHeadless(surface);
});
