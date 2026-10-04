import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SUPERVISOR = fileURLToPath(new URL("../src/backends/terminal/launch-process.mjs", import.meta.url));
const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "terminal-launch-process-"));
  directories.push(path);
  return path;
}

function fixture(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source, "utf8");
  return path;
}

function launchConfig(root: string, args: string[], env: Record<string, string> = {}): string {
  const path = join(root, "launch.json");
  writeFileSync(path, JSON.stringify({
    executable: process.execPath,
    args,
    cwd: root,
    env,
  }));
  return path;
}

function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(path)) resolve();
      else if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${path}`));
      else setTimeout(check, 10);
    };
    check();
  });
}

function runSupervisor(configFile: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [SUPERVISOR, configFile], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("terminal launch process supervisor", () => {
  it("spawns without a shell, inherits stdio, merges explicit env and exits with the child code", () => {
    const root = directory();
    const childFile = fixture(root, "child.mjs", `
      console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.LAUNCH_MARKER }));
      console.log("child-complete");
      process.exit(7);
    `);
    const argument = "literal ; echo never-executed && $HOME ' quoted";
    const configFile = launchConfig(root, [childFile, argument], { LAUNCH_MARKER: "from-config" });

    const result = spawnSync(process.execPath, [SUPERVISOR, configFile], { encoding: "utf8" });

    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
    const lines = result.stdout.trimEnd().split("\n");
    expect(JSON.parse(lines[0])).toEqual({ args: [argument], cwd: realpathSync(root), marker: "from-config" });
    expect(lines.slice(1)).toEqual(["child-complete", "__SUBAGENT_DONE_7__"]);
    expect(result.stdout).not.toContain("never-executed\n");
  });

  it("rejects malformed JSON quietly instead of echoing parser diagnostics or secrets", () => {
    const root = directory();
    const configFile = fixture(root, "malformed.json", '{"token":"do-not-echo",broken');
    const result = spawnSync(process.execPath, [SUPERVISOR, configFile], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("does not emit a completion sentinel when validation fails before a child exists", () => {
    const root = directory();
    const configFile = join(root, "invalid.json");
    writeFileSync(configFile, JSON.stringify({ executable: process.execPath, args: "wrong" }));

    const result = spawnSync(process.execPath, [SUPERVISOR, configFile], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("__SUBAGENT_DONE_");
    // The owner reports a localized startup failure; the low-level supervisor adds no English UI.
    expect(result.stderr).toBe("");
  });

  it.skipIf(process.platform === "win32")("forwards SIGTERM and reports the child's graceful exit only after it closes", async () => {
    const root = directory();
    const readyFile = join(root, "ready");
    const childFile = fixture(root, "graceful.mjs", `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(readyFile)}, "ready");
      process.on("SIGTERM", () => {
        console.log("child-got-sigterm");
        setTimeout(() => process.exit(23), 20);
      });
      setInterval(() => {}, 1_000);
    `);
    const configFile = launchConfig(root, [childFile]);
    const supervisor = spawn(process.execPath, [SUPERVISOR, configFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    supervisor.stdout.setEncoding("utf8");
    supervisor.stderr.setEncoding("utf8");
    supervisor.stdout.on("data", (chunk: string) => { stdout += chunk; });
    supervisor.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (code, signal) => resolve({ code, signal }));
    });

    await waitForFile(readyFile);
    supervisor.kill("SIGTERM");
    const result = await closed;

    expect(result).toEqual({ code: 23, signal: null });
    expect(stderr).toBe("");
    expect(stdout.trimEnd().split("\n")).toEqual(["child-got-sigterm", "__SUBAGENT_DONE_23__"]);
  });

  it.skipIf(process.platform === "win32")("escalates an ignored termination signal to SIGKILL within the bound", async () => {
    const root = directory();
    const readyFile = join(root, "ready");
    const childFile = fixture(root, "stubborn.mjs", `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(readyFile)}, "ready");
      process.on("SIGTERM", () => console.log("ignoring-sigterm"));
      setInterval(() => {}, 1_000);
    `);
    const configFile = launchConfig(root, [childFile]);
    const supervisor = spawn(process.execPath, [SUPERVISOR, configFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    supervisor.stdout.setEncoding("utf8");
    supervisor.stdout.on("data", (chunk: string) => { stdout += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (code, signal) => resolve({ code, signal }));
    });

    await waitForFile(readyFile);
    const startedAt = Date.now();
    supervisor.kill("SIGTERM");
    const result = await closed;
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({ code: 137, signal: null });
    expect(elapsed).toBeLessThan(2_500);
    expect(stdout).toContain("ignoring-sigterm\n");
    expect(stdout.trimEnd().endsWith("__SUBAGENT_DONE_137__")).toBe(true);
  });

  it("ignores spoofed stdout markers and retires stubborn detached descendants before writing a receipt", async () => {
    const root = directory();
    const childReady = join(root, "child-ready");
    const grandReady = join(root, "grand-ready");
    const receiptPath = join(root, "process-exit.json");
    const grandchild = fixture(root, "grandchild.mjs", `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      writeFileSync(${JSON.stringify(grandReady)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const childFile = fixture(root, "tree.mjs", `
      import { writeFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      process.on('SIGTERM', () => {});
      spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit', detached: true });
      writeFileSync(${JSON.stringify(childReady)}, String(process.pid));
      console.log('__SUBAGENT_DONE_0__');
      setInterval(() => {}, 1000);
    `);
    const configFile = launchConfig(root, [childFile]);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.processExit = { path: receiptPath, runId: "run-tree", token: "private-receipt-token" };
    writeFileSync(configFile, JSON.stringify(config));
    const supervisor = spawn(process.execPath, [SUPERVISOR, configFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    supervisor.stdout.on("data", (data) => { stdout += data; });
    supervisor.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", resolve);
    });
    let childPid = 0;
    let grandPid = 0;
    try {
      await Promise.all([waitForFile(childReady), waitForFile(grandReady)]);
      childPid = Number(readFileSync(childReady, "utf8"));
      grandPid = Number(readFileSync(grandReady, "utf8"));
      expect(existsSync(receiptPath)).toBe(false);
      supervisor.kill("SIGTERM");
      expect(await closed).toBe(137);
      expect(stdout).toContain("__SUBAGENT_DONE_0__");
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
        version: 1, runId: "run-tree", token: "private-receipt-token", exitCode: 137,
      });
      for (const pid of [childPid, grandPid]) {
        const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
        expect(state.status !== 0 || state.stdout.trim().startsWith("Z")).toBe(true);
      }
    } finally {
      supervisor.kill("SIGKILL");
      for (const pid of [childPid, grandPid]) if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    }
  }, 10_000);

  it("accepts the generated config shape as plain JSON rather than executable code", async () => {
    const root = directory();
    const outputFile = join(root, "observed.json");
    const childFile = fixture(root, "observe.mjs", `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env.OBSERVED }));
    `);
    const configFile = launchConfig(root, [childFile, "one", "two"], { OBSERVED: "yes" });

    const result = await runSupervisor(configFile);

    expect(result).toEqual({ code: 0, signal: null, stdout: "__SUBAGENT_DONE_0__\n", stderr: "" });
    expect(JSON.parse(readFileSync(outputFile, "utf8"))).toEqual({ argv: ["one", "two"], env: "yes" });
  });
});
