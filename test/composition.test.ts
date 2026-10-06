import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple as fauxStreamSimple } from "@earendil-works/pi-ai/compat";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { createExtensionRegistrationHarness, withTempDir } from "../packages/test-utils/index.ts";
import { readAllStages, readHeader } from "../packages/pi-workflow/src/state/index.ts";
import { getWorkflowExecutionProvider } from "../packages/pi-workflow/src/execution-host.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const LEGACY_GLOBAL = "__pi_subagents";
const ROOT_PROFILE = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  pi: { extensions: string[] };
}).pi.extensions;

const UNIFIED_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"] as const;
const RETIRED_TOOLS = [
  "subagent",
  "subagent_resume",
  "subagents_list",
  "subagent_interrupt",
  "subagent_done",
  "SubagentWorkflow",
] as const;

function profileOwner(entry: string): string {
  return entry.split("/")[1] ?? entry;
}

async function loadProfileIntoHarness(profile: readonly string[]) {
  const harness = createExtensionRegistrationHarness();
  for (const entry of profile) {
    const imported = await import(pathToFileURL(join(ROOT, entry)).href);
    assert.equal(typeof imported.default, "function", `${entry} must default-export an extension factory`);
    await harness.load(profileOwner(entry), imported.default);
  }
  return harness;
}

async function shutdownHarness(
  harness: ReturnType<typeof createExtensionRegistrationHarness>,
  owners?: ReadonlySet<string>,
): Promise<void> {
  const handlers = harness.events.filter(({ event, owner }) =>
    event === "session_shutdown" && (!owners || owners.has(owner)));
  for (const { handler } of handlers) {
    await handler({ type: "session_shutdown", reason: "quit" }, { hasUI: false, mode: "print" });
  }
}

