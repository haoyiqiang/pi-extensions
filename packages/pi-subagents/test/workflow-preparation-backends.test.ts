/** Real SDK sessions and offline Pi CLI children; only responses/auth/terminal transport are fixtures. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultMaxTurns, getGraceTurns, setDefaultMaxTurns, setGraceTurns } from "../src/backends/embedded.js";
import { inspectManagedSession } from "../src/backends/managed-session.js";
import type { ExecutionBackendKind } from "../src/backends/session-reference.js";
import { i18n } from "../src/i18n.js";
import type { ManagedWorkflowSessionContext } from "../src/workflow/execution-contract.js";
import * as workflowProvider from "../src/workflow/execution-provider.js";
import { WorkflowExecutionAbortError } from "../src/workflow/execution-host.js";
import type { PreparedWorkflowPrompt, WorkflowPromptPreparer } from "../src/workflow/prompt-preparation.js";
import { createWorkflowSkillPreparer } from "../src/workflow/skill-resources.js";
import { TERMINAL_FAUX_JSON_PREFIX, TERMINAL_FAUX_MARKERS } from "./fixtures/terminal-faux-provider.js";
import { prompt, SAVED_PROMPT, within, workflowRealBackend } from "./helpers/workflow-real-backends.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const createProvider = workflowProvider.createWorkflowExecutionProvider;
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
  try { for (const f of fixtures.splice(0)) await f.cleanup(); }
  finally {
    vi.restoreAllMocks();
    setDefaultMaxTurns(previousMaxTurns);
    setGraceTurns(previousGraceTurns);
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousVersionCheck;
  }
});

function fixture(kind: ExecutionBackendKind, preparePrompt: WorkflowPromptPreparer) {
  // Reuse the unchanged real-backend fixture. Decorate only its owner's provider options;
  // the provider, host, manager, backend, session persistence and CLI execution remain real.
  const inject = vi.spyOn(workflowProvider, "createWorkflowExecutionProvider")
    .mockImplementation(options => createProvider({ ...options, preparePrompt }));
  try {
    const f = workflowRealBackend(kind);
    fixtures.push(f);
    expect(inject).toHaveBeenCalledOnce();
    return f;
  } finally { inject.mockRestore(); }
}
function branch(child: ManagedWorkflowSessionContext): SessionEntry[] {
  return child.sessionManager.getBranch() as SessionEntry[];
}
function users(entries: SessionEntry[]): string[] {
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "user"
    ? [typeof entry.message.content === "string" ? entry.message.content
      : entry.message.content.map(block => block.type === "text" ? block.text : "").join("")]
    : []);
}
function expectExpanded(entries: SessionEntry[], preparations: PreparedWorkflowPrompt[]) {
  const messages = users(entries);
  expect(messages).toHaveLength(preparations.length);
  preparations.forEach((prepared, index) => {
    // CLI @file transport adds an envelope; preserve it rather than normalizing history.
    expect(messages[index]).toContain(prepared.text);
    expect(messages[index].split(prepared.text)).toHaveLength(2);
    expect(messages[index].split("APPROVED_SNAPSHOT")).toHaveLength(2);
    expect(messages[index]).not.toContain("/skill:");
    expect(messages[index]).not.toContain("$1");
    expect(messages[index]).not.toContain("${SKILL_DIR}");
    expect(messages[index]).not.toContain("EDITED_AFTER_APPROVAL");
  });
}
function saved(file: string) {
  return { transcript: readFileSync(file), policy: readFileSync(`${file}.pi-subagents.json`) };
}
function projected(file: string, cwd: string) {
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  return SessionManager.inMemory(cwd, undefined, rows).buildSessionContext().messages;
}
const lock = (file: string) => `${file}.pi-subagents.lock`;

for (const kind of ["embedded", "terminal"] as const) {
  describe.skipIf(kind === "terminal" && process.platform === "win32")(`workflow preparation with real ${kind}`, () => {
    it("shares an approved positional skill across fresh, continuation, owned fork and later reattach without replay or policy changes", async () => {
      let approved!: WorkflowPromptPreparer;
      const preparePrompt = vi.fn<WorkflowPromptPreparer>((input, context) => approved(input, context));
      const f = fixture(kind, preparePrompt);
      f.configure({ builtinToolNames: ["read", "bash"] });
      const baseDir = join(f.root, "approved");
      mkdirSync(baseDir);
      const filePath = join(baseDir, "SKILL.md");
      const raw = ["---", "name: approved", "description: Explicit offline workflow fixture", "---",
        "APPROVED_SNAPSHOT first=$1 second=$2 assets=${SKILL_DIR}",
        TERMINAL_FAUX_MARKERS.structured,
        `${TERMINAL_FAUX_JSON_PREFIX}{"file":"目录/$1.ts","line":7}`, ""].join("\n");
      writeFileSync(filePath, raw);
      const sha256 = createHash("sha256").update(raw).digest("hex");
      approved = createWorkflowSkillPreparer([{ name: "approved", filePath, baseDir, format: "positional-v1",
        expectedSha256: sha256, requiredTools: ["read", "bash"] }]);
      const input = (name: string) => `/skill:approved ${name} "two words"`;
      const selection = { model: f.modelKey, thinking: "off" as const };
      const first = f.execution("approved-first");
      expect(first.host.capabilities).toMatchObject({ plainPromptsOnly: false, promptPreparation: true });
      expect(first.host.maxConcurrency).toBe(1);
      const preparations: PreparedWorkflowPrompt[] = [];
      const checkPrepared = (child: ManagedWorkflowSessionContext, name: string) => {
        const prepared = child.preparation!;
        expect(prepared.text).toContain(`APPROVED_SNAPSHOT first=${name} second=two words assets=${baseDir}`);
        expect(prepared.text).toContain(sha256);
        expect(prepared.requiredTools).toEqual(["read", "bash"]);
        expect(prepared.resources).toEqual([{ kind: "skill", name: "approved", filePath, baseDir, format: "positional-v1", sha256 }]);
        for (const value of [prepared, prepared.requiredTools, prepared.resources, prepared.resources![0]]) {
          expect(Object.isFrozen(value)).toBe(true);
        }
        return prepared;
      };
      f.script("fresh");
      const source = await first.host.spawnChild({ prompt: input("fresh"), model: selection, withSession: async child => {
        const ref = child.reference;
        expect(dirname(ref.sessionFile)).toBe(join(first.childSessionsDir, "managed"));
        expect(preparePrompt).toHaveBeenCalledOnce();
        expect(preparePrompt.mock.calls[0][1].session).toBeUndefined();
        expect(preparePrompt.mock.calls[0][1].cwd).toBe(f.cwd);
        preparations.push(checkPrepared(child, "fresh"));
        const initial = branch(child);
        expectExpanded(initial, preparations);
        const policy = inspectManagedSession(ref.sessionFile, kind).policy;
        expect(policy.tools).toEqual(["read", "bash"]);
        const savedTools = ["StructuredOutput", "bash", "read"];
        expect(getCurrentTools(projected(ref.sessionFile, f.cwd)).map(tool => tool.name).sort()).toEqual(savedTools);
        writeFileSync(filePath, "EDITED_AFTER_APPROVAL");
        // Restoration/continuation must not grant this new default or lose saved read/bash.
        f.configure({ builtinToolNames: ["write"], disallowedTools: ["read", "bash"], systemPrompt: "REPLACEMENT_SYSTEM" });
        f.script("continued");
        await child.sendUserMessage(input("continued"));
        preparations.push(checkPrepared(child, "continued"));
        expect(preparePrompt.mock.calls[1][1].session).toEqual(ref);
        expect(preparePrompt.mock.calls[1][1].signal).toBe(child.signal);
        expect(Object.isFrozen(preparePrompt.mock.calls[1][1].session)).toBe(true);
        expect(inspectManagedSession(ref.sessionFile, kind).policy).toEqual(policy);
        const beforeFork = branch(child);
        expect(beforeFork.slice(0, initial.length)).toEqual(initial);
        expectExpanded(beforeFork, preparations);
        const bytes = saved(ref.sessionFile);
        const callsBeforeFork = f.calls();
        const fork = await within(first.host.spawnChild({ fork: { sessionFile: ref.sessionFile },
          prompt: "/skill:unapproved-must-not-be-prepared", model: selection, withSession: async forked => {
            expect(forked.preparation).toBeUndefined();
            expect(preparePrompt).toHaveBeenCalledTimes(2);
            expect(f.calls()).toBe(callsBeforeFork);
            expect(forked.reference.sessionId).not.toBe(ref.sessionId);
            expect(forked.reference.sessionFile).not.toBe(ref.sessionFile);
            expect(branch(forked)).toEqual(beforeFork);
            expect(inspectManagedSession(forked.reference.sessionFile, kind).policy).toEqual(policy);
            await forked.waitForIdle();
            await first.host.waitForIdle();
            f.script("forked");
            await forked.sendUserMessage(input("forked"));
            const prepared = checkPrepared(forked, "forked");
            expect(preparePrompt.mock.calls[2][1].session).toEqual(forked.reference);
            expect(preparePrompt.mock.calls[2][1].cwd).toBe(f.cwd);
            const afterFork = branch(forked);
            expect(afterFork.slice(0, beforeFork.length)).toEqual(beforeFork);
            expect(afterFork[beforeFork.length].parentId).toBe(beforeFork.at(-1)!.id);
            expectExpanded(afterFork, [...preparations, prepared]);
            const messages = projected(forked.reference.sessionFile, f.cwd);
            expect(getCurrentTools(messages).map(tool => tool.name).sort()).toEqual(savedTools);
            expect(getCurrentSystemPrompt(messages)).toContain(SAVED_PROMPT);
            expect(getCurrentSystemPrompt(messages)).not.toContain("REPLACEMENT_SYSTEM");
            expect(saved(ref.sessionFile)).toEqual(bytes);
            return { reference: forked.reference, bytes: saved(forked.reference.sessionFile), branch: afterFork };
          } }), 90_000, "prepared fork deadlocked behind its owned ancestor at concurrency one");
        expect(branch(child)).toEqual(beforeFork);
        expect(saved(ref.sessionFile)).toEqual(bytes);
        expect(existsSync(lock(fork.reference.sessionFile))).toBe(false);
        return { reference: ref, branch: beforeFork, bytes, policy, fork };
      } });
      await first.close();
      expect(first.signal.aborted).toBe(true);
      expect(existsSync(lock(source.reference.sessionFile))).toBe(false);
      expect(f.provider.readSessionBranch!(source.reference.sessionFile)).toEqual(source.branch);
      const second = f.execution("approved-second");
      const callsBeforeRestore = f.calls();
      await second.host.spawnChild({ reattach: { sessionFile: source.reference.sessionFile },
        prompt: "/skill:also-unapproved-and-ignored", model: selection, withSession: async child => {
          expect(child.reference).toEqual(source.reference);
          expect(child.preparation).toBeUndefined();
          expect(preparePrompt).toHaveBeenCalledTimes(3);
          expect(f.calls()).toBe(callsBeforeRestore);
          expect(branch(child)).toEqual(source.branch);
          expect(saved(source.reference.sessionFile)).toEqual(source.bytes);
          f.script("reattached");
          await child.sendUserMessage(input("reattached"));
          const prepared = checkPrepared(child, "reattached");
          const final = branch(child);
          expectExpanded(final, [...preparations, prepared]);
          expect(final.slice(0, source.branch.length)).toEqual(source.branch);
          expect(preparePrompt.mock.calls[3][1].session).toEqual(source.reference);
          expect(preparePrompt.mock.calls[3][1].cwd).toBe(f.cwd);
          expect(saved(source.fork.reference.sessionFile)).toEqual(source.fork.bytes);
          expect(inspectManagedSession(source.reference.sessionFile, kind).policy).toEqual(source.policy);
        } });
      await second.close();
      await f.transport.assertRetired();
      expect(existsSync(lock(source.reference.sessionFile))).toBe(false);
      expect(preparePrompt.mock.calls.map(([text]) => text)).toEqual([input("fresh"), input("continued"), input("forked"), input("reattached")]);
      expect(f.calls()).toBe(kind === "embedded" ? 8 : 4);
      expect(f.provider.readSessionBranch!(source.fork.reference.sessionFile)).toEqual(source.fork.branch);
      expect(readdirSync(first.childSessionsDir).filter(name => name.endsWith(".jsonl"))).toEqual([]);
    });

    it("rejects fresh missing tools before a model request or terminal launch, without granting them", async () => {
      const preparePrompt = vi.fn<WorkflowPromptPreparer>(() => ({ text: prompt("must-not-run"), requiredTools: ["read", "bash"] }));
      const f = fixture(kind, preparePrompt); // The fixed fixture policy contains ls only.
      const execution = f.execution("missing-fresh-tools");
      const callback = vi.fn();
      await expect(execution.host.spawnChild({ prompt: "/skill:needs-read-and-bash", withSession: callback }))
        .rejects.toThrow(i18n.t("toolRequirements.missing", { tools: "read, bash" }));
      expect(preparePrompt).toHaveBeenCalledOnce();
      expect(callback).not.toHaveBeenCalled();
      expect(f.calls()).toBe(0);
      expect(f.transport.created).toEqual([]);
      const managedDir = join(execution.childSessionsDir, "managed");
      expect(existsSync(managedDir) ? readdirSync(managedDir) : []).toEqual([]);
      expect(existsSync(join(f.root, "runs"))).toBe(false);
      await execution.close();
      await f.transport.assertRetired();
    });

    it("checks resumed requirements against saved tools and leaves a rejected continuation byte-for-byte clean", async () => {
      const preparePrompt = vi.fn<WorkflowPromptPreparer>((input) => ({
        text: prompt(input === "initial" ? "initial" : "rejected"), requiredTools: input === "initial" ? ["ls"] : ["write"],
      }));
      const f = fixture(kind, preparePrompt);
      const execution = f.execution("missing-resume-tool");
      f.script("initial");
      let clean!: { file: string; bytes: ReturnType<typeof saved>; calls: number; branch: SessionEntry[] };
      await expect(execution.host.spawnChild({ prompt: "initial", withSession: async child => {
        const file = child.reference.sessionFile;
        clean = { file, bytes: saved(file), calls: f.calls(), branch: branch(child) };
        const initialPreparation = child.preparation;
        f.configure({ builtinToolNames: ["write", "bash"] });
        await expect(child.sendUserMessage("requires-new-write-default"))
          .rejects.toThrow(i18n.t("toolRequirements.missing", { tools: "write" }));
        // Preparation describes the latest attempted input, not a successful-run receipt.
        expect(child.preparation).not.toBe(initialPreparation);
        expect(child.preparation!.requiredTools).toEqual(["write"]);
        expect(saved(file)).toEqual(clean.bytes);
        expect(f.calls()).toBe(clean.calls);
        expect(f.transport.created).toHaveLength(kind === "terminal" ? 1 : 0);
        expect(inspectManagedSession(file, kind).policy.tools).toEqual(["ls"]);
        expect(branch(child)).toEqual(clean.branch);
        expect(getCurrentTools(projected(file, f.cwd)).map(tool => tool.name).sort()).toEqual(["StructuredOutput", "ls"]);
        await expect(child.waitForIdle()).rejects.toThrow();
        return "caught failure cannot become workflow success";
      } })).rejects.toThrow(i18n.t("toolRequirements.missing", { tools: "write" }));
      await execution.close();
      expect(saved(clean.file)).toEqual(clean.bytes);
      expect(existsSync(lock(clean.file))).toBe(false);
      expect(f.provider.readSessionBranch!(clean.file)).toEqual(clean.branch);
      expect(f.calls()).toBe(clean.calls);
      await f.transport.assertRetired();
      expect(preparePrompt).toHaveBeenCalledTimes(2);
      expect(preparePrompt.mock.calls[1][1].session?.sessionFile).toBe(clean.file);
    });

    it("closes a cancelled async preparer without launching a late model request or CLI process", async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const preparePrompt = vi.fn<WorkflowPromptPreparer>(async () => {
        entered();
        await gate;
        return { text: prompt("late"), requiredTools: ["ls"] };
      });
      const f = fixture(kind, preparePrompt);
      const execution = f.execution("cancelled-preparation");
      const callback = vi.fn();
      const operation = execution.host.spawnChild({ prompt: "/skill:slow-owner", withSession: callback });
      const rejected = expect(operation).rejects.toBeInstanceOf(WorkflowExecutionAbortError);
      try {
        await within(started, 5_000, "owner preparer did not start");
        execution.dispose();
        await within(execution.close(), 5_000, "unpublished preparation held run close indefinitely");
        await rejected;
        expect(preparePrompt.mock.calls[0][1].signal.aborted).toBe(true);
      } finally { release(); }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(callback).not.toHaveBeenCalled();
      expect(f.calls()).toBe(0);
      expect(f.transport.created).toEqual([]);
      expect(existsSync(join(execution.childSessionsDir, "managed"))).toBe(false);
      await f.transport.assertRetired();
    });
  });
}
