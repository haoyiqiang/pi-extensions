import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTerminalArtifacts } from "../src/backends/terminal/artifacts.js";
import type { PersistentSessionReference } from "../src/backends/session-reference.js";
import { i18n } from "../src/i18n.js";

const assistant = (text: string) => JSON.stringify({
  type: "message", message: { role: "assistant", content: [{ type: "text", text }] },
}) + "\n";
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, cwd: "/project" }) + "\n";
let dir: string;
let session: PersistentSessionReference<"terminal">;
const artifacts = createTerminalArtifacts();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-terminal-artifacts-"));
  session = { backend: "terminal", sessionId: "conversation-id", sessionFile: join(dir, "session.jsonl") };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("terminal run artifacts", () => {
  it("clears stale completion without creating or rewriting a fresh transcript", () => {
    writeFileSync(`${session.sessionFile}.exit`, '{"type":"done"}');
    const cursor = artifacts.prepare(session);
    expect(cursor.byteOffset).toBe(0);
    expect(existsSync(session.sessionFile)).toBe(false);
    expect(existsSync(`${session.sessionFile}.exit`)).toBe(false);
    expect(artifacts.readSummary(session.sessionFile, cursor)).toBeUndefined();
    writeFileSync(session.sessionFile, header(session.sessionId) + assistant("new response"));
    expect(artifacts.readSummary(session.sessionFile, cursor)).toBe("new response");
  });

  it("separates resumed output by byte offset, preserving history and UTF-8 boundaries", () => {
    const old = header(session.sessionId) + assistant("之前的结果 😄");
    writeFileSync(session.sessionFile, old);
    writeFileSync(`${session.sessionFile}.exit`, '{"type":"structured_output","value":"old"}');
    const cursor = artifacts.prepare(session);
    expect(cursor.byteOffset).toBe(Buffer.byteLength(old));
    expect(readFileSync(session.sessionFile, "utf8")).toBe(old);
    expect(artifacts.readSummary(session.sessionFile, cursor)).toBeUndefined();
    appendFileSync(session.sessionFile, assistant("本次结果"));
    expect(artifacts.readSummary(session.sessionFile, cursor)).toBe("本次结果");
    const next = artifacts.prepare(session);
    expect(artifacts.readSummary(session.sessionFile, next)).toBeUndefined();
  });

  it.each([false, 0, { ok: true }])("retains subagent_done structured results (%j)", (result) => {
    const cursor = artifacts.prepare(session);
    writeFileSync(session.sessionFile, header(session.sessionId) + JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [
        { type: "text", text: "summary" },
        { type: "toolCall", name: "subagent_done", arguments: { result } },
      ] },
    }) + "\n");
    expect(artifacts.readSummary(session.sessionFile, cursor)).toBe(`summary\n\n${JSON.stringify(result, null, 2)}`);
  });

  it("ignores unknown entries/roles and finds the last meaningful assistant in the new suffix", () => {
    const cursor = artifacts.prepare(session);
    writeFileSync(session.sessionFile, header(session.sessionId) + assistant("first") +
      JSON.stringify({ type: "custom", data: "ignored" }) + "\n" + assistant("final") +
      JSON.stringify({ type: "message", message: { role: "user", content: "not an answer" } }) + "\n");
    expect(artifacts.readSummary(session.sessionFile, cursor)).toBe("final");
  });

  it("rejects a mismatched session identity before deleting its completion marker", () => {
    writeFileSync(session.sessionFile, header("another-session") + assistant("untouched"));
    writeFileSync(`${session.sessionFile}.exit`, '{"type":"done"}');
    expect(() => artifacts.prepare(session)).toThrow(i18n.t("terminal.sessionMismatch"));
    expect(existsSync(`${session.sessionFile}.exit`)).toBe(true);
  });

  it("checks the identity of a file first created by the child", () => {
    const cursor = artifacts.prepare(session);
    writeFileSync(session.sessionFile, header("unexpected-session") + assistant("wrong conversation"));
    expect(() => artifacts.readSummary(session.sessionFile, cursor)).toThrow(i18n.t("terminal.sessionMismatch"));
  });

  it("rejects an unterminated existing entry instead of joining another run onto it", () => {
    writeFileSync(session.sessionFile, header(session.sessionId).trimEnd());
    expect(() => artifacts.prepare(session)).toThrow(i18n.t("terminal.transcriptChanged"));
  });

  it.each(["truncated", "rewritten", "removed"])("detects a %s baseline", (change) => {
    const original = header(session.sessionId) + assistant("old answer");
    writeFileSync(session.sessionFile, original);
    const cursor = artifacts.prepare(session);
    if (change === "removed") rmSync(session.sessionFile);
    else writeFileSync(session.sessionFile, change === "truncated" ? "" : original.replace("old answer", "new answer") + assistant("suffix"));
    expect(() => artifacts.readSummary(session.sessionFile, cursor)).toThrow(i18n.t("terminal.transcriptChanged"));
  });

  it("does not swallow invalid new JSON or report previous output on parse failure", () => {
    writeFileSync(session.sessionFile, header(session.sessionId) + assistant("old"));
    const cursor = artifacts.prepare(session);
    appendFileSync(session.sessionFile, '{"type":"message"');
    expect(() => artifacts.readSummary(session.sessionFile, cursor)).toThrow(SyntaxError);
  });

  it.each(["error", "aborted"])("does not report a final %s assistant as success", (stopReason) => {
    const cursor = artifacts.prepare(session);
    writeFileSync(session.sessionFile, header(session.sessionId) + assistant("working") + JSON.stringify({
      type: "message", message: { role: "assistant", content: [], stopReason, errorMessage: "provider stopped" },
    }) + "\n");
    expect(() => artifacts.readSummary(session.sessionFile, cursor)).toThrow("provider stopped");
  });

  it("surfaces sidecar cleanup failures without destroying the session", () => {
    writeFileSync(session.sessionFile, header(session.sessionId));
    mkdirSync(`${session.sessionFile}.exit`);
    expect(() => artifacts.prepare(session)).toThrow();
    expect(readFileSync(session.sessionFile, "utf8")).toBe(header(session.sessionId));
  });
});
