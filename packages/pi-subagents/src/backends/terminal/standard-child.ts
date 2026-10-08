import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  InteractiveMode,
  runPrintMode,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createAgentRuntime } from "../../agent-runtime.js";
import { runInChildSessionContext } from "../../child-context.js";
import { i18n } from "../../i18n.js";
import { captureRuntimePolicy } from "../../runtime-policy.js";
import { initializeStandardTerminalRuntime, standardResourceOptions } from "./standard-resources.js";
import { BUILTIN_TOOL_NAMES } from "../../agent-types.js";
import { SUBAGENT_TOOL_NAMES } from "../embedded.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../structured-output.js";
import {
  STANDARD_TERMINAL_CONFIG_ENV,
  TERMINAL_MANIFEST_ENV,
  type StandardTerminalChildConfig,
} from "./bridge-protocol.js";
import terminalChildExtension from "./child-extension.js";
import { createStandardToolScope } from "./standard-tool-scope.js";
import { validateStandardTerminalPolicy } from "./standard-policy.js";

function readConfig(): StandardTerminalChildConfig {
  const path = process.env[STANDARD_TERMINAL_CONFIG_ENV];
  if (!path) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  const value = JSON.parse(readFileSync(path, "utf8")) as StandardTerminalChildConfig;
  if (!value || value.version !== 1 || !value.policy || typeof value.promptFile !== "string"
    || typeof value.agentDir !== "string" || !Array.isArray(value.providerExtensions)
    || (value.outputMode !== "text" && value.outputMode !== "json")) {
    throw new Error(i18n.t("terminalBackend.invalidConfig"));
  }
  validateStandardTerminalPolicy(value.policy);
  return value;
}

async function createRuntimeFactory(config: StandardTerminalChildConfig): Promise<CreateAgentSessionRuntimeFactory> {
  return async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.create(config.policy.configCwd, config.agentDir, {
      projectTrusted: config.policy.projectTrusted,
    });

    let servicesRef: AgentSessionServices | undefined;
    const readmit = new Set<string>(config.policy.structuredSchema ? [STRUCTURED_OUTPUT_TOOL_NAME] : []);
    const factories: InlineExtension[] = [];
    const scope = createStandardToolScope({
      agent: config.policy.agent,
      builtinTools: config.policy.tools,
      readmitToolNames: readmit,
      providerOnlyPaths: new Set(config.providerExtensions.map((path) => resolve(path))),
      getExtensions: () => {
        if (!servicesRef) throw new Error(i18n.t("bridge.notRunning"));
        return servicesRef.resourceLoader.getExtensions();
      },
    });
    factories.push(scope);

    if (!config.policy.isolated && config.policy.agent.allowedSubagents && config.policy.nested
      && config.policy.nested.depth < config.policy.nested.maxSubagentDepth) {
      for (const name of [SUBAGENT_TOOL_NAMES.AGENT, SUBAGENT_TOOL_NAMES.GET_RESULT, SUBAGENT_TOOL_NAMES.STEER]) {
        if (!config.policy.agent.disallowedTools?.includes(name)) readmit.add(name);
      }
      factories.push({
        name: "pi-subagents-terminal-agent-runtime",
        hidden: true,
        factory: createAgentRuntime({
          backend: config.policy.nested.backend,
          allowedSubagents: config.policy.agent.allowedSubagents,
          depth: config.policy.nested.depth,
          maxSubagentDepth: config.policy.nested.maxSubagentDepth,
          configCwd: config.policy.configCwd,
          runtimePolicy: config.policy.runtimePolicy ?? captureRuntimePolicy(config.policy.configCwd, config.policy.projectTrusted),
        }),
      });
    }
    factories.push({ name: "pi-subagents-terminal-bridge", hidden: true, factory: terminalChildExtension });

    const baseServices = await createAgentSessionServices({
      cwd: config.policy.configCwd,
      agentDir: config.agentDir,
      settingsManager,
      resourceLoaderOptions: standardResourceOptions(config, factories),
    });
    const services: AgentSessionServices = { ...baseServices, cwd };
    servicesRef = services;
    const model = config.policy.model
      ? services.modelRuntime.getModel(config.policy.model.provider, config.policy.model.id)
      : undefined;
    if (config.policy.model && !model) throw new Error(i18n.t("terminalBackend.noModel"));
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      ...(model ? { model } : {}),
      ...(config.policy.thinkingLevel !== undefined ? { thinkingLevel: config.policy.thinkingLevel } : {}),
      // Registry stays live for delayed extension tools; the scope extension
      // controls the active set and blocks out-of-scope calls.
      excludeTools: [
        ...BUILTIN_TOOL_NAMES.filter((name) => !config.policy.tools.includes(name)),
        ...(config.policy.agent.disallowedTools ?? []).filter((name) =>
          !(config.policy.structuredSchema && name === STRUCTURED_OUTPUT_TOOL_NAME)),
      ],
    });
    created.session.setSessionName(config.policy.name);
    return { ...created, services, diagnostics: services.diagnostics };
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  // This is a fresh OS process: initialize canonical non-UI settings once before
  // any scoped Agent runtime reads process-local defaults.
  initializeStandardTerminalRuntime(config.policy);
  const createRuntime = await createRuntimeFactory(config);
  const manifestPath = process.env[TERMINAL_MANIFEST_ENV];
  if (!manifestPath) throw new Error(i18n.t("bridge.invalidManifest"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { run: { session: { sessionFile: string } } };
  const sessionFile = manifest.run.session.sessionFile;
  const manager = SessionManager.open(sessionFile, dirname(sessionFile), config.policy.cwd);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: config.policy.cwd,
    agentDir: config.agentDir,
    sessionManager: manager,
  });
  const prompt = readFileSync(config.promptFile, "utf8");
  if (config.policy.interactive || !config.policy.autoExit) {
    const mode = new InteractiveMode(runtime, { initialMessage: prompt });
    await mode.run();
    return;
  }
  const exitCode = await runPrintMode(runtime, { mode: config.outputMode, initialMessage: prompt });
  if (exitCode !== 0) process.exitCode = exitCode;
}

void runInChildSessionContext(main).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
