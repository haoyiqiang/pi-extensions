import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  buildAgentContext,
  buildLegacyAgentContext,
  buildTranscriptAgentContext,
  supportsTranscriptSystemMessages,
} from "../src/om/agents/agent-context.js";
import { leadingSystemPrompt } from "./fixtures/agent-context.js";

const tool: AgentTool<any> = {
  name: "record_observations",
  label: "Record observations",
  description: "records observations",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
};

function leadingSystemMessage(context: ReturnType<typeof buildAgentContext>) {
  const first = context.messages[0];
  if (first?.role !== "system") throw new Error("missing leading system message");
  return first;
}

describe("agent context carrier", () => {
  it("detects the transcript carrier on the installed Pi 0.87 host", () => {
    expect(supportsTranscriptSystemMessages()).toBe(true);
  });

  it("carries the prompt as a leading system message on 0.87", () => {
    const context = buildTranscriptAgentContext("SYSTEM PROMPT", [tool]);
    expect(leadingSystemPrompt(context)).toBe("SYSTEM PROMPT");
    expect(context.messages).toHaveLength(1);
  });

  it("declares the tool in the leading system message so the model may call it", () => {
    const context = buildTranscriptAgentContext("SYSTEM PROMPT", [tool]);
    const first = leadingSystemMessage(context);
    expect(first.toolsAdded?.map((entry) => entry.name)).toEqual(["record_observations"]);
    expect(context.tools).toEqual([tool]);
  });

  it("does not set the removed systemPrompt field on 0.87", () => {
    const context = buildTranscriptAgentContext("SYSTEM PROMPT", [tool]);
    expect("systemPrompt" in context).toBe(false);
  });

  it("keeps the legacy systemPrompt carrier for pre-0.87 hosts", () => {
    const context = buildLegacyAgentContext("SYSTEM PROMPT", [tool]);
    expect(context.systemPrompt).toBe("SYSTEM PROMPT");
    expect(context.messages).toEqual([]);
  });

  it("selects the transcript carrier on the installed 0.87 host", () => {
    const context = buildAgentContext("SYSTEM PROMPT", [tool]);
    expect(leadingSystemPrompt(context)).toBe("SYSTEM PROMPT");
    expect("systemPrompt" in context).toBe(false);
  });
});