function assertSparkOwnsEditorAndFooter(): void {
  const violations: string[] = [];
  for (const packageName of readdirSync(join(ROOT, "packages"))) {
    const packageRoot = join(ROOT, "packages", packageName);
    if (!existsSync(join(packageRoot, "package.json"))) continue;
    for (const file of collectRuntimeFiles(packageRoot)) {
      const source = readFileSync(file, "utf8");
      if (!/\.set(?:EditorComponent|Footer)\s*\(/.test(source)) continue;
      if (packageName !== "pi-spark") violations.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, []);
}

test("root manifest extensions compose as one unified control plane", async () => {
  await withIsolatedEnvironment("pi-root-composition-", async () => {
    const i18nModule = await import("../packages/pi-extensions-i18n/index.ts");
    i18nModule.resetNoticeRenderer();
    delete (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY];
    delete (globalThis as Record<string, unknown>)[LEGACY_GLOBAL];

    let harness: Awaited<ReturnType<typeof loadProfileIntoHarness>> | undefined;
    try {
      assert.ok(ROOT_PROFILE.includes("packages/pi-subagents/index.ts"));
      assert.ok(ROOT_PROFILE.includes("packages/pi-workflow/extension.ts"));
      assert.ok(!ROOT_PROFILE.includes("packages/pi-interactive-subagents/index.ts"));

      harness = await loadProfileIntoHarness(ROOT_PROFILE);
      const rootManager = (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY];
      assert.ok(rootManager, "the unified root subagent extension must own the manager view");

      assert.equal(harness.entryRenderers.get("pi-extensions-notice")?.owner, "pi-extensions-i18n");
      assert.equal(harness.entryRenderers.get("pi-distill-audit")?.owner, "pi-distill");
      assert.equal(harness.messageRenderers.get("subagent-notification")?.owner, "pi-subagents");
      assert.equal(harness.tools.get("recall")?.owner, "pi-blackhole");
      for (const tool of UNIFIED_TOOLS) assert.equal(harness.tools.get(tool)?.owner, "pi-subagents");
      for (const tool of RETIRED_TOOLS) assert.equal(harness.tools.has(tool), false, `${tool} is retired`);
      assert.equal(harness.commands.get("agents")?.owner, "pi-subagents");
      assert.equal(harness.commands.get("config:subagents")?.owner, "pi-subagents");
      assert.equal(harness.commands.get("wf")?.owner, "pi-workflow");
      assert.equal(harness.commands.get("wf-cancel")?.owner, "pi-workflow");
      for (const command of ["subagent", "plan", "iterate"]) assert.equal(harness.commands.has(command), false);
      assert.equal((globalThis as Record<string, unknown>)[LEGACY_GLOBAL], undefined);
      assert.equal((globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY], rootManager);
      assert.equal(harness.commands.get("rewind")?.owner, "pi-rewind");
      assert.equal(harness.commands.get("config:distill")?.owner, "pi-distill");
      for (const command of ["rename", "config:naming", "naming-config", "pi-naming-config"]) {
        assert.equal(harness.commands.get(command)?.owner, "pi-spark");
      }
      assert.ok(harness.events.length > 0);
      assertSparkOwnsEditorAndFooter();
    } finally {
      if (harness) await shutdownHarness(harness, new Set(["pi-subagents", "pi-workflow"]));
      i18nModule.resetNoticeRenderer();
      assert.equal((globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY], undefined);
      assert.equal(getWorkflowExecutionProvider(), undefined);
      delete (globalThis as Record<string, unknown>)[LEGACY_GLOBAL];
    }
  });
});

test("workflow frontend and executor-only entry compose without a root Agent UI", async () => {
  await withIsolatedEnvironment("pi-executor-composition-", async () => {
    const [{ default: workflow }, { default: executor }, i18nModule] = await Promise.all([
      import("../packages/pi-workflow/extension.ts"),
      import("../packages/pi-subagents/workflow-executor.ts"),
      import("../packages/pi-extensions-i18n/index.ts"),
    ]);
    i18nModule.resetNoticeRenderer();
    const harness = createExtensionRegistrationHarness();
    try {
      await harness.load("pi-extensions-i18n", i18nModule.default);
      await harness.load("pi-subagents-executor", executor);
      await harness.load("pi-workflow", workflow);

      assert.equal(harness.commands.get("wf")?.owner, "pi-workflow");
      assert.equal(harness.commands.get("wf-cancel")?.owner, "pi-workflow");
      assert.equal(harness.entryRenderers.get("pi-extensions-notice")?.owner, "pi-extensions-i18n");
      for (const tool of [...UNIFIED_TOOLS, ...RETIRED_TOOLS]) assert.equal(harness.tools.has(tool), false);
      assert.equal(harness.commands.has("agents"), false);
      assert.equal(harness.commands.has("config:subagents"), false);
      assert.equal((globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY], undefined);
      assert.equal((globalThis as Record<string, unknown>)[LEGACY_GLOBAL], undefined);
    } finally {
      await shutdownHarness(harness, new Set(["pi-subagents-executor", "pi-workflow"]));
      i18nModule.resetNoticeRenderer();
      assert.equal(getWorkflowExecutionProvider(), undefined);
    }
  });
});

test("real SDK root profile runs, cancels and resumes file workflows through commands", { timeout: 90_000 }, async () => {
  await withIsolatedEnvironment("pi-sdk-composition-", async ({ root, cwd, agentDir }) => {
    const i18nModule = await import("../packages/pi-extensions-i18n/index.ts");
    i18nModule.resetNoticeRenderer();
    delete (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY];
    delete (globalThis as Record<string, unknown>)[LEGACY_GLOBAL];

    const faux = registerFauxProvider({
      provider: "root-composition-faux",
      models: [{ id: "offline", contextWindow: 200_000, reasoning: false }],
      tokenSize: { min: 8, max: 8 },
    });
    const model = faux.getModel("offline")!;
    const requests: TranscriptContext[] = [];
    const requestedModels: Array<{ provider: string; id: string }> = [];
    const scripted: FauxResponseStep[] = [
      (context, _options, _state, requestedModel) => {
        requests.push(context);
        requestedModels.push(requestedModel);
        assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "Agent"));
        return fauxAssistantMessage(fauxToolCall("Agent", {
          outputRequest: "RAW",
          prompt: "ROOT_PROFILE_DELEGATED_TASK",
          description: "root profile delegate",
          subagent_type: "general-purpose",
        }), { stopReason: "toolUse" });
      },
      (context, _options, _state, requestedModel) => {
        requests.push(context);
        requestedModels.push(requestedModel);
        assert.match(JSON.stringify(context.messages), /ROOT_PROFILE_DELEGATED_TASK/);
        return fauxAssistantMessage("ROOT_PROFILE_DELEGATE_OK");
      },
      (context, _options, _state, requestedModel) => {
        requests.push(context);
        requestedModels.push(requestedModel);
        assert.match(JSON.stringify(context.messages), /ROOT_PROFILE_DELEGATE_OK/);
        return fauxAssistantMessage("ROOT_PROFILE_STAGE_OK");
      },
    ];
    faux.setResponses(scripted);

    const credentials = new InMemoryCredentialStore();
    await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-key" }));
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      apiKey: "offline-key",
      api: faux.api,
      streamSimple: fauxStreamSimple,
      models: faux.models.map((registered) => ({
        id: registered.id,
        name: registered.name,
        api: registered.api,
        reasoning: registered.reasoning,
        input: registered.input,
        cost: registered.cost,
        contextWindow: registered.contextWindow,
        maxTokens: registered.maxTokens,
        baseUrl: registered.baseUrl,
      })),
    });

    writeSdkFixture({ cwd, agentDir, provider: model.provider, modelId: model.id });
    const extensionPaths = ROOT_PROFILE.map((entry) => join(ROOT, entry));
    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    try {
      const createRuntime = async ({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        sessionManager,
        sessionStartEvent,
      }: Parameters<Parameters<typeof createAgentSessionRuntime>[0]>[0]) => {
        const settingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir, { projectTrusted: true });
        const services = await createAgentSessionServices({
          cwd: runtimeCwd,
          agentDir: runtimeAgentDir,
          settingsManager,
          modelRuntime,
          resourceLoaderOptions: {
            additionalExtensionPaths: extensionPaths,
            noThemes: true,
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model,
          thinkingLevel: "off",
        });
        return { ...created, services, diagnostics: services.diagnostics };
      };

      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager: SessionManager.create(cwd, join(root, "launcher-sessions")),
      });
      const notifications: Array<{ message: string; level?: string }> = [];
      const bind = (session: AgentSession) => session.bindExtensions({
        mode: "rpc",
        uiContext: createHeadlessUi(notifications),
        commandContextActions: commandActions(runtime!),
        shutdownHandler: () => {},
      });
      runtime.setRebindSession(bind);
      await bind(runtime.session);

      const extensionResult = runtime.services.resourceLoader.getExtensions();
      assert.deepEqual(extensionResult.errors, []);
      for (const expected of extensionPaths) {
        assert.ok(extensionResult.extensions.some((extension) =>
          resolve(extension.resolvedPath) === resolve(expected)), `root extension was not loaded: ${expected}`);
      }
      assert.deepEqual(
        [...runtime.session.getActiveToolNames()].filter((name) => UNIFIED_TOOLS.includes(name as never)).sort(),
        [...UNIFIED_TOOLS].sort(),
      );
      assert.ok(runtime.session.getAllTools().some((tool) => tool.name === "Agent"));

      const rootManager = (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY];
      assert.ok(rootManager);
      await runtime.session.prompt("/wf root-profile compose the root profile");

      const runId = await eventually(() => {
        const runsDir = join(cwd, ".rpiv", "workflows", "runs");
        if (!existsSync(runsDir)) return undefined;
        return readdirSync(runsDir).find((name) => name.endsWith(".jsonl"))?.replace(/\.jsonl$/, "");
      }, "workflow run file was not created");
      const rows = await eventually(() => {
        const current = readAllStages(cwd, runId);
        return current.some((row) => ["completed", "failed", "aborted"].includes(row.status))
          ? current
          : undefined;
      }, "workflow did not settle");
      assert.equal(
        rows.at(-1)?.status,
        "completed",
        `workflow failed: ${JSON.stringify({
          rows,
          notifications,
          requests: requests.length,
          pendingResponses: faux.getPendingResponseCount(),
          session: rows.at(-1)?.session?.file && existsSync(rows.at(-1)!.session!.file!)
            ? readFileSync(rows.at(-1)!.session!.file!, "utf8")
            : undefined,
        })}`,
      );

      const header = readHeader(cwd, runId);
      assert.equal(header?.workflow, "root-profile");
      assert.deepEqual(header?.identity, {
        version: 1,
        executor: "pi-subagents",
        backend: "embedded",
        promptBinding: header?.identity?.promptBinding,
      });
      assert.equal(header?.identity?.promptBinding.resolverId, "pi-subagents/workflow-standard@1");
      assert.equal(requests.length, 3);
      const delegated = requests[2]!.messages.find((message) => message.role === "toolResult" && message.toolName === "Agent");
      assert.match(JSON.stringify(delegated?.content), /ROOT_PROFILE_DELEGATE_OK/, "workflow Agent must default to an inline result");
      assert.ok(getWorkflowExecutionProvider(), "installed child discovery must not retire the root workflow provider");
      assert.ok(requestedModels.every((requested) =>
        requested.provider === model.provider && requested.id === model.id));
      assert.equal((globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY], rootManager);
      assert.equal((globalThis as Record<string, unknown>)[LEGACY_GLOBAL], undefined);
      assert.ok(notifications.some(({ message }) => /loading workflow runtime|workflow/i.test(message)));

      await runtime.session.prompt("/wf root-cancel cancel the held script");
      await eventually(() => existsSync(join(cwd, "script-entered")) || undefined, "script did not start");
      const cancelledId = findWorkflowRun(cwd, "root-cancel")!;
      assert.ok(cancelledId);
      await runtime.session.prompt(`/wf-cancel ${cancelledId}`);
      assert.deepEqual(readAllStages(cwd, cancelledId).map((row) => row.status), ["aborted"]);
      assert.equal(faux.getPendingResponseCount(), 0, "script cancellation must not call the model");

      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline provider failure" })]);
      await runtime.session.prompt("/wf root-resume recover the failed provider turn");
      const resumedId = await eventually(() => findWorkflowRun(cwd, "root-resume"), "resume run was not created");
      const failedRow = await eventually(() => readAllStages(cwd, resumedId).find((row) => row.status === "failed"), "provider failure was not recorded");
      assert.ok(failedRow.session?.file, "provider failure must retain its session for resume");
      const originalPromptCount = (readFileSync(failedRow.session.file, "utf8").match(/ROOT_PROFILE_RESUME_PROMPT/g) ?? []).length;
      assert.equal(originalPromptCount, 1);

      faux.setResponses([fauxAssistantMessage("ROOT_PROFILE_RESUMED_OK")]);
      await runtime.session.prompt(`/wf @${resumedId}`);
      const resumedRows = await eventually(() => {
        const current = readAllStages(cwd, resumedId);
        return current.length > 1 ? current : undefined;
      }, "resume command did not record a result");
      assert.deepEqual(resumedRows.map((row) => row.status), ["failed", "completed"]);
      assert.deepEqual(resumedRows[1]!.session, failedRow.session, "resume must reuse the original child session");
      assert.equal((readFileSync(failedRow.session.file, "utf8").match(/ROOT_PROFILE_RESUME_PROMPT/g) ?? []).length, originalPromptCount);
      assert.equal((globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY], rootManager);
    } finally {
      await runtime?.dispose();
      modelRuntime.unregisterProvider(model.provider);
      faux.unregister();
      i18nModule.resetNoticeRenderer();
      assert.equal((globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY], undefined);
      assert.equal(getWorkflowExecutionProvider(), undefined);
      delete (globalThis as Record<string, unknown>)[LEGACY_GLOBAL];
    }
  });
});

