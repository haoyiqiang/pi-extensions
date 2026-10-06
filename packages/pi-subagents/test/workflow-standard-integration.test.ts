import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const terminalScreens = vi.hoisted(() => [] as string[]);
// Keep the real process transport without discovering the developer's live mux.
vi.mock("pi-terminal-mux", async (importOriginal) => {
  const mux = await importOriginal<typeof import("pi-terminal-mux")>();
  return {
    ...mux,
    createSurface: mux.createHeadlessSurface,
    closeSurface(surface: string) {
      terminalScreens.push(mux.readScreen(surface, 100));
      mux.closeSurface(surface);
    },
  };
});
import { acts, defineWorkflow, produces, STOP, type Workflow } from "../../pi-workflow/src/api.ts";
import { opaque } from "../../pi-workflow/src/handle.ts";
import { resumeWorkflow, runWorkflow } from "../../pi-workflow/src/runner/index.ts";
import { readAllStages, readHeader, stateFilePath } from "../../pi-workflow/src/state/index.ts";
import {
  STANDARD_EXTENSION_TOOL,
  STANDARD_SKILL,
  STANDARD_SKILL_MARKER,
  standardWorkflowFixture,
} from "./helpers/workflow-standard.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const fixtures: ReturnType<typeof standardWorkflowFixture>[] = [];
function fixture(options: Parameters<typeof standardWorkflowFixture>[0] = {}) {
  const value = standardWorkflowFixture(options);
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  await Promise.allSettled(fixtures.splice(0).map(value => value.cleanup()));
});

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap(block => {
    if (!block || typeof block !== "object") return [];
    if ("text" in block && typeof (block as { text?: unknown }).text === "string") {
      return [(block as { text: string }).text];
    }
    return [];
  }).join("\n");
}

function userTexts(branch: readonly unknown[]): string[] {
  return branch.flatMap(entry => {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") return [];
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    return message?.role === "user" ? [textOf(message)] : [];
  });
}

function assistantCount(branch: readonly unknown[]): number {
  return branch.filter(entry => !!entry && typeof entry === "object"
    && (entry as { type?: unknown }).type === "message"
    && (entry as { message?: { role?: unknown } }).message?.role === "assistant").length;
}

function toolResultText(contexts: readonly TranscriptContext[], toolName: string): string {
  const result = contexts.flatMap(context => context.messages).find(message =>
    message.role === "toolResult" && message.toolName === toolName);
  return result ? textOf(result) : "";
}

function onePromptWorkflow(name: string, prompt: string): Workflow {
  return defineWorkflow({
    name,
    start: "work",
    stages: { work: acts.prompt({ prompt }) },
    edges: { work: STOP },
  });
}

function continuationWorkflow(): Workflow {
  return defineWorkflow({
    name: "standard-continuation",
    start: "first",
    stages: {
      first: acts.prompt({ prompt: "STANDARD_FIRST_PROMPT" }),
      second: acts.prompt({ prompt: "STANDARD_SECOND_PROMPT", sessionPolicy: "continue" }),
    },
    edges: { first: "second", second: STOP },
  });
}

