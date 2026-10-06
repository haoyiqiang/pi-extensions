import {
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  SettingsManager,
  type AgentSessionServices,
  type ExtensionFactory,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { bindNoticeOwner, type NoticeOwnerBinding } from "pi-extensions-i18n";
import { isOrdinaryChildProduct, withoutOrdinaryChildProducts } from "../child-resource-policy.js";
import type { ExecutionBackendKind } from "../backends/session-reference.js";
import type { SubagentsRuntimePolicy } from "../runtime-policy.js";

export interface StandardWorkflowRuntimeIdentity {
  readonly cwd: string;
  readonly runId: string;
  /** The runtime-only Agent facade pins fresh nested sessions to this backend. */
  readonly backend: ExecutionBackendKind;
  readonly runtimePolicy?: SubagentsRuntimePolicy;
}

export type StandardWorkflowRuntimeInitializer = ExtensionFactory;
export type StandardWorkflowRuntimeFactory = (
  identity: StandardWorkflowRuntimeIdentity,
) => StandardWorkflowRuntimeInitializer;

export interface StandardWorkflowResourceOptions extends StandardWorkflowRuntimeIdentity {
  projectTrusted: boolean;
  modelRuntime: ModelRuntime;
  initializeRuntime?: StandardWorkflowRuntimeInitializer;
  createRuntime?: StandardWorkflowRuntimeFactory;
  noticeOwner?: NoticeOwnerBinding;
}

export const isStandardWorkflowChildProduct = isOrdinaryChildProduct;
export const withoutStandardWorkflowChildProducts = withoutOrdinaryChildProducts;

/** Native SDK resources stay available, but root products cannot bind a child.
 * Pi filters after factories: package factories must remain registration-only. */
export async function createStandardWorkflowServices(
  options: StandardWorkflowResourceOptions,
): Promise<AgentSessionServices> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.projectTrusted });
  const runtimeExtension = options.createRuntime?.({
    cwd: options.cwd, runId: options.runId, backend: options.backend, runtimePolicy: options.runtimePolicy,
  }) ?? options.initializeRuntime;
  const extensionFactories = runtimeExtension
    ? [{ name: "pi-subagents-standard-runtime", factory: runtimeExtension, hidden: true }]
    : [];
  if (options.noticeOwner) {
    extensionFactories.push({ name: "pi-subagents-standard-notices", hidden: true, factory: pi => {
      let release = () => {};
      pi.on("session_start", (_event, ctx) => { release(); release = bindNoticeOwner(ctx, options.noticeOwner); });
      pi.on("session_shutdown", () => { release(); });
    } });
  }
  return createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    modelRuntime: options.modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      eventBus: createEventBus(), extensionFactories, extensionsOverride: withoutOrdinaryChildProducts,
    },
  });
}