function commandActions(runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>): ExtensionCommandContextActions {
  return {
    waitForIdle: () => runtime.session.waitForIdle(),
    newSession: (options) => runtime.newSession(options),
    fork: (entryId, options) => runtime.fork(entryId, options),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
    reload: () => runtime.session.reload(),
  };
}

function createHeadlessUi(notifications: Array<{ message: string; level?: string }>): ExtensionUIContext {
  const theme = new Proxy({}, {
    get: () => (...args: unknown[]) => String(args.at(-1) ?? ""),
  });
  return new Proxy({
    theme,
    notify(message: string, level?: string) { notifications.push({ message, level }); },
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    custom: async () => undefined,
    editor: async () => undefined,
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => undefined;
    },
  }) as unknown as ExtensionUIContext;
}

function writeSdkFixture(options: { cwd: string; agentDir: string; provider: string; modelId: string }): void {
  const { cwd, agentDir, provider, modelId } = options;
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(cwd, ".rpiv", "workflows"), { recursive: true });
  new ProjectTrustStore(agentDir).set(cwd, true);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    packages: [ROOT],
    defaultProvider: provider,
    defaultModel: modelId,
    defaultThinkingLevel: "off",
    defaultTools: [],
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    enableInstallTelemetry: false,
  }, null, 2)}\n`);
  writeFileSync(join(agentDir, "spark.json"), `${JSON.stringify({
    cleanMode: false,
    credits: false,
    editor: false,
    footer: false,
    metrics: false,
    naming: false,
    presets: false,
    recap: false,
    resources: false,
  }, null, 2)}\n`);
  writeFileSync(join(cwd, ".pi", "subagents.json"), `${JSON.stringify({
    backend: "embedded",
    backgroundByDefault: false,
    maxConcurrent: 2,
    maxSubagentDepth: 2,
    schedulingEnabled: false,
    fleetView: false,
    agentMentions: "off",
    rememberAgents: false,
    outputTranscript: false,
    worktreeIsolation: false,
  }, null, 2)}\n`);
  writeFileSync(join(cwd, ".pi", "pi-workflow.json"), `${JSON.stringify({
    execution: { executor: "pi-subagents", profile: "standard", maxConcurrency: 1 },
  }, null, 2)}\n`);
  writeFileSync(join(cwd, ".rpiv", "workflows", "config.ts"), `