function reattachWorkflow(): Workflow {
  return defineWorkflow({
    name: "standard-raw-reattach",
    start: "build",
    stages: {
      build: produces.prompt({
        prompt: "STANDARD_REATTACH_PROMPT",
        outcome: {
          collector: {
            collect(context) {
              const start = Math.max(context.branchOffset ?? 0, 0);
              const assistants = context.branch.slice(start).filter(entry =>
                entry.type === "message" && entry.message?.role === "assistant").length;
              return assistants >= 2
                ? { kind: "ok" as const, artifacts: [{ handle: opaque("standard-reattached"), role: "primary" }] }
                : { kind: "fatal" as const, message: "fixture requires one raw-session continuation" };
            },
          },
        },
      }),
    },
    edges: { build: STOP },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("standard workflow profile over real Pi SDK resources", () => {
  it("defaults to standard, ignores the managed-only backend request, and executes an ambient skill plus extension tool", async () => {
    const f = fixture({ backend: "embedded", requestedBackend: "terminal" });
    const requests = f.script(
      fauxAssistantMessage(fauxToolCall(STANDARD_EXTENSION_TOOL, { value: "skill-tool-ok" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("standard skill completed"),
    );
    const workflow = defineWorkflow({
      name: "standard-skill-extension",
      start: "accept",
      stages: { accept: acts({ skill: STANDARD_SKILL }) },
      edges: { accept: STOP },
    });

    const result = await runWorkflow(f.ctx as never, { workflow, input: "skill acceptance input" });

    expect(result).toMatchObject({ success: true, stagesCompleted: 1, termination: { status: "completed" } });
    expect(f.identities).toHaveLength(1);
    expect(f.identities[0]).toMatchObject({
      backend: "embedded",
      profile: "standard",
      promptBinding: { resolverId: "pi-subagents/workflow-standard@1", assetMode: "live" },
    });
    const header = readHeader(f.cwd, result.runId!);
    expect(header?.identity).toMatchObject({
      executor: "pi-subagents",
      backend: "embedded",
      promptBinding: { resolverId: "pi-subagents/workflow-standard@1" },
    });

    const firstUser = requests[0]!.messages.find(message => message.role === "user");
    expect(textOf(firstUser!)).toContain(STANDARD_SKILL_MARKER);
    expect(textOf(firstUser!)).toContain("skill acceptance input");
    expect(textOf(firstUser!)).not.toContain(`/skill:${STANDARD_SKILL}`);
    expect(getCurrentTools(requests[0]!.messages).map(tool => tool.name)).toContain(STANDARD_EXTENSION_TOOL);
    expect(readFileSync(f.probeFile, "utf8")).toBe("skill-tool-ok");
    expect(toolResultText(requests, STANDARD_EXTENSION_TOOL)).toContain("acceptance-probe:skill-tool-ok");

    const row = readAllStages(f.cwd, result.runId!)[0]!;
    expect(row.session?.file).toBeTypeOf("string");
    expect(dirname(row.session!.file!)).not.toContain(`${join("sessions", "managed")}`);
    expect(existsSync(`${row.session!.file}.pi-subagents.json`)).toBe(false);
    expect(existsSync(`${row.session!.file}.pi-subagents.lock`)).toBe(false);
  });

  it("uses native SDK settings for a fresh stage when no workflow model override exists", async () => {
    const f = fixture({ backend: "embedded" });
    (f.ctx as unknown as { model: typeof f.model }).model = f.alternateModel;
    (f.ctx as unknown as { thinkingLevel: string }).thinkingLevel = "high";
    let requestedModel: string | undefined;
    let requestedReasoning: unknown;
    f.script((_context, options, _state, model) => {
      requestedModel = `${model.provider}/${model.id}`;
      requestedReasoning = options.reasoning;
      return fauxAssistantMessage("native defaults used");
    });

    const result = await runWorkflow(f.ctx as never, {
      workflow: onePromptWorkflow("standard-native-model-default", "USE_NATIVE_DEFAULT"),
      input: "native defaults",
    });

    expect(result).toMatchObject({ success: true, termination: { status: "completed" } });
    expect(requestedModel).toBe(f.modelKey);
    expect(requestedReasoning).toBeUndefined();
  });

  it("routes a nested Agent call through the common embedded runtime", async () => {
    const f = fixture({ backend: "embedded", delegate: "embedded" });
    const requests = f.script(
      fauxAssistantMessage(fauxToolCall("Agent", {
        prompt: "EMBEDDED_DELEGATE_TASK",
        description: "embedded delegate",
        subagent_type: "delegate",
        run_in_background: false,
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("EMBEDDED_DELEGATE_RESULT"),
      fauxAssistantMessage("parent accepted embedded delegate"),
    );

    const result = await runWorkflow(f.ctx as never, {
      workflow: onePromptWorkflow("standard-agent-embedded", "CALL_EMBEDDED_AGENT"),
      input: "nested embedded",
    });

    expect(result).toMatchObject({ success: true, stagesCompleted: 1 });
    expect(getCurrentTools(requests[0]!.messages).map(tool => tool.name)).toContain("Agent");
    expect(requests.some(context => context.messages.some(message =>
      message.role === "user" && textOf(message).includes("EMBEDDED_DELEGATE_TASK")))).toBe(true);
    expect(toolResultText(requests, "Agent")).toContain("EMBEDDED_DELEGATE_RESULT");
    expect(f.identities[0]).toMatchObject({ backend: "embedded", profile: "standard" });
  });

  it.skipIf(process.platform === "win32")("routes the same nested Agent call through a real terminal Pi delegate", async () => {
    const f = fixture({ backend: "terminal", delegate: "terminal" });
    const requests = f.script(
      fauxAssistantMessage(fauxToolCall("Agent", {
        prompt: "TERMINAL_DELEGATE_TASK",
        description: "terminal delegate",
        subagent_type: "delegate",
        run_in_background: false,
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("parent accepted terminal delegate"),
    );

    const result = await runWorkflow(f.ctx as never, {
      workflow: onePromptWorkflow("standard-agent-terminal", "CALL_TERMINAL_AGENT"),
      input: "nested terminal",
    });

    expect(result).toMatchObject({ success: true, stagesCompleted: 1 });
    expect(f.identities[0]).toMatchObject({ backend: "terminal", profile: "standard" });
    expect(toolResultText(requests, "Agent"), terminalScreens.join("\n")).toContain("terminal-faux turn");
    const sessionDir = join(f.agentDir, "terminal-subagents", "sessions");
    const files = existsSync(sessionDir) ? readdirSync(sessionDir).filter(name => name.endsWith(".jsonl")) : [];
    expect(files).toHaveLength(1);
    const branch = SessionManager.open(join(sessionDir, files[0]!)).getBranch();
    expect(userTexts(branch).some(text => text.includes("TERMINAL_DELEGATE_TASK"))).toBe(true);
    expect(assistantCount(branch)).toBeGreaterThan(0);
  });

  it("uses a real raw-session fork for continue and persists model/thinking overrides only on the fork", async () => {
    const f = fixture({ backend: "embedded" });
    f.script(
      fauxAssistantMessage("first standard turn"),
      fauxAssistantMessage("continued standard turn"),
    );
    let sourceBytes: Buffer | undefined;

    const result = await runWorkflow(f.ctx as never, {
      workflow: continuationWorkflow(),
      input: "continue input",
      resolveModel: ({ stage }) => stage === "second"
        ? { model: f.alternateModelKey, thinking: "high" }
        : undefined,
      lifecycle: {
        onStageStart(stage, context) {
          if (stage.name !== "second") return;
          const source = readAllStages(context.cwd, context.runId)[0]?.session?.file;
          expect(source).toBeTypeOf("string");
          sourceBytes = readFileSync(source!);
        },
      },
    });

    expect(result).toMatchObject({ success: true, stagesCompleted: 2 });
    const rows = readAllStages(f.cwd, result.runId!);
    const source = rows[0]!.session!;
    const continued = rows[1]!.session!;
    expect(continued.id).not.toBe(source.id);
    expect(continued.file).not.toBe(source.file);
    expect(continued.branchOffset).toBeTypeOf("number");
    expect(readFileSync(source.file!)).toEqual(sourceBytes);

    const sourceManager = SessionManager.open(source.file!);
    const continuedManager = SessionManager.open(continued.file!);
    const sourceBranch = sourceManager.getBranch();
    const continuedBranch = continuedManager.getBranch();
    expect(continued.branchOffset).toBeGreaterThan(sourceBranch.length);
    expect(continuedBranch.slice(0, sourceBranch.length)).toEqual(sourceBranch);
    expect(continuedBranch.slice(sourceBranch.length, continued.branchOffset).map(entry => entry.type))
      .toEqual(["model_change", "thinking_level_change"]);
    expect(userTexts(sourceBranch)).toEqual(["STANDARD_FIRST_PROMPT"]);
    expect(userTexts(continuedBranch)).toEqual(["STANDARD_FIRST_PROMPT", "STANDARD_SECOND_PROMPT"]);
    expect(sourceManager.buildSessionContext()).toMatchObject({
      model: { provider: f.model.provider, modelId: f.model.id },
      thinkingLevel: "off",
    });
    expect(continuedManager.buildSessionContext()).toMatchObject({
      model: { provider: f.alternateModel.provider, modelId: f.alternateModel.id },
      thinkingLevel: "high",
    });
  });

  it("reattaches an unwrapped legacy JSONL in place and records a new model/thinking selection", async () => {
    const f = fixture({ backend: "embedded" });
    const workflow = reattachWorkflow();
    f.script(fauxAssistantMessage("initial incomplete raw turn"));

    const first = await runWorkflow(f.ctx as never, { workflow, input: "reattach input" });
    expect(first).toMatchObject({ success: false, termination: { status: "failed" } });
    const header = readHeader(f.cwd, first.runId!)!;
    const firstRow = readAllStages(f.cwd, first.runId!)[0]!;
    const source = firstRow.session!;
    expect(source.file).toBeTypeOf("string");
    expect(existsSync(`${source.file}.pi-subagents.json`)).toBe(false);
    expect(existsSync(`${source.file}.pi-subagents.lock`)).toBe(false);
    const before = SessionManager.open(source.file!).getBranch();

    f.script(fauxAssistantMessage("completed after raw reattach"));
    const resumed = await resumeWorkflow(f.ctx as never, {
      workflow,
      header,
      ref: "@raw-standard",
      resolveModel: () => ({ model: f.alternateModelKey, thinking: "high" }),
    });

    expect(resumed).toMatchObject({ success: true, runId: first.runId, termination: { status: "completed" } });
    const rows = readAllStages(f.cwd, first.runId!);
    expect(rows.map(row => row.status)).toEqual(["failed", "completed"]);
    expect(rows[1]!.session).toEqual(source);
    const manager = SessionManager.open(source.file!);
    const after = manager.getBranch();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(assistantCount(after)).toBe(2);
    expect(manager.buildSessionContext()).toMatchObject({
      model: { provider: f.alternateModel.provider, modelId: f.alternateModel.id },
      thinkingLevel: "high",
    });
    expect(f.identities).toHaveLength(2);
    expect(f.identities.every(identity => identity.profile === "standard")).toBe(true);
  });

  it("retains a provider-error session and resumes it in place without replaying the fresh prompt", async () => {
    const f = fixture({ backend: "embedded" });
    const workflow = reattachWorkflow();
    f.script(fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }));

    const first = await runWorkflow(f.ctx as never, { workflow, input: "provider error" });
    expect(first).toMatchObject({ success: false, termination: { status: "failed" } });
    const header = readHeader(f.cwd, first.runId!)!;
    const firstRow = readAllStages(f.cwd, first.runId!)[0]!;
    expect(firstRow.status).toBe("failed");
    expect(firstRow.session?.file).toBeTypeOf("string");
    expect(existsSync(firstRow.session!.file!)).toBe(true);

    f.script(fauxAssistantMessage("completed after provider error"));
    const resumed = await resumeWorkflow(f.ctx as never, {
      workflow,
      header,
      ref: "@provider-error",
    });

    expect(resumed).toMatchObject({ success: true, runId: first.runId, termination: { status: "completed" } });
    const rows = readAllStages(f.cwd, first.runId!);
    expect(rows.map(row => row.status)).toEqual(["failed", "completed"]);
    expect(rows[1]!.session).toEqual(firstRow.session);
    const branch = SessionManager.open(firstRow.session!.file!).getBranch();
    expect(userTexts(branch).filter(text => text === "STANDARD_REATTACH_PROMPT")).toHaveLength(1);
    expect(assistantCount(branch)).toBe(2);
  });

  it("cancels a held lifecycle callback promptly and fences every late journal write", async () => {
    const f = fixture({ backend: "embedded" });
    f.script(fauxAssistantMessage("first stage completed before callback hold"));
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const workflow = defineWorkflow({
      name: "standard-held-callback-cancel",
      start: "first",
      stages: {
        first: acts.prompt({ prompt: "HELD_FIRST_PROMPT" }),
        late: acts.prompt({ prompt: "LATE_PROMPT_MUST_NOT_RUN" }),
      },
      edges: { first: "late", late: STOP },
    });

    const running = runWorkflow(f.ctx as never, {
      workflow,
      input: "cancel held callback",
      signal: controller.signal,
      lifecycle: {
        async onStageEnd(stage) {
          if (stage.name !== "first") return;
          entered.resolve();
          await release.promise;
        },
      },
    });
    await within(entered.promise, 15_000, "stage completion callback was not held");
    controller.abort(new Error("acceptance cancellation"));
    const result = await within(running, 15_000, "workflow cancellation waited for the held callback");

    expect(result).toMatchObject({ success: false, termination: { status: "aborted" } });
    expect(f.calls()).toBe(1);
    const journal = stateFilePath(f.cwd, result.runId!);
    const beforeRelease = readFileSync(journal);
    const rowsBeforeRelease = readAllStages(f.cwd, result.runId!);
    release.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    expect(readFileSync(journal)).toEqual(beforeRelease);
    expect(readAllStages(f.cwd, result.runId!)).toEqual(rowsBeforeRelease);
    expect(f.calls()).toBe(1);
    expect(rowsBeforeRelease.filter(row => row.stage === "late")).toEqual([
      expect.objectContaining({ status: "aborted", session: null }),
    ]);
  });
});
