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
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { createAgentRuntime } from "../../agent-runtime.js";
import { runInChildSessionContext } from "../../child-context.js";
import { i18n } from "../../i18n.js";
import { initializeSubagentsRuntime } from "../../runtime.js";
import { BUILTIN_TOOL_NAMES } from "../../agent-types.js";
import { SUBAGENT_TOOL_NAMES, extensionCanonicalNames, parseExtensionsSpec } from "../embedded.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../structured-output.js";
import {
  STANDARD_TERMINAL_CONFIG_ENV,
  TERMINAL_MANIFEST_ENV,
  type StandardTerminalChildConfig,
} from "./bridge-protocol.js";
import terminalChildExtension from "./child-extension.js";
import { createStandardToolScope } from "./standard-tool-scope.js";
import { validateStandardTerminalPolicy } from "./standard-policy.js";

const PRIVATE_INLINE_PREFIX = "<inline:pi-subagents-terminal-";
const ORCHESTRATION_EXTENSION_NAMES = new Set(["pi-subagents", "pi-interactive-subagents"]);

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

function resourceOptions(
  config: StandardTerminalChildConfig,
  privateFactories: InlineExtension[],
) {
  const { policy } = config;
  const extensions = policy.isolated ? false : policy.agent.extensions;
  const excludes = new Set((policy.agent.excludeExtensions ?? []).map((name) => name.toLowerCase()));
  const spec = Array.isArray(extensions) ? parseExtensionsSpec(extensions, policy.configCwd) : undefined;
  const keep = spec?.names ?? new Set<string>();
  const loadAll = extensions === true || spec?.wildcard === true;
  const noExtensions = extensions === false;
  const additionalExtensionPaths = [
    ...(spec?.paths ?? []),
    ...config.providerExtensions,
  ];
  const providerPaths = new Set(config.providerExtensions.map((path) => resolve(path)));

  const extensionsOverride = (base: LoadExtensionsResult): LoadExtensionsResult => ({
    ...base,
    extensions: base.extensions.filter((extension) => {
      if (extension.path.startsWith(PRIVATE_INLINE_PREFIX)) return true;
      if (providerPaths.has(resolve(extension.resolvedPath))) return true;
      const canons = extensionCanonicalNames(extension.path);
      if (canons.some((name) => ORCHESTRATION_EXTENSION_NAMES.has(name))) return false;
      if (canons.some((name) => excludes.has(name))) return false;
      return loadAll || canons.some((name) => keep.has(name));
    }).map((extension) => providerPaths.has(resolve(extension.resolvedPath))
      // Remove registry entries too, so a provider cannot shadow an allowed builtin.
      ? { ...extension, tools: new Map() }
      : extension),
  });

  return {
    noExtensions,
    additionalExtensionPaths: additionalExtensionPaths.length > 0 ? additionalExtensionPaths : undefined,
    extensionFactories: privateFactories,
    extensionsOverride,
    noSkills: policy.isolated || policy.agent.skills === false || Array.isArray(policy.agent.skills),
    noPromptTemplates: policy.isolated,
    noThemes: policy.isolated,
    noContextFiles: policy.isolated,
    systemPromptOverride: () => policy.systemPrompt,
    // Keep normal configured append prompts and project context from configCwd.
    appendSystemPromptOverride: (base: string[]) => base,
  };
}

async function createRuntimeFactory(config: StandardTerminalChildConfig): Promise<CreateAgentSessionRuntimeFactory> {
  return async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.create(config.policy.configCwd, config.agentDir);
    settingsManager.setProjectTrusted(config.policy.projectTrusted);

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
        }),
      });
    }
    factories.push({ name: "pi-subagents-terminal-bridge", hidden: true, factory: terminalChildExtension });

    const baseServices = await createAgentSessionServices({
      cwd: config.policy.configCwd,
      agentDir: config.agentDir,
      settingsManager,
      resourceLoaderOptions: resourceOptions(config, factories),
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
  initializeSubagentsRuntime(config.policy.configCwd);
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
