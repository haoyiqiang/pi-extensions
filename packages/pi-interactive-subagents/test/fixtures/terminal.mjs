#!/usr/bin/env node
// Executable tmux/Orca stand-in. Effects stay in the test's temporary directory.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const base = process.env.SUBAGENT_TEST_TERMINAL;
if (!base) throw new Error("Missing isolated terminal directory");
let root = base;
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
  const surfaces = join(base, "surfaces");
  mkdirSync(surfaces, { recursive: true });
  if (command === "split-window") {
    surface += `-${randomUUID()}`;
    root = join(surfaces, surface);
    mkdirSync(root);
  } else {
    const target = args.includes("-t") ? value("-t") : args.includes("--terminal") ? value("--terminal") : undefined;
    if (target && existsSync(join(surfaces, target))) { surface = target; root = join(surfaces, target); }
  }
}

function start(command) {
  writeFileSync(path("command"), command);
  if (existsSync(path("no-runtime"))) return;
  const fd = openSync(path("screen"), "w");
  const child = spawn("bash", ["-c", command], { env: { ...process.env, SUBAGENT_TEST_TERMINAL: root, TMUX_PANE: surface }, stdio: ["ignore", fd, fd], detached: true });
  writeFileSync(path("pid"), String(child.pid));
  closeSync(fd);
  child.unref();
}
switch (command) {
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
    if (existsSync(path("inventory-unknown"))) throw new Error("Fixture inventory unavailable");
    const present = multi ? readdirSync(join(base, "surfaces")).filter((id) => readFileSync(join(base, "surfaces", id, "surface"), "utf8") === "open")
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
