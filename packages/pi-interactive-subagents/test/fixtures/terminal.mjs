#!/usr/bin/env node
// Executable tmux/Orca stand-in. Effects stay in the test's temporary directory.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const base = process.env.SUBAGENT_TEST_TERMINAL_BASE ?? process.env.SUBAGENT_TEST_TERMINAL;
if (!base) throw new Error("Missing isolated terminal directory");
let root = process.env.SUBAGENT_TEST_TERMINAL ?? base;
function surfacesIn(directory) {
  return readdirSync(directory, { recursive: true }).map(String).filter((file) => file.endsWith("/surface")).map((file) => join(directory, file.slice(0, -"/surface".length)));
}
const multi = process.env.SUBAGENT_TEST_MULTI === "1";
const path = (name) => join(root, name);
const executable = basename(process.argv[1]).replace("-runtime.mjs", "");
const args = process.argv.slice(2);
appendFileSync(path("commands.jsonl"), JSON.stringify({ executable, args }) + "\n");
const orca = executable === "orca";
let surface = orca ? "term_fixture" : "%fixture";
const json = (result) => console.log(JSON.stringify({ ok: true, result }));
const value = (flag) => args[args.indexOf(flag) + 1];
let command = orca ? args[1] : args[0];
if (orca && args[0] === "status") { json({}); process.exit(0); }
if (orca) command = ({ split: "split-window", create: "split-window", list: "list-panes", send: "send-keys", read: "capture-pane", close: "kill-pane" })[command] ?? command;

if (multi) {
  const surfaces = join(root, "surfaces");
  mkdirSync(surfaces, { recursive: true });
  if (command === "split-window") {
    surface += `-${randomUUID()}`;
    root = join(surfaces, surface);
    mkdirSync(root);
  } else {
    const target = args.includes("-t") ? value("-t") : args.includes("--terminal") ? value("--terminal") : undefined;
    const found = target && surfacesIn(base).find((directory) => basename(directory) === target);
    if (found) { surface = target; root = found; }
  }
}

function start(command) {
  writeFileSync(path("command"), command);
  if (existsSync(path("no-runtime"))) return;
  const fd = openSync(path("screen"), "w");
  if (existsSync(path("complete-during-inventory"))) {
    // Hold the real writer until the controller enters native inventory, then
    // let readiness, settlement and process exit all precede that call's return.
    command = `while [ ! -f "$SUBAGENT_TEST_TERMINAL/inventory-entered" ]; do sleep 0.01; done; ${command}; touch "$SUBAGENT_TEST_TERMINAL/startup-exited"`;
  }
  const child = spawn("bash", ["-c", command], { env: { ...process.env, SUBAGENT_TEST_TERMINAL: root, TMUX_PANE: surface }, stdio: ["ignore", fd, fd], detached: true });
  writeFileSync(path("pid"), String(child.pid));
  closeSync(fd);
  child.unref();
}
switch (command) {
  // Full root-profile smoke also loads Spark's terminal naming projection.
  case "display-message": console.log("fixture"); break;
  case "rename-window":
  case "rename-session": break;
  case "split-window": {
    if (existsSync(path("create-fails"))) throw new Error("Fixture native creation failed");
    writeFileSync(path("surface"), "open");
    const startup = orca ? (args.includes("--command") ? value("--command") : undefined) : (args.includes("--") ? args.at(-1) : undefined);
    if (startup) start(startup);
    if (orca) json(args[1] === "create" ? { terminal: { handle: surface } } : { split: { handle: surface } });
    else console.log(surface);
    break;
  }
  case "send-keys": {
    if (orca) writeFileSync(path("next-task"), value("--text"));
    else if (args.includes("-l")) writeFileSync(path("command"), args.at(-1));
    else if (args.at(-1) === "Enter") {
      const command = readFileSync(path("command"), "utf8");
      if (command.startsWith("bash ")) start(command);
      else writeFileSync(path("next-task"), command);
    }
    if (orca) json({});
    break;
  }
  case "list-panes": {
    if (existsSync(path("complete-during-inventory")) && existsSync(path("pid"))) {
      writeFileSync(path("inventory-entered"), "release startup");
      const deadline = performance.now() + 8_000;
      while (!existsSync(path("startup-exited")) && performance.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      if (!existsSync(path("startup-exited"))) {
        writeFileSync(path("inventory-timed-out"), "fixture synchronization failed");
        throw new Error("Fixture child did not exit during inventory");
      }
      if (readFileSync(path("complete-during-inventory"), "utf8") === "absent") writeFileSync(path("surface"), "gone");
    }
    if (existsSync(path("inventory-unknown"))) throw new Error("Fixture inventory unavailable");
    const present = multi ? surfacesIn(base).filter((directory) => readFileSync(join(directory, "surface"), "utf8") === "open").map((directory) => basename(directory))
      : existsSync(path("surface")) && readFileSync(path("surface"), "utf8") === "open" ? [surface] : [];
    if (orca) json({ terminals: present.map((handle) => ({ handle, tabId: "shared" })) });
    else if (present.length) console.log(present.join("\n"));
    break;
  }
  case "capture-pane": {
    if (existsSync(path("diagnostics-unavailable"))) throw new Error("Fixture screen unavailable");
    const screen = existsSync(path("screen")) ? readFileSync(path("screen"), "utf8") : "";
    if (orca) json({ terminal: { tail: screen.split("\n") } });
    else process.stdout.write(screen);
    break;
  }
  case "kill-pane":
    if (existsSync(join(base, "pause-close"))) {
      writeFileSync(join(base, "close-waiting"), surface);
      const deadline = performance.now() + 8_000;
      while (existsSync(join(base, "pause-close")) && performance.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (existsSync(path("close-fails"))) throw new Error("Fixture closure failed");
    writeFileSync(path("surface"), "closed");
    writeFileSync(path("layout"), "closed"); // legacy fixture teardown synchronization
    if (existsSync(path("pid"))) { try { process.kill(-Number(readFileSync(path("pid"), "utf8")), "SIGTERM"); } catch {} }
    if (orca) json({});
    break;
  case "select-layout":
    writeFileSync(path("layout"), readFileSync(path("surface")));
    break;
  default:
    throw new Error(`Unexpected fixture terminal command: ${command}`);
}
