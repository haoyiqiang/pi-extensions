import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  SettingsManager,
  type AgentSessionServices,
  type Extension,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionBackendKind } from "../backends/session-reference.js";

export interface StandardWorkflowRuntimeIdentity {
  readonly cwd: string;
  readonly runId: string;
  /** The runtime-only Agent facade must pin fresh nested sessions to this backend. */
  readonly backend: ExecutionBackendKind;
}

/** Supplies Agent/RPC/runtime tools only; never the legacy interactive product UI. */
export type StandardWorkflowRuntimeInitializer = ExtensionFactory;
export type StandardWorkflowRuntimeFactory = (
  identity: StandardWorkflowRuntimeIdentity,
) => StandardWorkflowRuntimeInitializer;

export interface StandardWorkflowResourceOptions extends StandardWorkflowRuntimeIdentity {
  projectTrusted: boolean;
  modelRuntime: ModelRuntime;
  initializeRuntime?: StandardWorkflowRuntimeInitializer;
  createRuntime?: StandardWorkflowRuntimeFactory;
}

const STANDARD_RUNTIME_EXTENSION = "pi-subagents-standard-runtime";
const AMBIENT_OBSERVER_MANIFEST_FLAG = "ambientObserver";
const manifestFlagCache = new Map<string, boolean>();

function extensionIdentity(extension: Extension): string {
  return [extension.path, extension.resolvedPath, extension.sourceInfo?.source]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function findPackageJson(startPath: string): string | undefined {
  let directory = dirname(startPath);
  for (let depth = 0; depth < 32; depth++) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

function readsPiManifestFlag(path: string, flag: string): boolean {
  if (!path || path.startsWith("<")) return false;
  const key = `${path}::${flag}`;
  const cached = manifestFlagCache.get(key);
  if (cached !== undefined) return cached;
  let enabled = false;
  try {
    const packageJson = findPackageJson(path);
    if (packageJson) {
      const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { pi?: Record<string, unknown> };
      enabled = manifest.pi?.[flag] === true;
    }
  } catch {
    enabled = false;
  }
  manifestFlagCache.set(key, enabled);
  return enabled;
}

/**
 * Filter only concrete root products and declared ambient observers. RPIV tool
 * extensions remain discoverable; in particular, no package-wide rpiv-pi rule
 * removes rpiv-args, questionnaires, or other stage dependencies.
 */
export function isStandardWorkflowChildProduct(extension: Extension): boolean {
  if (extension.path === `<inline:${STANDARD_RUNTIME_EXTENSION}>`) return false;
  if (readsPiManifestFlag(extension.resolvedPath, AMBIENT_OBSERVER_MANIFEST_FLAG)) return true;

  const identity = extensionIdentity(extension);
  if (identity.includes("rpiv-warp")) return true;
  if (identity.includes("/pi-subagents/workflow-executor.")) return true;
  if (/\/pi-subagents\/(?:src\/)?index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/pi-interactive-subagents\/(?:src\/)?index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/pi-workflow\/(?:src\/)?extension\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/pi-spark\/(?:src\/)?index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  if (/\/(?:extensions\/)?rpiv-core\/index\.[cm]?[jt]s(?:$|\n)/u.test(identity)) return true;
  return false;
}

export function withoutStandardWorkflowChildProducts(base: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.filter(extension => !isStandardWorkflowChildProduct(extension)),
  };
}

/**
 * Create one fresh standard Pi service set per workflow child. Project trust is
 * inherited from the resolved launcher decision. Model/auth/provider state is
 * the captured launcher runtime, not a second models.json-selected runtime.
 */
export async function createStandardWorkflowServices(
  options: StandardWorkflowResourceOptions,
): Promise<AgentSessionServices> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const identity: StandardWorkflowRuntimeIdentity = {
    cwd: options.cwd,
    runId: options.runId,
    backend: options.backend,
  };
  const runtimeExtension = options.createRuntime?.(identity) ?? options.initializeRuntime;
  const extensionFactories = runtimeExtension
    ? [{ name: STANDARD_RUNTIME_EXTENSION, factory: runtimeExtension, hidden: true }]
    : [];

  return createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    modelRuntime: options.modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      eventBus: createEventBus(),
      extensionFactories,
      extensionsOverride: withoutStandardWorkflowChildProducts,
    },
  });
}
