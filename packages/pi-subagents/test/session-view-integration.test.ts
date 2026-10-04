import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { ExecutionSession, SessionViewEvent, TranscriptMessage } from "../src/backends/session.js";
import type { AgentExecutionBackend } from "../src/backends/types.js";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { getAgentConversation } from "../src/transcript.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { getSessionContextPercent, getSessionTokens } from "../src/usage.js";

/** Deliberately no native session, SDK manager, model runtime or control methods. */
class RemoteView implements ExecutionSession {
  readonly reference = { backend: "terminal" as const, sessionId: "remote-session", sessionFile: "/sessions/remote.jsonl" };
  readonly model = { provider: "faux", id: "remote-model", name: "Remote" };
  readonly thinkingLevel = "off" as const;
  messages: TranscriptMessage[] = [];
  readonly listeners = new Set<(event: SessionViewEvent) => void>();
  getSessionStats() { return { tokens: { input: 10, output: 4, cacheWrite: 2 }, contextUsage: { percent: 25 } }; }
  subscribe(listener: (event: SessionViewEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: SessionViewEvent) { for (const listener of this.listeners) listener(event); }
}

const assistant = (text: string): TranscriptMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const managers: AgentManager[] = [];
const dirs: string[] = [];
function fixture() {
  const view = new RemoteView();
  const backend: AgentExecutionBackend = {
    kind: "terminal",
    run: vi.fn<AgentExecutionBackend["run"]>(async (_ctx, _type, prompt, options) => {
      await Promise.resolve();
      view.messages.push({ role: "user", content: prompt });
      options.onSessionCreated?.(view);
      view.messages.push(assistant("first response"));
      view.emit({ type: "turn_end" });
      return { session: view, responseText: "first response", aborted: false, steered: false };
    }),
    resume: vi.fn<AgentExecutionBackend["resume"]>(async (session, prompt) => {
      expect(session).toBe(view);
      view.messages.push({ role: "user", content: prompt }, assistant("resumed response"));
      view.emit({ type: "turn_end" });
      return { text: "resumed response" };
    }),
    steer: vi.fn<AgentExecutionBackend["steer"]>(async (session) => { expect(session).toBe(view); }),
    shutdown: vi.fn<AgentExecutionBackend["shutdown"]>(async (session) => {
      if (session) expect(session).toBe(view);
      view.listeners.clear();
    }),
  };
  const manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, backend);
  managers.push(manager);
  return { view, backend, manager };
}
function outputFile() {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-view-"));
  dirs.push(dir);
  return join(dir, "transcript.output");
}
function messages(path: string): TranscriptMessage[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line).message);
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native-free session observations", () => {
  it("runs and resumes through the manager while streaming only new messages", async () => {
    const { manager, backend, view } = fixture();
    const output = outputFile();
    let id: string | undefined;
    const { record } = await manager.spawnAndWait({} as any, { cwd: process.cwd() } as any, "general-purpose", "first", {
      description: "native-free child",
      onSessionCreated(session) {
        expect(session).toBe(view);
        expect(id).toBeDefined();
        manager.getRecord(id!)!.outputCleanup = streamToOutputFile(session, output, id!, process.cwd());
      },
    }, (spawnedId) => {
      id = spawnedId;
      writeInitialEntry(output, spawnedId, "first", process.cwd());
    });
    expect(record.status).toBe("completed");
    expect(record.session).toBe(view);
    expect(record.sessionFile).toBe(view.reference.sessionFile);
    expect(record.invocation).toMatchObject({ modelId: "faux/remote-model", thinking: "off" });
    expect(messages(output)).toEqual(view.messages);
    expect(view.listeners.size).toBe(0);
    for (const key of ["prompt", "abort", "dispose", "steer", "sessionManager", "agent", "modelRuntime"]) {
      expect(view).not.toHaveProperty(key);
    }

    const cleanup = streamToOutputFile(view, output, record.id, process.cwd(), view.messages.length);
    await manager.resume(record.id, "follow up");
    cleanup();
    expect(backend.resume).toHaveBeenCalledOnce();
    expect(messages(output)).toEqual(view.messages);
    expect(record.result).toBe("resumed response");
    expect(getSessionTokens(view)).toBe(16);
    expect(getSessionContextPercent(view)).toBe(25);
    expect(getAgentConversation(view)).toContain("[Assistant]: resumed response");
    manager.clearCompleted();
    expect(backend.shutdown).toHaveBeenCalledWith(view);
  });

  it("keeps output append-only across a remote compaction and resumes after its microtask re-anchor", async () => {
    const view = new RemoteView();
    const output = outputFile();
    view.messages = [{ role: "user", content: "initial" }];
    writeInitialEntry(output, "child", "initial", process.cwd());
    const cleanup = streamToOutputFile(view, output, "child", process.cwd());
    view.messages.push(assistant("before"));
    view.emit({ type: "compaction_start" });
    view.messages = [{ role: "user", content: "compacted history" }];
    view.emit({ type: "compaction_end", aborted: false, result: true });
    await Promise.resolve();
    view.messages.push(assistant("after"));
    view.emit({ type: "turn_end" });
    cleanup();
    expect(messages(output)).toEqual([
      { role: "user", content: "initial" }, assistant("before"), assistant("after"),
    ]);
    expect(view.listeners.size).toBe(0);
  });

  it("renders the conversation viewer and responds to observation events without SDK controls", async () => {
    const { manager, view } = fixture();
    const { record } = await manager.spawnAndWait({} as any, { cwd: process.cwd() } as any, "general-purpose", "inspect", {
      description: "remote view",
    });
    const tui = { terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const viewer = new ConversationViewer(tui as any, view, record, undefined, theme, vi.fn(),
      undefined, undefined, undefined, false, () => "off");
    try {
      expect(viewer.render(100).join("\n")).toContain("first response");
      view.messages.push(assistant("live update"), { role: "assistant", content: "string content from remote" });
      view.emit({ type: "changed" });
      expect(tui.requestRender).toHaveBeenCalledOnce();
      expect(viewer.render(100).join("\n")).toContain("live update");
      expect(viewer.render(100).join("\n")).toContain("string content from remote");
      expect(getAgentConversation(view)).toContain("[Assistant]: string content from remote");
    } finally {
      viewer.dispose();
    }
    expect(view.listeners.size).toBe(0);
  });
});
