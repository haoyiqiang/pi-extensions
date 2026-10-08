import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createMockCtx, createMockPi } from "@maplezzk/pi-test-utils/rpiv";
import { describe, expect, it, vi } from "vitest";
import advisorExtension from "./index.ts";

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function writeSelection(modelKey: string): void {
  const path = join(process.env.PI_CODING_AGENT_DIR!, "extensions", "pi-advisor", "advisor.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ modelKey })}\n`, "utf8");
}

function response(model: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: model }],
    api: "openai-responses",
    provider: "test",
    model,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("advisor runtime session isolation", () => {
  it("a child extension factory restore cannot overwrite the root factory selection", async () => {
    const modelA = { provider: "test", id: "root-reviewer", api: "openai-responses", name: "Root" } as never;
    const modelB = { provider: "test", id: "child-reviewer", api: "openai-responses", name: "Child" } as never;

    writeSelection("test/root-reviewer");
    const root = createMockPi();
    advisorExtension(root.pi);
    const rootStream = vi.fn((model: { id: string }) => ({ result: async () => response(model.id) }));
    const rootCtx = createMockCtx({ models: [modelA, modelB], sessionId: "root" });
    rootCtx.modelRegistry = { ...rootCtx.modelRegistry, streamSimple: rootStream } as never;
    for (const handler of root.captured.events.get("session_start") ?? []) await handler({}, rootCtx);

    writeSelection("test/child-reviewer");
    const child = createMockPi();
    advisorExtension(child.pi);
    const childStream = vi.fn((model: { id: string }) => ({ result: async () => response(model.id) }));
    const childCtx = createMockCtx({ models: [modelA, modelB], sessionId: "child" });
    childCtx.modelRegistry = { ...childCtx.modelRegistry, streamSimple: childStream } as never;
    for (const handler of child.captured.events.get("session_start") ?? []) await handler({}, childCtx);

    const rootResult = await root.captured.tools.get("advisor")?.execute?.("root-call", {}, undefined as never, undefined as never, rootCtx);
    const childResult = await child.captured.tools.get("advisor")?.execute?.("child-call", {}, undefined as never, undefined as never, childCtx);

    expect(rootStream.mock.calls[0]?.[0]).toBe(modelA);
    expect(childStream.mock.calls[0]?.[0]).toBe(modelB);
    expect(rootResult?.content[0]).toMatchObject({ text: "root-reviewer" });
    expect(childResult?.content[0]).toMatchObject({ text: "child-reviewer" });
  });
});
