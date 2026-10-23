#!/usr/bin/env node
// Executable tmux stand-in. All effects are confined to the test's temporary directory.
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.env.SUBAGENT_TEST_TERMINAL;
if (!root) throw new Error("Missing isolated terminal directory");
const path = (name) => join(root, name);
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "split-window":
    writeFileSync(path("surface"), "open");
    console.log("%fixture");
    break;
  case "send-keys":
    if (args.includes("-l")) {
      writeFileSync(path("command"), args.at(-1));
    } else if (args.at(-1) === "Enter") {
      const fd = openSync(path("screen"), "w");
      const child = spawn("bash", ["-c", readFileSync(path("command"), "utf8")], {
        env: process.env, stdio: ["ignore", fd, fd], detached: true,
      });
      writeFileSync(path("pid"), String(child.pid));
      closeSync(fd);
      child.unref();
    }
    break;
  case "capture-pane":
    if (existsSync(path("screen"))) process.stdout.write(readFileSync(path("screen")));
    break;
  case "kill-pane":
    writeFileSync(path("surface"), "closed");
    break;
  case "select-layout":
    writeFileSync(path("layout"), readFileSync(path("surface")));
    break;
  default:
    throw new Error(`Unexpected fixture terminal command: ${command}`);
}
