import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, getCurrentTools } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple as fauxStreamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withTempAgentDir } from "pi-utils";
import { createActionFusionExtension } from "../index.ts";

test("real SDK preserves native edit shims, exposes fused results and emits no nested Bash tool event", { timeout: 30_000 }, async () => {
  await withTempAgentDir(async (agentDir) => {
    const cwd = join(agentDir, "workspace");
    await mkdir(cwd);
    const callEvents: string[] = [];
    const resultEvents: Array<{ name: string; isError: boolean }> = [];
    const commands: string[] = [];
    const extensionErrors: unknown[] = [];
    const observer: ExtensionFactory = (pi) => {
      pi.on("tool_call", (event) => { callEvents.push(event.toolName); });
      pi.on("tool_result", (event) => { resultEvents.push({ name: event.toolName, isError: event.isError }); });
    };
    const fusion = createActionFusionExtension({
      bashOptions: { operations: { exec: async (command, actualCwd, { onData, timeout }) => {
        assert.equal(actualCwd, cwd);
        assert.equal(timeout, 12);
        commands.push(command);
        const content = await readFile(join(cwd, "target.txt"), "utf8");
        if (command === "check-write") assert.equal(content, "before\n");
        else if (command === "check-edit") assert.equal(content, "after\n");
        else assert.equal(content, "kept despite test failure\n");
        onData(Buffer.from(command === "fail-test" ? "test failed\n" : "test passed\n"));
        return { exitCode: command === "fail-test" ? 7 : 0 };
      } } },
    });
    const faux = registerFauxProvider({
      provider: "action-fusion-offline",
      models: [{ id: "offline", contextWindow: 128_000, reasoning: false }],
    });
    const model = faux.getModel("offline")!;
    faux.setResponses([
      (context) => {
        const tools = getCurrentTools(context.messages);
        for (const name of ["edit", "write"]) {
          const tool = tools.find((entry) => entry.name === name);
          assert.ok(tool);
          assert.ok((tool.parameters as { properties: Record<string, unknown> }).properties.then_run);
        }
        return fauxAssistantMessage(fauxToolCall("write", {
          path: "target.txt", content: "before\n", then_run: { command: "check-write", timeout: 12 },
        }), { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.match(JSON.stringify(result), /then_run:succeeded/);
        assert.match(JSON.stringify(result), /test passed/);
        // Native prepareArguments must preserve then_run while normalizing legacy edit input.
        return fauxAssistantMessage(fauxToolCall("edit", {
          path: "target.txt", oldText: "before", newText: "after", then_run: { command: "check-edit", timeout: 12 },
        }), { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.match(JSON.stringify(result), /then_run:succeeded/);
        return fauxAssistantMessage(fauxToolCall("write", {
          path: "target.txt", content: "kept despite test failure\n", then_run: { command: "fail-test", timeout: 12 },
        }), { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.equal(result?.role, "toolResult");
        if (result?.role === "toolResult") assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /then_run:failed/);
        assert.match(JSON.stringify(result), /test failed/);
        return fauxAssistantMessage("FUSION_OFFLINE_OK");
      },
    ]);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-key" }));
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl, apiKey: "offline-key", api: faux.api, streamSimple: fauxStreamSimple,
      models: faux.models.map((entry) => ({
        id: entry.id, name: entry.name, api: entry.api, reasoning: entry.reasoning, input: entry.input,
        cost: entry.cost, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, baseUrl: entry.baseUrl,
      })),
    });
    let session: AgentSession | undefined;
    try {
      const services = await createAgentSessionServices({
        cwd, agentDir, modelRuntime,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
          extensionFactories: [fusion, observer],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSessionFromServices({
        services, sessionManager: SessionManager.inMemory(cwd), model, thinkingLevel: "off",
      }));
      await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error) });
      await session.prompt("Run the deterministic fusion regression task.");
      assert.equal(session.getLastAssistantText(), "FUSION_OFFLINE_OK");
      assert.deepEqual(callEvents, ["write", "edit", "write"]);
      assert.deepEqual(resultEvents, [
        { name: "write", isError: false }, { name: "edit", isError: false }, { name: "write", isError: true },
      ]);
      assert.deepEqual(commands, ["check-write", "check-edit", "fail-test"]);
      assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "kept despite test failure\n");
      const edited = session.messages.find((message) => message.role === "toolResult" && message.toolName === "edit");
      assert.match(JSON.stringify(edited), /"patch"/);
      assert.equal(faux.getPendingResponseCount(), 0);
      assert.deepEqual(extensionErrors, []);
    } finally {
      await session?.dispose();
      modelRuntime.unregisterProvider(model.provider);
      faux.unregister();
    }
  });
});
