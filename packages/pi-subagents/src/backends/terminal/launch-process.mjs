import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const FORCE_KILL_AFTER_MS = 1_000;
const configFile = process.argv[2];
if (!configFile) fail();
let raw;
try { raw = readFileSync(configFile, "utf8"); } catch (error) { fail(message(error)); }
let config;
try { config = JSON.parse(raw); } catch { fail(); }
if (!validConfig(config) || process.platform === "win32") fail();
const child = spawn(config.executable, config.args, {
  cwd: config.cwd,
  env: { ...process.env, ...config.env },
  shell: false,
  stdio: "inherit",
  detached: true,
});
const groups = new Set(child.pid ? [child.pid] : []);
let finished = false;
let finishing = false;
let forwardedSignal;
let forceKillTimer;
let treeKillFailed = false;
const onSigint = () => forwardSignal("SIGINT");
const onSigterm = () => forwardSignal("SIGTERM");
const onSighup = () => forwardSignal("SIGHUP");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("SIGHUP", onSighup);
child.once("error", (error) => process.stderr.write(`${message(error)}\n`));
child.once("close", (code, signal) => {
  const exitCode = typeof code === "number" && code >= 0 ? code : signalExitCode(signal ?? forwardedSignal);
  void finish(exitCode);
});

// ps is only needed to include detached descendant groups (Pi bash tools can use them).
// Without it, the owned group is still killed; no receipt is issued if retirement is uncertain.
function processTable() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 250, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim().split("\n").map((line) => {
    const [pid, parent, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state: state ?? "" };
  }).filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
}
function captureGroups() {
  if (!child.pid) return;
  const table = processTable();
  if (!table) { treeKillFailed = true; return; }
  const descendants = new Set([child.pid]);
  let previous;
  do {
    previous = descendants.size;
    for (const row of table) if (descendants.has(row.parent)) descendants.add(row.pid);
  } while (descendants.size !== previous);
  // Only groups led by this tree are ours; never target a shared parent/terminal group.
  for (const row of table) if (descendants.has(row.pid) && descendants.has(row.group)) groups.add(row.group);
}
function signalGroups(signal) {
  for (const group of groups) {
    try { process.kill(-group, signal); }
    catch (error) { if (error.code !== "ESRCH") treeKillFailed = true; }
  }
}
function forwardSignal(signal) {
  if (finished || finishing) return;
  forwardedSignal ??= signal;
  captureGroups();
  signalGroups(signal);
  if (forceKillTimer === undefined) forceKillTimer = setTimeout(() => {
    captureGroups();
    signalGroups("SIGKILL");
  }, FORCE_KILL_AFTER_MS);
}
async function retireGroups() {
  signalGroups("SIGKILL");
  const deadline = Date.now() + FORCE_KILL_AFTER_MS;
  for (;;) {
    const alive = [...groups].filter((group) => {
      try { process.kill(-group, 0); return true; } catch { return false; }
    });
    if (!alive.length) return !treeKillFailed;
    const table = processTable();
    // Zombies have no executable code or writable FDs; reaping belongs to their OS parent.
    if (table && !table.some((row) => alive.includes(row.group) && !row.state.startsWith("Z"))) return !treeKillFailed;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function finish(exitCode) {
  if (finished || finishing) return;
  finishing = true;
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  const retired = await retireGroups();
  finished = true;
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
  if (!retired) { process.exitCode = 1; return; }
  if (config.processExit) {
    const temporary = `${config.processExit.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, runId: config.processExit.runId, token: config.processExit.token, exitCode }) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, config.processExit.path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* preserve the original OS error */ }
      process.stderr.write(`${message(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = exitCode;
  // Compatibility only. The real terminal backend never trusts screen text as exit proof.
  process.stdout.write(`__SUBAGENT_DONE_${exitCode}__\n`);
}
function signalExitCode(signal) {
  const number = typeof signal === "string" ? osConstants.signals[signal] : undefined;
  return typeof number === "number" ? 128 + number : 1;
}
function validConfig(value) {
  return object(value) && nonEmpty(value.executable) && Array.isArray(value.args)
    && value.args.every((argument) => typeof argument === "string") && nonEmpty(value.cwd)
    && object(value.env) && Object.values(value.env).every((entry) => typeof entry === "string")
    && (value.processExit === undefined || (object(value.processExit) && nonEmpty(value.processExit.path)
      && isAbsolute(value.processExit.path) && nonEmpty(value.processExit.runId) && nonEmpty(value.processExit.token)));
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function message(error) { return error instanceof Error ? error.message : String(error); }
function fail(reason) { if (reason !== undefined) process.stderr.write(`${reason}\n`); process.exit(1); }
