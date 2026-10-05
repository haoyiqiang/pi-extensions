import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedTerminalSession } from "../src/backends/terminal/session-store.js";
import type { TerminalPolicy } from "../src/backends/terminal/prepare.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { i18n } from "../src/i18n.js";
import { sessionWitness } from "../src/backends/terminal/session-witness.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(extra: Partial<TerminalPolicy> = {}) {
  const root = mkdtempSync(join(tmpdir(), "managed-terminal-store-"));
  roots.push(root);
  const policy: TerminalPolicy = { type: "general-purpose", name: "stored", cwd: root,
    model: { provider: "faux", id: "model" }, tools: ["read"], systemPrompt: "resolved private prompt", maxTurns: 3, graceTurns: 2, ...extra };
  const config = { sessionDir: join(root, "sessions"), artifactDir: join(root, "runs"), agentDir: join(root, "agent") };
  return { root, policy, config, managed: ManagedTerminalSession.create(policy, config) };
}
function persist(managed: ManagedTerminalSession, change: (manager: SessionManager) => void) {
  const manager = managed.readReady().manager;
  managed.beginRun("invocation");
  change(manager);
  writeFileSync(managed.reference.sessionFile, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  managed.checkpoint("off", sessionWitness(manager));
}
function user(text: string) { return { role: "user", content: text, timestamp: 1 } as const; }
function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2, api: "faux", provider: "faux", model: "model", stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
}
function schema(type = "string") {
  const result = compileJsonSchema({ type: "object", properties: { answer: { type } }, required: ["answer"] });
  if (result.ok === false) throw new Error(result.message);
  return result.compiled;
}

