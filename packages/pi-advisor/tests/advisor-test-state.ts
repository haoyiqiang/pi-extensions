import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach } from "vitest";
import {
  __resetAdvisorAnnounced as resetAnnounced,
  createAdvisorState,
  getAdvisorEffort as getEffort,
  getAdvisorModel as getModel,
  isModelBlocked as modelBlocked,
  registerAdvisorBeforeAgentStart as registerBeforeStart,
  registerAdvisorCommand as registerCommand,
  registerAdvisorSessionStart as registerSessionStart,
  registerAdvisorTool as registerTool,
  registerModelSelectHandler as registerModelSelect,
  registerThinkingLevelSelectHandler as registerThinkingSelect,
  resetAdvisorState,
  restoreAdvisorState as restoreState,
  setAdvisorEffort as setEffort,
  setAdvisorModel as setModel,
  setDisabledForModels as setDisabled,
  type DisabledForModelsEntry,
  type GradedEffort,
} from "../index.ts";

export * from "../advisor/index.ts";
export const advisorState = createAdvisorState();
export const resetTestAdvisorState = () => resetAdvisorState(advisorState);
beforeEach(resetTestAdvisorState);
export const getAdvisorModel = () => getModel(advisorState);
export const setAdvisorModel = (model: Model<Api> | undefined) => setModel(advisorState, model);
export const getAdvisorEffort = () => getEffort(advisorState);
export const setAdvisorEffort = (effort: GradedEffort | undefined) => setEffort(advisorState, effort);
export const setDisabledForModels = (entries: DisabledForModelsEntry[]) => setDisabled(advisorState, entries);
export const isModelBlocked = (model: Model<Api> | undefined, level?: string) => modelBlocked(advisorState, model, level);
export const registerAdvisorTool = (pi: ExtensionAPI) => registerTool(pi, advisorState);
export const registerAdvisorCommand = (pi: ExtensionAPI) => registerCommand(pi, advisorState);
export const registerAdvisorBeforeAgentStart = (pi: ExtensionAPI) => registerBeforeStart(pi, advisorState);
export const registerModelSelectHandler = (pi: ExtensionAPI) => registerModelSelect(pi, advisorState);
export const registerThinkingLevelSelectHandler = (pi: ExtensionAPI) => registerThinkingSelect(pi, advisorState);
export const registerAdvisorSessionStart = (pi: ExtensionAPI) => registerSessionStart(pi, advisorState);
export const restoreAdvisorState = (ctx: ExtensionContext, pi: ExtensionAPI) => restoreState(advisorState, ctx, pi);
export const __resetAdvisorAnnounced = () => resetAnnounced(advisorState);
