import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForProcessExit, type ProcessExitReceipt } from "../src/backends/terminal/process-exit.js";
import { i18n } from "../src/i18n.js";

const dirs: string[] = [];
const controllers: AbortController[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "terminal-exit-receipt-"));
  dirs.push(root);
  const receipt: ProcessExitReceipt = { path: join(root, "process-exit.json"), runId: "current-run", token: "current-private-token" };
  const controller = new AbortController();
  controllers.push(controller);
  const data = { version: 1, runId: receipt.runId, token: receipt.token, exitCode: 0 };
  return { root, receipt, controller, data };
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("supervisor exit receipt observation", () => {
  it("reads an already completed run without a watcher race", async () => {
    const f = fixture();
    writeFileSync(f.receipt.path, JSON.stringify(f.data));
    await expect(waitForProcessExit(f.receipt, f.controller.signal)).resolves.toEqual({ reason: "sentinel", exitCode: 0 });
  });
  it("ignores stdout-style marker files and waits for the matching atomic receipt", async () => {
    const f = fixture();
    let completed = false;
    const waiting = waitForProcessExit(f.receipt, f.controller.signal);
    void waiting.then(() => { completed = true; });
    writeFileSync(join(f.root, "screen.log"), "__SUBAGENT_DONE_0__");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    const temporary = join(f.root, "receipt.tmp");
    writeFileSync(temporary, JSON.stringify({ ...f.data, exitCode: 7 }));
    renameSync(temporary, f.receipt.path);
    await expect(waiting).resolves.toEqual({ reason: "sentinel", exitCode: 7 });
  });
  it.each(["stale identity", "wrong token", "malformed JSON", "too large"])("rejects %s without revealing artifact contents", async (kind) => {
    const f = fixture();
    const text = kind === "stale identity" ? JSON.stringify({ ...f.data, runId: "old-run" })
      : kind === "wrong token" ? JSON.stringify({ ...f.data, token: "do-not-echo" })
      : kind === "too large" ? "x".repeat(4_097) : '{"token":"do-not-echo",broken';
    writeFileSync(f.receipt.path, text);
    await expect(waitForProcessExit(f.receipt, f.controller.signal)).rejects.toThrow(i18n.t("bridge.invalidReceipt"));
  });
  it("cancels the watcher with an arbitrary abort reason", async () => {
    const f = fixture();
    const waiting = waitForProcessExit(f.receipt, f.controller.signal);
    f.controller.abort(false);
    await expect(waiting).rejects.toBe(false);
    writeFileSync(f.receipt.path, JSON.stringify(f.data));
  });
  it("fails if the artifact directory is unavailable", async () => {
    const f = fixture();
    f.receipt = { ...f.receipt, path: join(f.root, "missing", "process-exit.json") };
    await expect(waitForProcessExit(f.receipt, f.controller.signal)).rejects.toThrow(i18n.t("bridge.invalidReceipt"));
    mkdirSync(join(f.root, "missing"));
  });
});
