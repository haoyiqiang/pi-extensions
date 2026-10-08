import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple as fauxStreamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createActionFusionExtension } from "../../pi-action-fusion/index.ts";
import distill from "../index.ts";

// Composition regression is local-workspace-only; the published package does not depend on Fusion.
test("offline SDK integrates Fusion evidence, exact source readback and unchanged failed tool state", { timeout: 30000 }, async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const locale = process.env.PI_EXTENSIONS_LOCALE;
  const root = await mkdtemp(join(tmpdir(), "pi-distill-sdk-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(join(agentDir, "extensions/pi-distill"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const faux = registerFauxProvider({ provider: "distill-sdk", models: [{ id: "offline", contextWindow: 128000, reasoning: false }] });
  const model = faux.getModel("offline")!;
  const body = `${"PASS routine test\n".repeat(800)}FAIL target.test.ts\nExpected: 200\nReceived: 401\nTests: 1 failed, 99 passed\n`;
  const receipt = JSON.stringify({ schema: "pi-distill-evidence/v1", uncertain: false, evidence: [
    { kind: "failure", quote: "FAIL target.test.ts\nExpected: 200\nReceived: 401" },
    { kind: "summary", quote: "Tests: 1 failed, 99 passed" },
  ] });
  await writeFile(join(agentDir, "extensions/pi-distill/config.json"), JSON.stringify({
    model: `${model.provider}/${model.id}`, evidence: { enabled: true, fusion: true }, minChars: 1,
  }));
  const callEvents: string[] = [];
  const resultEvents: Array<{ tool: string; error: boolean }> = [];
  const observer: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => { callEvents.push(event.toolName); });
    pi.on("tool_result", (event) => { resultEvents.push({ tool: event.toolName, error: event.isError }); });
  };
  const errors: unknown[] = [];
  let artifact = "";
  let sourceLines = 0;
  let shellCalls = 0;
  faux.setResponses([
    (context) => {
      const tools = getCurrentTools(context.messages);
      for (const name of ["edit", "write"]) {
        const schema = tools.find((tool) => tool.name === name)!.parameters as { properties: Record<string, unknown>; required: string[] };
        assert.ok(schema.properties.then_run);
        assert.ok(schema.properties.outputRequest);
        assert.ok(!schema.required.includes("outputRequest"));
      }
      const readSchema = tools.find((tool) => tool.name === "read")!.parameters as { required: string[] };
      assert.ok(readSchema.required.includes("outputRequest"));
      return fauxAssistantMessage(fauxToolCall("write", { path: "target.txt", content: "before\n", then_run: { command: "npm test --sdk-success" } }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(JSON.stringify(context.messages), /pi-distill-evidence\/v1/);
      return fauxAssistantMessage(receipt);
    },
    (context) => {
      const last = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(last?.role, "toolResult");
      if (last?.role === "toolResult") {
        assert.equal(last.isError, false);
        assert.match(JSON.stringify(last.content), /then_run:succeeded/);
        assert.match(JSON.stringify(last.content), /distill:evidence/);
      }
      return fauxAssistantMessage(fauxToolCall("edit", { path: "target.txt", edits: [{ oldText: "before", newText: "kept-after-failure" }], then_run: { command: "npm test --sdk-failure" } }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(JSON.stringify(context.messages), /pi-distill-evidence\/v1/);
      return fauxAssistantMessage(receipt);
    },
    (context) => {
      const last = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(last?.role, "toolResult");
      if (last?.role === "toolResult") {
        assert.equal(last.isError, true, "evidence must not turn a failed tool into success");
        const text = last.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
        assert.match(text, /Successfully replaced/);
        assert.match(text, /then_run:failed/);
        assert.match(text, /distill:evidence/);
        artifact = JSON.parse(text.match(/^source_artifact=(.+)$/m)![1]) as string;
        sourceLines = Number(text.match(/^source_lines=(\d+)$/m)![1]);
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: artifact, offset: Math.max(1, sourceLines - 6 + 1), limit: 6, outputRequest: "RAW" }), { stopReason: "toolUse" });
    },
    (context) => {
      const last = context.messages.findLast((message) => message.role === "toolResult");
      assert.match(JSON.stringify(last), /Tests: 1 failed, 99 passed/);
      assert.doesNotMatch(JSON.stringify(last?.role === "toolResult" ? last.content : []), /distill:summary/);
      return fauxAssistantMessage("DISTILL_SDK_OK");
    },
  ]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider(model.provider, {
    baseUrl: model.baseUrl, apiKey: "offline-key", api: faux.api, streamSimple: fauxStreamSimple,
    models: faux.models.map((entry) => ({ id: entry.id, name: entry.name, api: entry.api, reasoning: entry.reasoning, input: entry.input, cost: entry.cost, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, baseUrl: entry.baseUrl })),
  });
  let session: AgentSession | undefined;
  try {
    const fusion = createActionFusionExtension({ bashOptions: { operations: { exec: async (command, actualCwd, { onData }) => {
      assert.equal(actualCwd, cwd);
      shellCalls++;
      assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), command === "npm test --sdk-success" ? "before\n" : "kept-after-failure\n");
      onData(Buffer.from(body));
      return { exitCode: command === "npm test --sdk-success" ? 0 : 7 };
    } } } });
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [fusion, distill, observer] },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model, thinkingLevel: "off" }));
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    await session.prompt("Run deterministic evidence and readback regression.");
    assert.equal(session.getLastAssistantText(), "DISTILL_SDK_OK", JSON.stringify(session.messages));
    assert.deepEqual(callEvents, ["write", "edit", "read"]);
    assert.deepEqual(resultEvents, [{ tool: "write", error: false }, { tool: "edit", error: true }, { tool: "read", error: false }]);
    assert.equal(shellCalls, 2);
    for (const message of session.messages) {
      if (message.role === "toolResult" && ["write", "edit"].includes(message.toolName)) {
        assert.ok(message.usage, "Distill usage must survive native event normalization");
        assert.equal(message.usage.totalTokens, (message.details as { summaryTotalTokens: number }).summaryTotalTokens);
      }
    }
    assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "kept-after-failure\n");
    assert.ok((await readFile(artifact, "utf8")).includes(body));
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await session?.dispose(); runtime.unregisterProvider(model.provider); faux.unregister();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (locale === undefined) delete process.env.PI_EXTENSIONS_LOCALE; else process.env.PI_EXTENSIONS_LOCALE = locale;
    await rm(root, { recursive: true, force: true });
  }
});