import { acts, defineWorkflow } from "@maplezzk/pi-workflow";
import { writeFileSync } from "node:fs";
export default {
  default: "root-profile",
  workflows: [
    defineWorkflow({
      name: "root-profile",
      start: "delegate",
      stages: { delegate: acts.prompt({ prompt: "ROOT_PROFILE_STAGE_PROMPT" }) },
      edges: { delegate: "stop" },
    }),
    defineWorkflow({
      name: "root-cancel",
      start: "held",
      stages: { held: acts.script({ run: async ({ signal }) => {
        writeFileSync(${JSON.stringify(join(cwd, "script-entered"))}, "entered");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      } }) },
      edges: { held: "stop" },
    }),
    defineWorkflow({
      name: "root-resume",
      start: "recover",
      stages: { recover: acts.prompt({
        prompt: "ROOT_PROFILE_RESUME_PROMPT",
        outcome: { collector: { collect: ({ branch }) =>
          branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length >= 2
            ? { kind: "ok", artifacts: [] }
            : { kind: "fatal", message: "requires continuation of the failed turn" }
        } },
      }) },
      edges: { recover: "stop" },
    }),
  ],
};
`);
}

function findWorkflowRun(cwd: string, workflow: string): string | undefined {
  const runsDir = join(cwd, ".rpiv", "workflows", "runs");
  if (!existsSync(runsDir)) return undefined;
  return readdirSync(runsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/, ""))
    .find((id) => readHeader(cwd, id)?.workflow === workflow);
}

async function withIsolatedEnvironment<T>(
  prefix: string,
  run: (paths: { root: string; cwd: string; agentDir: string; home: string }) => Promise<T>,
): Promise<T> {
  return withTempDir(prefix, async (root) => {
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const home = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(home, { recursive: true });

    const previous = new Map<string, string | undefined>();
    const updates: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    for (const [key, value] of Object.entries(updates)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return await run({ root, cwd, agentDir, home });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

async function eventually<T>(
  read: () => T | undefined | Promise<T | undefined>,
  message: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

function collectRuntimeFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (["tests", "test", "node_modules"].includes(entry.name)) continue;
      files.push(...collectRuntimeFiles(join(root, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      files.push(join(root, entry.name));
    }
  }
  return files;
}
