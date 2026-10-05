/** The same workflow consumer contract on the real SDK and real offline Pi CLI. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultMaxTurns, getGraceTurns, setDefaultMaxTurns, setGraceTurns } from "../src/backends/embedded.js";
import { inspectManagedSession } from "../src/backends/managed-session.js";
import type { ExecutionBackendKind } from "../src/backends/session-reference.js";
import { i18n } from "../src/i18n.js";
import type { WorkflowSessionContext } from "../src/workflow/execution-contract.js";
import { WorkflowExecutionAbortError } from "../src/workflow/execution-host.js";
import { TERMINAL_FAUX_MARKERS } from "./fixtures/terminal-faux-provider.js";
import { payload, prompt, SAVED_PROMPT, SCHEMA, within, workflowRealBackend } from "./helpers/workflow-real-backends.js";

// Cold CLI imports compete with other workspace workers; production deadlines are unchanged.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const fixtures: ReturnType<typeof workflowRealBackend>[] = [];
let previousOffline: string | undefined;
let previousVersionCheck: string | undefined;
let previousMaxTurns: number | undefined;
let previousGraceTurns: number;

beforeEach(() => {
  previousOffline = process.env.PI_OFFLINE;
  previousVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
  previousMaxTurns = getDefaultMaxTurns();
  previousGraceTurns = getGraceTurns();
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  setDefaultMaxTurns(undefined);
  setGraceTurns(2);
});
afterEach(async () => {
  try { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); }
  finally {
    setDefaultMaxTurns(previousMaxTurns);
    setGraceTurns(previousGraceTurns);
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousVersionCheck;
  }
});

function fixture(kind: ExecutionBackendKind) {
  const value = workflowRealBackend(kind);
  fixtures.push(value);
  return value;
}
function identity(child: WorkflowSessionContext) {
  const file = child.sessionManager.getSessionFile();
  expect(file).toBeTypeOf("string");
  return { file: file!, id: child.sessionManager.getSessionId() };
}
function branch(child: WorkflowSessionContext): SessionEntry[] {
  const entries = child.sessionManager.getBranch();
  expect(Array.isArray(entries)).toBe(true);
  return entries as SessionEntry[];
}
function rows(file: string) {
  return readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
}
function diskManager(file: string, cwd: string) {
  // Read-only reconstruction, not SessionManager.open (which could acquire/repair state).
  return SessionManager.inMemory(cwd, undefined, rows(file));
}
function users(entries: SessionEntry[]): string[] {
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "user"
    ? [typeof entry.message.content === "string" ? entry.message.content
      : entry.message.content.map(block => block.type === "text" ? block.text : "").join("")]
    : []);
}
function expectUserPrompts(entries: SessionEntry[], prompts: string[]) {
  const actual = users(entries);
  expect(actual).toHaveLength(prompts.length);
  // The CLI's @prompt.txt transport preserves a file envelope; do not normalize raw entries.
  prompts.forEach((prompt, index) => {
    expect(actual[index]).toContain(prompt);
    expect(actual[index].split(prompt)).toHaveLength(2);
  });
}
function assistantCount(entries: SessionEntry[]) {
  return entries.filter(entry => entry.type === "message" && entry.message.role === "assistant").length;
}
function structuredArguments(entries: SessionEntry[]) {
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.filter(block => block.type === "toolCall" && block.name === "StructuredOutput")
      .map(block => block.type === "toolCall" ? block.arguments : undefined)
    : []);
}
const sidecar = (file: string) => `${file}.pi-subagents.json`;
const lock = (file: string) => `${file}.pi-subagents.lock`;

for (const kind of ["embedded", "terminal"] as const) {
  describe.skipIf(kind === "terminal" && process.platform === "win32")(`workflow execution provider: real ${kind}`, () => {
    it("runs, continues, forks inside an owned callback, closes and reattaches without prompt replay", async () => {
      const f = fixture(kind);
      const first = f.execution("first-run");
      const selection = { model: f.modelKey, thinking: "off" as const };
      expect(first.host.maxConcurrency).toBe(1);
      const freshCallback = vi.fn();
      const forkCallback = vi.fn();
      const reattachCallback = vi.fn();
      f.script("fresh");

      const source = await first.host.spawnChild({
        prompt: prompt("fresh"), model: selection,
        withSession: async child => {
          freshCallback();
          const source = identity(child);
          expect(dirname(source.file)).toBe(join(first.childSessionsDir, "managed"));
          expect(rows(source.file)[0]).toMatchObject({ type: "session", version: 3, id: source.id, cwd: f.cwd });
          expect(existsSync(lock(source.file))).toBe(true);
          await child.waitForIdle();
          // Callback ownership is not invocation capacity: waiting for host idle must already resolve.
          await within(first.host.waitForIdle(), 1_000, "host counted an idle callback against invocation capacity");
          const initial = branch(child);
          const native = diskManager(source.file, f.cwd);
          expect(initial).toEqual(native.getBranch());
          expect(initial).not.toEqual(native.buildSessionContext().messages);
          expect(initial.some(entry => entry.type !== "message")).toBe(true);
          expect(initial.every(entry => typeof entry.id === "string" && typeof entry.timestamp === "string")).toBe(true);
          expect(new Set(initial.map(entry => entry.id)).size).toBe(initial.length);
          for (let index = 1; index < initial.length; index++) expect(initial[index].parentId).toBe(initial[index - 1].id);
          expectUserPrompts(initial, [prompt("fresh")]);
          expect(assistantCount(initial)).toBe(2);
          expect(structuredArguments(initial)).toEqual([payload("fresh")]);
          expect(f.calls()).toBe(kind === "embedded" ? 2 : 1);
          expect(f.provider.readSessionBranch!(source.file)).toEqual(initial);
          // Both observer APIs return detached raw envelopes, not a writable native entry tree.
          const mutated = branch(child);
          mutated[0].id = "consumer-mutation";
          const read = f.provider.readSessionBranch!(source.file)!;
          read[0].type = "consumer-mutation";
          expect(branch(child)).toEqual(initial);
          expect(f.provider.readSessionBranch!(source.file)).toEqual(initial);

          const originalPolicy = inspectManagedSession(source.file, kind).policy;
          expect(originalPolicy).toMatchObject({
            model: { provider: f.model.provider, id: f.model.id }, thinkingLevel: "off", tools: ["ls"],
            structuredSchema: SCHEMA, maxTurns: 8, graceTurns: 2,
          });
          expect(originalPolicy.systemPrompt).toContain(SAVED_PROMPT);
          f.configure({ builtinToolNames: ["read"], systemPrompt: "REPLACEMENT_MUST_NOT_LEAK", maxTurns: 1,
            model: "unavailable-workflow-provider/not-the-saved-model", thinking: "high" });
          setDefaultMaxTurns(1);
          setGraceTurns(9);

          const gate = f.gateNextInvocation();
          f.script("continued");
          const continuation = child.sendUserMessage(prompt("continued"));
          void continuation.catch(() => {});
          await within(gate.entered, 15_000, "real continuation did not enter its test gate");
          let childIdle = false;
          let hostIdle = false;
          const childWaiting = child.waitForIdle().then(() => { childIdle = true; });
          const hostWaiting = first.host.waitForIdle().then(() => { hostIdle = true; });
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(childIdle).toBe(false);
          expect(hostIdle).toBe(false);
          await expect(child.sendUserMessage("must not become a steer or another user message")).rejects.toThrow(i18n.t("workflowExecution.busy"));
          gate.release();
          await Promise.all([continuation, childWaiting, hostWaiting]);
          expect(childIdle && hostIdle).toBe(true);
          expect(identity(child)).toEqual(source);
          const sourceBranch = branch(child);
          expect(sourceBranch.slice(0, initial.length)).toEqual(initial);
          expectUserPrompts(sourceBranch, [prompt("fresh"), prompt("continued")]);
          expect(structuredArguments(sourceBranch)).toEqual([payload("fresh"), payload("continued")]);
          expect(assistantCount(sourceBranch)).toBe(4);
          const originalBytes = readFileSync(source.file);
          const originalRecord = readFileSync(sidecar(source.file));
          const callsBeforeFork = f.calls();

          // Re-enter the HOST while the ancestor callback still owns its source lease.
          // maxConcurrency=1 must bound invocations, not the lifetime of either callback.
          const fork = await within(first.host.spawnChild({
            fork: { sessionFile: source.file }, prompt: "/skill:fork-prompt-must-not-run", model: selection,
            withSession: async forked => {
              forkCallback();
              const fork = identity(forked);
              expect(fork.id).not.toBe(source.id);
              expect(fork.file).not.toBe(source.file);
              expect(dirname(fork.file)).toBe(join(first.childSessionsDir, "managed"));
              expect(existsSync(lock(source.file))).toBe(true);
              expect(existsSync(lock(fork.file))).toBe(true);
              expect(rows(fork.file)[0]).toMatchObject({ id: fork.id, parentSession: source.file });
              expect(branch(forked)).toEqual(sourceBranch);
              expect(f.calls()).toBe(callsBeforeFork);
              expect(inspectManagedSession(fork.file, kind).policy).toEqual(originalPolicy);
              await forked.waitForIdle();
              await first.host.waitForIdle();
              f.script("fork-only");
              await forked.sendUserMessage(prompt("fork-only"));
              const result = branch(forked);
              expect(result.slice(0, sourceBranch.length)).toEqual(sourceBranch);
              expect(result[sourceBranch.length].parentId).toBe(sourceBranch.at(-1)!.id);
              expectUserPrompts(result.slice(sourceBranch.length), [prompt("fork-only")]);
              expect(structuredArguments(result)).toEqual([payload("fresh"), payload("continued"), payload("fork-only")]);
              expect(assistantCount(result)).toBe(6);
              const projected = diskManager(fork.file, f.cwd).buildSessionContext().messages;
              expect(getCurrentSystemPrompt(projected)).toContain(SAVED_PROMPT);
              expect(getCurrentSystemPrompt(projected)).not.toContain("REPLACEMENT_MUST_NOT_LEAK");
              expect(getCurrentTools(projected).map(tool => tool.name).sort()).toEqual(["StructuredOutput", "ls"]);
              expect(readFileSync(source.file)).toEqual(originalBytes);
              expect(readFileSync(sidecar(source.file))).toEqual(originalRecord);
              return { ...fork, bytes: readFileSync(fork.file) };
            },
          }), 90_000, "fork deadlocked behind its ancestor callback at maxConcurrency=1");
          expect(branch(child)).toEqual(sourceBranch);
          expect(existsSync(lock(source.file))).toBe(true);
          expect(existsSync(lock(fork.file))).toBe(false);
          expect(readFileSync(source.file)).toEqual(originalBytes);
          return { ...source, branch: sourceBranch, policy: originalPolicy, bytes: originalBytes, fork };
        },
      });
      expect(freshCallback).toHaveBeenCalledTimes(1);
      expect(forkCallback).toHaveBeenCalledTimes(1);
      expect(f.backendDirs).toHaveLength(1);
      expect(readdirSync(first.childSessionsDir).filter(name => name.endsWith(".jsonl"))).toEqual([]);
      expect(existsSync(source.file)).toBe(true); // invisible to the consumer's top-level orphan sweep
      await first.close();
      expect(first.signal.aborted).toBe(true);
      expect(existsSync(lock(source.file))).toBe(false);
      expect(f.provider.readSessionBranch!(source.file)).toEqual(source.branch);
      expect(readFileSync(source.file)).toEqual(source.bytes);

      const second = f.execution("second-run");
      expect(f.backendDirs).toEqual([
        join(first.childSessionsDir, "managed"), join(second.childSessionsDir, "managed"),
      ]);
      const callsBeforeRestore = f.calls();
      const refusedCallback = vi.fn();
      for (const method of ["reattach", "fork"] as const) {
        await expect(second.host.spawnChild({
          [method]: { sessionFile: source.file }, prompt: "must never be sent",
          model: { model: f.alternateModelKey, thinking: "off" }, withSession: refusedCallback,
        })).rejects.toThrow(i18n.t("workflowExecution.policyOverride"));
        if (kind === "embedded") {
          await expect(second.host.spawnChild({
            [method]: { sessionFile: source.file }, prompt: "must never be sent",
            model: { ...selection, thinking: "high" }, withSession: refusedCallback,
          })).rejects.toThrow(i18n.t("workflowExecution.policyOverride"));
        }
      }
      expect(refusedCallback).not.toHaveBeenCalled();
      expect(f.calls()).toBe(callsBeforeRestore);
      expect(readFileSync(source.file)).toEqual(source.bytes);
      expect(existsSync(lock(source.file))).toBe(false);

      const finalBranch = await second.host.spawnChild({
        reattach: { sessionFile: source.file }, prompt: "/skill:reattach-prompt-must-not-run", model: selection,
        withSession: async child => {
          reattachCallback();
          expect(identity(child)).toEqual({ file: source.file, id: source.id });
          expect(branch(child)).toEqual(source.branch);
          expect(f.calls()).toBe(callsBeforeRestore);
          expect(readFileSync(source.file)).toEqual(source.bytes);
          expect(inspectManagedSession(source.file, kind).policy).toEqual(source.policy);
          await child.waitForIdle();
          await second.host.waitForIdle();
          f.script("reattached-only");
          await child.sendUserMessage(prompt("reattached-only"));
          const final = branch(child);
          expect(final.slice(0, source.branch.length)).toEqual(source.branch);
          expectUserPrompts(final.slice(source.branch.length), [prompt("reattached-only")]);
          expect(assistantCount(final)).toBe(6);
          expect(identity(child)).toEqual({ file: source.file, id: source.id });
          expect(readFileSync(source.fork.file)).toEqual(source.fork.bytes);
          expect(inspectManagedSession(source.file, kind).policy).toEqual(source.policy);
          return final;
        },
      });
      expect(reattachCallback).toHaveBeenCalledTimes(1);
      await second.close();
      expect(existsSync(lock(source.file))).toBe(false);
      expect(f.provider.readSessionBranch!(source.file)).toEqual(finalBranch);
      expect(f.provider.readSessionBranch!(source.fork.file)).toEqual(diskManager(source.fork.file, f.cwd).getBranch());
      expect(f.calls()).toBe(kind === "embedded" ? 8 : 4);
      await f.transport.assertRetired();

      // Exact nested paths survive execution boundaries. Never guess a top-level filename
      // or fall back to an unmanaged/invalid transcript when inspection cannot verify it.
      const bare = join(f.root, "unmanaged.jsonl");
      const malformed = join(f.root, "malformed.jsonl");
      writeFileSync(bare, readFileSync(source.file));
      writeFileSync(malformed, "{not-json}\n");
      const unchanged = readFileSync(source.file);
      const unchangedRecord = readFileSync(sidecar(source.file));
      for (const invalid of ["", relative(process.cwd(), source.file), join(f.root, "missing.jsonl"),
        join(first.childSessionsDir, basename(source.file)), bare, malformed]) {
        expect(f.provider.readSessionBranch!(invalid)).toBeUndefined();
      }
      expect(readFileSync(source.file)).toEqual(unchanged);
      expect(readFileSync(sidecar(source.file))).toEqual(unchangedRecord);
      expect(existsSync(sidecar(bare))).toBe(false);
      expect(existsSync(lock(bare))).toBe(false);
      expect(existsSync(lock(source.file))).toBe(false);
      expect(f.calls()).toBe(kind === "embedded" ? 8 : 4);
    });
  });
}

describe.skipIf(process.platform === "win32")("workflow cancellation with a real offline terminal child", () => {
  it("rejects the child scope, skips its callback and quarantines rather than fabricating a settled branch", async () => {
    const f = fixture("terminal");
    const execution = f.execution("cancelled-run");
    const controller = new AbortController();
    const callback = vi.fn();
    const running = execution.host.spawnChild({
      prompt: `${TERMINAL_FAUX_MARKERS.slow} cancel this actual model request`,
      model: { model: f.modelKey, thinking: "off" }, signal: controller.signal, withSession: callback,
    });
    // Observe rejection before cancellation to avoid an unhandled-rejection timing gap.
    const rejected = expect(running).rejects.toBeInstanceOf(WorkflowExecutionAbortError);
    const file = await within(Promise.race([
      f.active,
      running.then(() => { throw new Error("slow child completed without its real streamed active marker"); }),
    ]), 75_000, "real workflow child never started its slow model request");
    expect(dirname(file)).toBe(join(execution.childSessionsDir, "managed"));
    expect(f.provider.readSessionBranch!(file)).toBeUndefined(); // the writer transaction is not settled
    let idle = false;
    const idleWait = execution.host.waitForIdle().then(() => { idle = true; });
    void idleWait.catch(() => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(idle).toBe(false);
    controller.abort(new Error("offline consumer cancelled child scope"));
    await within(rejected, 5_000, "workflow cancellation did not reject the consumer promptly");
    expect(callback).not.toHaveBeenCalled();
    expect(execution.signal.aborted).toBe(false); // scope cancellation is not run disposal
    await within(execution.close(), 15_000, "cancelled real CLI child did not close");
    await expect(idleWait).rejects.toBeInstanceOf(WorkflowExecutionAbortError);
    expect(idle).toBe(false);
    await f.transport.assertRetired();
    expect(f.transport.created).toHaveLength(1);
    expect(JSON.parse(readFileSync(sidecar(file), "utf8")).state).toBe("quarantined");
    expect(f.provider.readSessionBranch!(file)).toBeUndefined();
    const before = readFileSync(file);
    const retry = f.execution("after-cancellation");
    for (const method of ["reattach", "fork"] as const) {
      await expect(retry.host.spawnChild({
        [method]: { sessionFile: file }, prompt: "must not replay the cancelled prompt", withSession: callback,
      })).rejects.toThrow();
    }
    expect(callback).not.toHaveBeenCalled();
    expect(readFileSync(file)).toEqual(before);
    expect(f.transport.created).toHaveLength(1);
  });
});