describe("managed terminal session persistence", () => {
  it("persists private portable policy without runtime objects and enforces a lifetime owner", () => {
    const f = fixture({ model: { provider: "faux", id: "model", headers: { authorization: "never-serialize" } } as any });
    const path = f.managed.reference.sessionFile;
    const metadata = readFileSync(`${path}.pi-subagents.json`, "utf8");
    expect(metadata).not.toContain("never-serialize");
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}.pi-subagents.json`).mode & 0o777).toBe(0o600);
    }
    expect(() => ManagedTerminalSession.open(f.managed.reference)).toThrow(i18n.t("sessionStore.busy"));
    persist(f.managed, (manager) => { manager.appendMessage(user("first")); manager.appendMessage(assistant("old answer")); });
    const original = readFileSync(path);
    f.managed.release();
    f.managed.release();
    const reopened = ManagedTerminalSession.open(f.managed.reference);
    expect(reopened.reference).toEqual(f.managed.reference);
    expect(reopened.policy).toMatchObject({ maxTurns: 3, graceTurns: 2, thinkingLevel: "off" });
    expect(JSON.stringify(reopened.readReady().manager.buildSessionProjection().messages)).toContain("old answer");
    expect(readFileSync(path)).toEqual(original);
    reopened.release();
  });

  it("forks raw active-branch entries with compaction, edits and system state, leaving source untouched", () => {
    const f = fixture();
    persist(f.managed, (manager) => {
      manager.appendMessage({ role: "system", content: "", timestamp: 1, sections: { preamble: "system checkpoint" }, toolsAdded: [] });
      manager.appendMessage(user("old history"));
      manager.appendMessage(assistant("old response"));
      const branch = manager.appendMessage(user("kept request"));
      manager.appendMessage(assistant("ABANDONED BRANCH"));
      manager.branch(branch);
      manager.appendMessage(assistant("chosen response"));
      manager.appendCompaction("summary", branch, 100);
      const target = manager.appendMessage(user("UNEDITED TEXT"));
      manager.appendContextEdit(target, { content: "edited text" });
      manager.appendThinkingLevelChange("low");
      manager.appendCustomEntry("opaque-fixture", { preserved: true });
    });
    const before = readFileSync(f.managed.reference.sessionFile);
    const source = f.managed.readReady().manager;
    const fork = f.managed.fork(f.config);
    const forked = fork.readReady().manager;
    expect(fork.reference.sessionId).not.toBe(f.managed.reference.sessionId);
    expect(fork.reference.sessionFile).not.toBe(f.managed.reference.sessionFile);
    expect(forked.getHeader()?.parentSession).toBe(f.managed.reference.sessionFile);
    expect(forked.getEntries()).toEqual(source.getBranch());
    expect(forked.buildSessionProjection().messages).toEqual(source.buildSessionProjection().messages);
    expect(JSON.stringify(forked.buildSessionProjection().messages)).not.toContain("ABANDONED BRANCH");
    expect(JSON.stringify(forked.buildSessionProjection().messages)).not.toContain("UNEDITED TEXT");
    persist(fork, (manager) => { manager.appendMessage(user("fork only")); manager.appendMessage(assistant("new branch answer")); });
    expect(readFileSync(f.managed.reference.sessionFile)).toEqual(before);
    fork.release();
    f.managed.release();
  });

  it("requires an explicitly matching validator when restoring or forking a structured session", () => {
    const compiled = schema();
    const f = fixture({ structuredSchema: compiled.schema });
    expect(() => f.managed.fork(f.config)).toThrow(i18n.t("sessionStore.validatorRequired"));
    f.managed.release();
    expect(() => ManagedTerminalSession.open(f.managed.reference)).toThrow(i18n.t("sessionStore.validatorRequired"));
    expect(() => ManagedTerminalSession.open(f.managed.reference, { structuredOutput: schema("number") })).toThrow(i18n.t("sessionStore.schemaMismatch"));
    const restored = ManagedTerminalSession.open(f.managed.reference, { structuredOutput: compiled });
    expect(restored.policy.structuredSchema).toEqual(compiled.schema);
    restored.release();
  });

  it.each(["running", "quarantined"])("will not restore %s state even if an operator removed the old lease", (state) => {
    const f = fixture();
    f.managed.beginRun("interrupted");
    if (state === "quarantined") f.managed.quarantine();
    expect(() => f.managed.release()).toThrow(i18n.t("sessionStore.unsafe"));
    rmSync(`${f.managed.reference.sessionFile}.pi-subagents.lock`, { recursive: true }); // fault injection, not production recovery
    expect(() => ManagedTerminalSession.open(f.managed.reference)).toThrow(i18n.t("sessionStore.unsafe"));
  });

  it.each(["truncated", "rewritten", "appended"])("rejects a changed ready checkpoint: %s", (kind) => {
    const f = fixture();
    const path = f.managed.reference.sessionFile;
    f.managed.release();
    const header = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "truncated") writeFileSync(path, JSON.stringify(header));
    else if (kind === "rewritten") writeFileSync(path, JSON.stringify({ ...header, id: "wrong" }) + "\n");
    else appendFileSync(path, JSON.stringify({ type: "custom", id: "new", parentId: null, timestamp: "now", customType: "external" }) + "\n");
    expect(() => ManagedTerminalSession.open(f.managed.reference)).toThrow(i18n.t("sessionStore.invalidFile"));
  });

  it.each(["malformed", "duplicate id", "missing parent", "second header"])("rejects invalid writes instead of letting Pi skip them: %s", (kind) => {
    const f = fixture();
    f.managed.beginRun("invalid append");
    const row = { type: "custom", id: "entry", parentId: null, timestamp: "now", customType: "test" };
    const append = kind === "malformed" ? "{broken\n" : kind === "duplicate id" ? `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`
      : kind === "missing parent" ? JSON.stringify({ ...row, parentId: "missing" }) + "\n" : readFileSync(f.managed.reference.sessionFile, "utf8");
    appendFileSync(f.managed.reference.sessionFile, append);
    expect(() => f.managed.checkpoint()).toThrow(i18n.t("sessionStore.invalidFile"));
  });

  it("will not adopt a raw JSONL, copied identity, or a foreign backend reference", () => {
    const f = fixture();
    f.managed.release();
    expect(() => ManagedTerminalSession.open({ ...f.managed.reference, backend: "embedded" })).toThrow();
    const clone = join(f.root, "copied.jsonl");
    copyFileSync(f.managed.reference.sessionFile, clone);
    expect(() => ManagedTerminalSession.open({ ...f.managed.reference, sessionFile: clone })).toThrow(i18n.t("sessionStore.invalidRecord"));
    copyFileSync(`${f.managed.reference.sessionFile}.pi-subagents.json`, `${clone}.pi-subagents.json`);
    expect(() => ManagedTerminalSession.open({ ...f.managed.reference, sessionFile: clone })).toThrow(i18n.t("sessionStore.invalidRecord"));
  });

  it.each(["unpersisted entries", "memory-only leaf"])("will not certify finalized state that differs from disk: %s", (kind) => {
    const f = fixture();
    persist(f.managed, (manager) => { manager.appendMessage(user("one")); manager.appendMessage(assistant("two")); });
    const manager = f.managed.readReady().manager;
    f.managed.beginRun("inconsistent");
    if (kind === "unpersisted entries") manager.appendMessage(user("not flushed"));
    else manager.resetLeaf();
    expect(() => f.managed.checkpoint("off", sessionWitness(manager))).toThrow(i18n.t("sessionStore.invalidFile"));
  });

  it("rejects policy changes while a handle owns its lease", () => {
    const f = fixture();
    const path = `${f.managed.reference.sessionFile}.pi-subagents.json`;
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, policy: { ...record.policy, maxTurns: 900 } }));
    expect(() => f.managed.beginRun("bad")).toThrow(i18n.t("sessionStore.invalidRecord"));
  });
});
