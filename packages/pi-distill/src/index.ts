/**
 * pi-distill 工具输出提炼扩展
 *
 * 通过 Pi 的工具事件处理所有可扩展工具的结果，并在会话启动时原地扩展
 * 最终生效工具的参数 schema。不注册同名工具，也不争夺工具所有权。
 *
 * 普通已启用工具要求 outputRequest；Fusion 诊断范围使用可选参数。
 * 严格 RAW 保留收到的 content；其他请求控制摘要或证据关注重点。
 * 所有有损替换先归档原文；诊断日志可选择可核验的证据策略。
 * maxChars/maxOutputChars 仅控制成功替换预算，不截断 RAW 或失败回退。
 *
 * 配置文件优先；旧环境变量继续兼容：
 * - ~/.pi/agent/extensions/pi-distill/config.json
 * - PI_DISTILL_MODEL=provider/model
 * - PI_DISTILL_MIN_CHARS=触发提炼的最小输出字符数，默认 200
 * - PI_DISTILL_MAX_CHARS=成功替换的正文预算，默认 100000
 * - PI_DISTILL_MAX_OUTPUT_CHARS=含来源的完整替换预算，默认 10000
 * - PI_DISTILL_TIMEOUT_SECONDS=模型调用最长等待秒数，默认 10
 * - PI_DISTILL_TIMEOUT_RETRY_COUNT=提炼超时后的额外重试次数，默认 1；0 表示不重试
 * - PI_DISTILL_ERROR_RETRY_COUNT=其他异常后的额外重试次数，默认 1；0 表示不重试
 * - PI_DISTILL_MISSED_COMPRESSION_RATIO=长输出提醒倍数，默认 10
 * - 旧 PI_BASH_SUMMARY_* 变量作为兼容回退
 */

import type { complete } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import {
  appendDistillFallbackAudit,
  registerDistillFallbackRenderer,
} from "./fallback-renderer.ts";
import { getTextContent, hasNonTextContent } from "./output-limit.ts";
import { updateJsonObjectAtomic, resolveAgentDir } from "pi-extensions-config";
import { archiveSource, type SourceArtifact } from "./archive.ts";
import { buildEvidencePrompt, validateEvidence, formatEvidence } from "./evidence.ts";
import { processingConfig, processingEnabled, isMutationTool, processingReceipt, processingI18n } from "./processing-config.ts";
import { selectSourceScope, loadSource, isDiagnosticCommand, LIKELY_SECRET } from "./source.ts";
import { cleanupSessionResources, uuidv7, type Api, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import { NOTICE_TAG_COLOR, installNoticeRenderer, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";
import {
  buildSummaryPrompt,
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
  buildJsonRepairPrompt,
  decideOutputSummary,
  getDistillConfigPath,
  isRawSummary,
  loadDistillConfig,
  MIN_EFFECTIVE_COMPRESSION_RATIO,
  shouldFallbackToOriginal,
  type BashSummaryConfig,
  type DistillConfigFile,
  type DistillRenderConfig,
  type DistillToolConfig,
} from "./summary-utils.ts";
import { resolveDistillRuntimeModel } from "./model-choice.ts";
import { listDistillSelectableModels, selectDistillModel } from "./model-picker.ts";
import { estimateHeuristicTokens } from "./token-estimator.ts";
import { i18n } from "./i18n.ts";

type ToolResult = {
  content: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  usage?: Usage;
  details?: {
    fullOutputPath?: string;
    [key: string]: unknown;
  };
};

type DistillExecutionContext = {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  originalUserPrompt?: string;
  signal?: AbortSignal;
  ctx: ExtensionContext;
};

type PendingDistillCall = {
  enabled: boolean;
  outputRequest: string;
  originalUserPrompt?: string;
  startedAt: number;
};

type OutputRequestSchemaState = {
  hadProperties: boolean;
  hadRequired: boolean;
  addedRequired: boolean;
  injectedProperty: unknown;
};

const outputRequestSchemaStates = new WeakMap<object, OutputRequestSchemaState>();

type ToolResultEventPatch = {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
};

export const OUTPUT_REQUEST_DESCRIPTION = processingI18n.t("outputRequest");

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "distill";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

type SummaryDecisionMode = "RAW" | "SUMMARY";
type SummaryReasonCode =
  | "VERBATIM_REQUEST"
  | "SELECTED_INFORMATION"
  | "FIELD_EXTRACTION"
  | "ERROR_EXTRACTION"
  | "SECURITY_BOUNDARY"
  | "OTHER";

type SummaryDecision = {
  mode: SummaryDecisionMode;
  reasonCode: SummaryReasonCode;
  reason: string;
};

type SummaryUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type SummaryResult = {
  text: string;
  summaryChars: number;
  summaryFilePath?: string;
  summaryModel: string;
  decision: SummaryDecision;
  usage?: SummaryUsage;
  attempts?: number;
  jsonRepairAttempted?: boolean;
  jsonRepairSucceeded?: boolean;
};

type SummaryAttemptState = {
  usage?: SummaryUsage;
  jsonRepairAttempted?: boolean;
};

type SummaryCompletion = (...args: Parameters<typeof complete>) => ReturnType<typeof complete>;
type SummaryCompletionModel = Parameters<SummaryCompletion>[0];
type SummaryCompletionOptions = Parameters<SummaryCompletion>[2];
type DistillWarningReporter = (message: string) => void;

const OPENAI_RESPONSES_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enforce JSON mode on OpenAI-compatible summary requests without breaking other APIs. */
function addSummaryJsonResponseFormat(payload: unknown, model: SummaryCompletionModel): unknown {
  if (!isObjectRecord(payload)) return undefined;

  if (model.api === "openai-completions") {
    return {
      ...payload,
      response_format: { type: "json_object" },
    };
  }

  if (OPENAI_RESPONSES_APIS.has(model.api)) {
    return {
      ...payload,
      text: {
        ...(isObjectRecord(payload.text) ? payload.text : {}),
        format: { type: "json_object" },
      },
    };
  }

  return undefined;
}

class SummaryAttemptError extends Error {
  constructor(message: string, readonly usage?: SummaryUsage) {
    super(message);
    this.name = "SummaryAttemptError";
  }
}

class SummaryRetryError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly usage?: SummaryUsage,
  ) {
    super(message);
    this.name = "SummaryRetryError";
  }
}

/** 模型响应未通过 JSON 协议校验（可尝试 JSON-only 修复）。 */
class SummaryResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryResponseFormatError";
  }
}

/** JSON 修复失败：不再触发完整重试，避免重复总结改写事实。 */
class SummaryJsonRepairError extends Error {
  readonly jsonRepairAttempted = true;
  attempts?: number;
  constructor(message: string, public usage?: SummaryUsage) {
    super(message);
    this.name = "SummaryJsonRepairError";
  }
}

type SummaryDiagnostics = {
  toolExecutionMs?: number;
  summaryDurationMs?: number;
  summaryAttempts?: number;
  summaryInputTokens?: number;
  summaryOutputTokens?: number;
  summaryReasoningTokens?: number;
  summaryCacheReadTokens?: number;
  summaryCacheWriteTokens?: number;
  summaryTotalTokens?: number;
  summaryCost?: number;
  /** 原始输出与最终摘要的展示用 Token 数，由分段启发式估算（CJK 约每字 1 token，其余约 4 字符 1 token）。 */
  estimatedOriginalOutputTokens?: number;
  estimatedSummaryTokens?: number;
  estimatedTokensSaved?: number;
  outputSummaryIntent?: string;
  outputSummaryPrompt?: string;
  outputSummaryRender?: DistillRenderConfig;
  outputSummaryStatus?: string;
  outputSummaryAnomalies?: string[];
  outputSummaryAdvice?: string;
  /** 仅供 TUI 展示的底层错误，不追加到 Agent 可见 content。 */
  outputSummaryError?: string;
  outputSummaryDecisionMode?: SummaryDecisionMode;
  outputSummaryReasonCode?: SummaryReasonCode;
  outputSummaryReason?: string;
  summaryModel?: string;
  summaryJsonRepairAttempted?: boolean;
  summaryJsonRepairSucceeded?: boolean;
  originalOutputChars?: number;
  summaryChars?: number;
  compressionRatio?: number;
  compressionSavedPercent?: number;
  summaryTriggerMinChars?: number;
  summaryTriggerMaxChars?: number | null;
  summaryResultMaxChars?: number;
  missedCompressionRatio?: number;
};

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSummaryUsage(value: unknown): SummaryUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: SummaryUsage = {
    input: toFiniteNumber(record.input),
    output: toFiniteNumber(record.output),
    reasoning: toFiniteNumber(record.reasoning),
    cacheRead: toFiniteNumber(record.cacheRead),
    cacheWrite: toFiniteNumber(record.cacheWrite),
    cacheWrite1h: toFiniteNumber(record.cacheWrite1h),
    totalTokens: toFiniteNumber(record.totalTokens),
  };
  if (record.cost && typeof record.cost === "object" && !Array.isArray(record.cost)) {
    const cost = record.cost as Record<string, unknown>;
    usage.cost = {
      input: toFiniteNumber(cost.input),
      output: toFiniteNumber(cost.output),
      reasoning: toFiniteNumber(cost.reasoning),
      cacheRead: toFiniteNumber(cost.cacheRead),
      cacheWrite: toFiniteNumber(cost.cacheWrite),
      total: toFiniteNumber(cost.total),
    };
  }
  return Object.values(usage).some((entry) => typeof entry === "number") || usage.cost !== undefined
    ? usage
    : undefined;
}

function mergeSummaryUsage(first: SummaryUsage | undefined, second: SummaryUsage | undefined): SummaryUsage | undefined {
  if (!first && !second) return undefined;
  const merged: SummaryUsage = {};
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens"] as const) {
    const value = (first?.[key] ?? 0) + (second?.[key] ?? 0);
    if ((first?.[key] !== undefined || second?.[key] !== undefined) && Number.isFinite(value)) {
      merged[key] = value;
    }
  }
  if (first?.cost || second?.cost) {
    merged.cost = {};
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const) {
      const value = (first?.cost?.[key] ?? 0) + (second?.cost?.[key] ?? 0);
      if ((first?.cost?.[key] !== undefined || second?.cost?.[key] !== undefined) && Number.isFinite(value)) {
        merged.cost[key] = value;
      }
    }
  }
  return merged;
}

function getSummaryUsageDiagnostics(usage: SummaryUsage | undefined): Pick<
  SummaryDiagnostics,
  "summaryInputTokens" | "summaryOutputTokens" | "summaryReasoningTokens" | "summaryCacheReadTokens" | "summaryCacheWriteTokens" | "summaryTotalTokens" | "summaryCost"
> {
  return {
    summaryInputTokens: usage?.input,
    summaryOutputTokens: usage?.output,
    summaryReasoningTokens: usage?.reasoning,
    summaryCacheReadTokens: usage?.cacheRead,
    summaryCacheWriteTokens: usage?.cacheWrite,
    summaryTotalTokens: usage?.totalTokens,
    summaryCost: usage?.cost?.total,
  };
}

function withProcessingUsage(result: ToolResult, usage?: SummaryUsage): ToolResult {
  if (!usage || (!Object.values(usage).some((value) => typeof value === "number") && usage.cost?.total === undefined)) return result;
  const old = result.usage;
  const total: Usage = {
    input: (old?.input ?? 0) + (usage.input ?? 0),
    output: (old?.output ?? 0) + (usage.output ?? usage.reasoning ?? 0),
    cacheRead: (old?.cacheRead ?? 0) + (usage.cacheRead ?? 0),
    cacheWrite: (old?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
    totalTokens: (old?.totalTokens ?? 0) + (usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? usage.reasoning ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))),
    cost: {
      input: (old?.cost.input ?? 0) + (usage.cost?.input ?? 0),
      output: (old?.cost.output ?? 0) + (usage.cost?.output ?? 0),
      cacheRead: (old?.cost.cacheRead ?? 0) + (usage.cost?.cacheRead ?? 0),
      cacheWrite: (old?.cost.cacheWrite ?? 0) + (usage.cost?.cacheWrite ?? 0),
      total: (old?.cost.total ?? 0) + (usage.cost?.total ?? 0),
    },
  };
  if (old?.reasoning !== undefined || usage.reasoning !== undefined) total.reasoning = (old?.reasoning ?? 0) + (usage.reasoning ?? 0);
  if (old?.cacheWrite1h !== undefined || usage.cacheWrite1h !== undefined) total.cacheWrite1h = (old?.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0);
  return { ...result, usage: total };
}

function getTokenCompressionDiagnostics(
  originalOutput: string,
  finalOutput: string,
): Pick<SummaryDiagnostics, "estimatedOriginalOutputTokens" | "estimatedSummaryTokens" | "estimatedTokensSaved"> {
  const estimatedOriginalOutputTokens = estimateHeuristicTokens(originalOutput);
  const estimatedSummaryTokens = estimateHeuristicTokens(finalOutput);
  return {
    estimatedOriginalOutputTokens,
    estimatedSummaryTokens,
    estimatedTokensSaved: Math.max(0, estimatedOriginalOutputTokens - estimatedSummaryTokens),
  };
}

type DistillSessionStats = {
  startedAt: number;
  toolResults: number;
  summarizedResults: number;
  fallbackResults: number;
  failedResults: number;
  rawResults: number;
  skippedResults: number;
  nonTextResults: number;
  summaryAttempts: number;
  retryCount: number;
  originalOutputChars: number;
  summaryChars: number;
  summaryDurationMs: number;
  modelOperations: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryReasoningTokens: number;
  summaryCacheReadTokens: number;
  summaryCacheWriteTokens: number;
  summaryTotalTokens: number;
  hasSummaryTokenUsage: boolean;
  estimatedOriginalOutputTokens: number;
  estimatedSummaryTokens: number;
  estimatedTokensSaved: number;
  summaryCost: number;
  hasSummaryCost: boolean;
};

function createDistillSessionStats(): DistillSessionStats {
  return {
    startedAt: Date.now(),
    toolResults: 0,
    summarizedResults: 0,
    fallbackResults: 0,
    failedResults: 0,
    rawResults: 0,
    skippedResults: 0,
    nonTextResults: 0,
    summaryAttempts: 0,
    retryCount: 0,
    originalOutputChars: 0,
    summaryChars: 0,
    summaryDurationMs: 0,
    modelOperations: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryReasoningTokens: 0,
    summaryCacheReadTokens: 0,
    summaryCacheWriteTokens: 0,
    summaryTotalTokens: 0,
    hasSummaryTokenUsage: false,
    estimatedOriginalOutputTokens: 0,
    estimatedSummaryTokens: 0,
    estimatedTokensSaved: 0,
    summaryCost: 0,
    hasSummaryCost: false,
  };
}

function getDetailNumber(details: Record<string, unknown> | undefined, key: string): number | undefined {
  return toFiniteNumber(details?.[key]);
}

function recordDistillSessionResult(
  stats: DistillSessionStats,
  details: Record<string, unknown> | undefined,
): void {
  stats.toolResults += 1;
  const status = typeof details?.outputSummaryStatus === "string"
    ? details.outputSummaryStatus
    : undefined;
  if (status === "summarized" || status === "evidence-verified") stats.summarizedResults += 1;
  else if (status === "summary-fallback") stats.fallbackResults += 1;
  else if (status === "summary-failed" || status === "evidence-failed" || status === "archive-failed") stats.failedResults += 1;
  else if (status === "full-output") stats.rawResults += 1;
  else if (status === "non-text-output") stats.nonTextResults += 1;
  else stats.skippedResults += 1;

  stats.summaryAttempts += getDetailNumber(details, "summaryAttempts") ?? 0;
  const attempts = getDetailNumber(details, "summaryAttempts");
  if (attempts !== undefined) stats.retryCount += Math.max(0, attempts - 1);
  stats.originalOutputChars += getDetailNumber(details, "originalOutputChars") ?? 0;
  stats.summaryChars += getDetailNumber(details, "summaryChars") ?? 0;
  const duration = getDetailNumber(details, "summaryDurationMs");
  stats.summaryDurationMs += duration ?? 0;
  if (duration !== undefined) stats.modelOperations += 1;
  stats.summaryInputTokens += getDetailNumber(details, "summaryInputTokens") ?? 0;
  stats.summaryOutputTokens += getDetailNumber(details, "summaryOutputTokens") ?? 0;
  stats.summaryReasoningTokens += getDetailNumber(details, "summaryReasoningTokens") ?? 0;
  stats.summaryCacheReadTokens += getDetailNumber(details, "summaryCacheReadTokens") ?? 0;
  stats.summaryCacheWriteTokens += getDetailNumber(details, "summaryCacheWriteTokens") ?? 0;
  const summaryTotalTokens = getDetailNumber(details, "summaryTotalTokens");
  if (summaryTotalTokens !== undefined) {
    stats.summaryTotalTokens += summaryTotalTokens;
  }
  if (
    getDetailNumber(details, "summaryInputTokens") !== undefined
    || getDetailNumber(details, "summaryOutputTokens") !== undefined
    || getDetailNumber(details, "summaryTotalTokens") !== undefined
    || getDetailNumber(details, "summaryReasoningTokens") !== undefined
    || getDetailNumber(details, "summaryCacheReadTokens") !== undefined
    || getDetailNumber(details, "summaryCacheWriteTokens") !== undefined
  ) {
    stats.hasSummaryTokenUsage = true;
  }
  stats.estimatedOriginalOutputTokens += getDetailNumber(details, "estimatedOriginalOutputTokens") ?? 0;
  stats.estimatedSummaryTokens += getDetailNumber(details, "estimatedSummaryTokens") ?? 0;
  stats.estimatedTokensSaved += getDetailNumber(details, "estimatedTokensSaved") ?? 0;
  const cost = getDetailNumber(details, "summaryCost");
  if (cost !== undefined) {
    stats.summaryCost += cost;
    stats.hasSummaryCost = true;
  }
}

export function formatCompactCount(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const formatScaled = (scaled: number): string => {
    const rounded = Math.round(scaled * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (absolute >= 1_000_000) return `${sign}${formatScaled(absolute / 1_000_000)}m`;
  if (absolute >= 1_000) return `${sign}${formatScaled(absolute / 1_000)}k`;
  return String(Math.round(value));
}

export function formatSessionDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(1).replace(/\.0$/, "")}min`;
}

function formatDistillSessionStats(stats: DistillSessionStats): string {
  const compressionRatio = stats.summaryChars > 0
    ? (stats.originalOutputChars / stats.summaryChars).toFixed(2)
    : "-";
  const cost = stats.hasSummaryCost ? stats.summaryCost.toFixed(6) : i18n.t("statsUnavailable");
  const summaryOperations = stats.modelOperations;
  const averageDurationMs = summaryOperations > 0
    ? Math.round(stats.summaryDurationMs / summaryOperations)
    : 0;
  const tokenUsage = stats.hasSummaryTokenUsage
    ? {
        input: formatCompactCount(stats.summaryInputTokens),
        output: formatCompactCount(stats.summaryOutputTokens),
        reasoning: formatCompactCount(stats.summaryReasoningTokens),
        cacheRead: formatCompactCount(stats.summaryCacheReadTokens),
        cacheWrite: formatCompactCount(stats.summaryCacheWriteTokens),
        total: formatCompactCount(stats.summaryTotalTokens),
      }
    : {
        input: i18n.t("statsUnavailable"),
        output: i18n.t("statsUnavailable"),
        reasoning: i18n.t("statsUnavailable"),
        cacheRead: i18n.t("statsUnavailable"),
        cacheWrite: i18n.t("statsUnavailable"),
        total: i18n.t("statsUnavailable"),
      };
  return i18n.t("statsReport", {
    toolResults: formatCompactCount(stats.toolResults),
    summarizedResults: formatCompactCount(stats.summarizedResults),
    fallbackResults: formatCompactCount(stats.fallbackResults),
    failedResults: formatCompactCount(stats.failedResults),
    rawResults: formatCompactCount(stats.rawResults),
    skippedResults: formatCompactCount(stats.skippedResults),
    nonTextResults: formatCompactCount(stats.nonTextResults),
    summaryAttempts: formatCompactCount(stats.summaryAttempts),
    retryCount: formatCompactCount(stats.retryCount),
    originalOutputChars: formatCompactCount(stats.originalOutputChars),
    summaryChars: formatCompactCount(stats.summaryChars),
    compressionRatio,
    estimatedOriginalOutputTokens: formatCompactCount(stats.estimatedOriginalOutputTokens),
    estimatedSummaryTokens: formatCompactCount(stats.estimatedSummaryTokens),
    estimatedTokensSaved: formatCompactCount(stats.estimatedTokensSaved),
    summaryDuration: formatSessionDuration(stats.summaryDurationMs),
    summaryAverageDuration: formatSessionDuration(averageDurationMs),
    summaryInputTokens: tokenUsage.input,
    summaryOutputTokens: tokenUsage.output,
    summaryReasoningTokens: tokenUsage.reasoning,
    summaryCacheReadTokens: tokenUsage.cacheRead,
    summaryCacheWriteTokens: tokenUsage.cacheWrite,
    summaryTotalTokens: tokenUsage.total,
    summaryCost: cost,
  });
}

function attachDiagnostics(result: ToolResult, diagnostics: SummaryDiagnostics): ToolResult {
  return {
    ...result,
    details: {
      ...(result.details ?? {}),
      ...diagnostics,
    },
  };
}

function getCompressionDiagnostics(
  intent: string,
  originalOutputChars: number,
  summaryChars: number,
): Pick<SummaryDiagnostics, "compressionRatio" | "compressionSavedPercent" | "outputSummaryAnomalies" | "outputSummaryAdvice"> {
  const compressionRatio = summaryChars > 0 ? originalOutputChars / summaryChars : undefined;
  const compressionSavedPercent = compressionRatio === undefined
    ? undefined
    : Math.max(0, 1 - summaryChars / originalOutputChars) * 100;
  const anomalies: string[] = [];

  if (intent === "full") {
    anomalies.push("unexpected-compression");
  }
  if (compressionRatio !== undefined && compressionRatio < MIN_EFFECTIVE_COMPRESSION_RATIO) {
    anomalies.push("ineffective-compression");
  }

  return {
    compressionRatio,
    compressionSavedPercent,
    outputSummaryAnomalies: anomalies.length > 0 ? anomalies : undefined,
    outputSummaryAdvice: anomalies.length > 0
      ? "Warning: summarization ran but saved little context, which may indicate the wrong handling mode. Use strict RAW when the exact original is required; use a clearer, more compression-oriented prompt when summarization is intended."
      : undefined,
  };
}

function parseSummaryResponse(text: string, summaryModel: string): SummaryResult {
  const normalizedText = unwrapJsonCodeFence(text);
  let payload: unknown;
  try {
    payload = JSON.parse(normalizedText);
  } catch (error) {
    throw new SummaryResponseFormatError(
      `Summarizer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new SummaryResponseFormatError("Summarizer response must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const decision = record.decision;
  const summary = record.summary;
  if (!decision || typeof decision !== "object" || typeof summary !== "string") {
    throw new SummaryResponseFormatError("Summarizer response must contain decision and summary");
  }
  const decisionRecord = decision as Record<string, unknown>;
  const mode = decisionRecord.mode;
  const reasonCode = decisionRecord.reasonCode;
  const reason = decisionRecord.reason;
  const validReasonCodes: SummaryReasonCode[] = [
    "VERBATIM_REQUEST",
    "SELECTED_INFORMATION",
    "FIELD_EXTRACTION",
    "ERROR_EXTRACTION",
    "SECURITY_BOUNDARY",
    "OTHER",
  ];
  if (mode !== "RAW" && mode !== "SUMMARY") {
    throw new SummaryResponseFormatError("Summarizer decision.mode must be RAW or SUMMARY");
  }
  if (!validReasonCodes.includes(reasonCode as SummaryReasonCode)) {
    throw new SummaryResponseFormatError("Summarizer decision.reasonCode is invalid");
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 160) {
    throw new SummaryResponseFormatError("Summarizer decision.reason must be 1-160 characters");
  }
  if (mode === "RAW" && summary !== "") {
    throw new SummaryResponseFormatError("Summarizer RAW decision must have an empty summary");
  }
  if (mode === "SUMMARY" && summary.trim().length === 0) {
    throw new SummaryResponseFormatError("Summarizer SUMMARY decision must have a non-empty summary");
  }

  const parsedDecision: SummaryDecision = {
    mode,
    reasonCode: reasonCode as SummaryReasonCode,
    reason,
  };
  return {
    text: summary,
    summaryChars: summary.length,
    summaryModel,
    decision: parsedDecision,
  };
}

/** 兼容模型用 Markdown JSON 代码围栏包裹结构化响应的常见输出格式。 */
function unwrapJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(`{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i);
  return match?.[2]?.trim() ?? trimmed;
}

class PendingCancellationError extends Error {
  constructor() { super("processing-cancellation-unconfirmed"); }
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let settled = false;
  const request = work().then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; });
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    // Give signal-aware requests one event-loop turn to settle; never start another
    // billable request when cancellation of the previous transport is unconfirmed.
    onAbort = () => setImmediate(() => reject(settled ? signal.reason : new PendingCancellationError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const value = await Promise.race([request, interrupted]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", onAbort); }
}

async function completeSummaryMessage(
  completion: SummaryCompletion,
  model: SummaryCompletionModel,
  text: string,
  options: SummaryCompletionOptions,
  recordUsage?: (usage: SummaryUsage | undefined) => void,
): Promise<{ text: string; usage: SummaryUsage | undefined }> {
  options?.signal?.throwIfAborted();
  if (model.contextWindow && Number.isFinite(model.contextWindow) &&
      estimateHeuristicTokens(text) + (options?.maxTokens ?? 0) + 1024 >= model.contextWindow) {
    throw new Error("model-request-over-context-budget");
  }
  const response = await completion(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        },
      ],
    },
    options,
  );

  // Publish reported usage before validation/cancellation can leave this request
  // pending. The outer deadline must retain earlier responses during repair.
  const usage = normalizeSummaryUsage(response.usage);
  recordUsage?.(usage);
  if (options?.signal?.aborted) throw new SummaryAttemptError("processing-aborted", usage);
  if (response.stopReason && response.stopReason !== "stop") {
    throw new SummaryAttemptError(
      response.errorMessage ?? `Summarizer stopped with reason: ${response.stopReason}`,
      usage,
    );
  }

  const rawResponse = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();

  if (!rawResponse) {
    throw new SummaryAttemptError("Summarizer returned no text", usage);
  }
  return { text: rawResponse, usage };
}

/**
 * 像 pi-spark recap 一样走注册表发旁路请求。
 * 鉴权和 baseUrl 由 ModelRuntime.prepareRequest 解析；openai-codex 使用独立会话，避免复用主连接。
 */
async function completeBackground(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: Model<Api>,
  context: Context,
  options?: Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2],
) {
  if (model.api !== "openai-codex-responses") {
    return ctx.modelRegistry.streamSimple(model, context, options).result();
  }
  const sessionId = uuidv7();
  try {
    return await ctx.modelRegistry.streamSimple(model, context, { ...options, sessionId }).result();
  } finally {
    cleanupSessionResources(sessionId);
  }
}

async function summarizeOutput(
  prompt: string,
  output: string,
  config: BashSummaryConfig,
  context: DistillExecutionContext,
  signal: AbortSignal,
  attempt: SummaryAttemptState,
  completion?: SummaryCompletion,
  evidenceIsError?: boolean,
): Promise<SummaryResult> {
  const configuredReference = config.modelProvider && config.modelId
    ? `${config.modelProvider}/${config.modelId}`
    : "";
  const model = resolveDistillRuntimeModel(
    configuredReference,
    context.ctx.modelRegistry,
    context.ctx.model,
  );
  if (!model) {
    throw new Error(configuredReference
      ? i18n.t("modelNotFound", { model: configuredReference })
      : i18n.t("sessionModelMissing"));
  }

  const completionOptions = {
    maxTokens: Math.min(model.maxTokens || 8192, evidenceIsError === undefined ? 8192 : 4096, Math.max(256, Math.ceil(config.maxChars / 2))),
    cacheRetention: evidenceIsError === undefined ? undefined : "none",
    onPayload: addSummaryJsonResponseFormat,
    signal,
  } satisfies SummaryCompletionOptions;
  // 注入的 completion 只替换测试请求；生产路径走注册表，鉴权由 prepareRequest 解析。
  const request = completion ?? ((
    requestModel: Model<Api>,
    requestContext: Context,
    requestOptions?: SummaryCompletionOptions,
  ) => completeBackground(context.ctx, requestModel, requestContext, requestOptions));
  const recordUsage = (usage: SummaryUsage | undefined) => {
    attempt.usage = mergeSummaryUsage(attempt.usage, usage);
  };
  signal.throwIfAborted();
  const { text: rawResponse, usage } = await completeSummaryMessage(
    request,
    model,
    evidenceIsError === undefined
      ? [buildSummarySystemPrompt(), "", buildSummaryUserPrompt(prompt, output, context.originalUserPrompt)].join("\n")
      : buildEvidencePrompt(output, prompt),
    completionOptions,
    recordUsage,
  );
  signal.throwIfAborted();
  const summaryModel = `${model.provider}/${model.id}`;
  if (evidenceIsError !== undefined) {
    const checked = validateEvidence(rawResponse, output, evidenceIsError);
    if (!checked.ok) throw new SummaryAttemptError(`evidence-rejected:${checked.reason}`, usage);
    const text = formatEvidence(checked.evidence, checked.uncertain);
    return { text, summaryChars: text.length, summaryModel, usage, decision: {
      mode: "SUMMARY", reasonCode: "SELECTED_INFORMATION", reason: "exact-quotes",
    } };
  }
  let parsed: SummaryResult;
  let totalUsage = usage;
  try {
    parsed = parseSummaryResponse(rawResponse, summaryModel);
  } catch (error) {
    if (!(error instanceof SummaryResponseFormatError)) {
      throw new SummaryAttemptError(error instanceof Error ? error.message : String(error), usage);
    }

    // 只修复模型已返回的 JSON：不重新发送工具输出，不重新总结，避免二次总结改写事实。
    let repaired: { text: string; usage: SummaryUsage | undefined };
    attempt.jsonRepairAttempted = true;
    try {
      repaired = await completeSummaryMessage(
        request,
        model,
        buildJsonRepairPrompt(rawResponse, error.message),
        completionOptions,
        recordUsage,
      );
    } catch (repairError) {
      throw new SummaryJsonRepairError(
        `Summarizer JSON repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
        mergeSummaryUsage(usage, repairError instanceof SummaryAttemptError ? repairError.usage : undefined),
      );
    }

    try {
      parsed = parseSummaryResponse(repaired.text, summaryModel);
    } catch (repairError) {
      throw new SummaryJsonRepairError(
        `Summarizer JSON repair returned an invalid response: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
        mergeSummaryUsage(usage, repaired.usage),
      );
    }
    parsed.jsonRepairAttempted = true;
    parsed.jsonRepairSucceeded = true;
    totalUsage = mergeSummaryUsage(usage, repaired.usage);
  }
  return { ...parsed, usage: totalUsage };
}

async function summarizeOutputWithRetries(
  prompt: string,
  output: string,
  config: BashSummaryConfig,
  context: DistillExecutionContext,
  completion?: SummaryCompletion,
  evidenceIsError?: boolean,
): Promise<SummaryResult> {
  let timeoutRetries = 0;
  let errorRetries = 0;
  let attempts = 0;
  let totalUsage: SummaryUsage | undefined;

  while (true) {
    if (context.signal?.aborted) {
      throw new SummaryRetryError("Summarization aborted", attempts, totalUsage);
    }

    const attemptController = new AbortController();
    const abortFromParent = () => attemptController.abort();
    context.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (context.signal?.aborted) attemptController.abort();
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        attemptController.abort();
      },
      config.timeoutSeconds * 1000,
    );
    attempts += 1;
    const attempt: SummaryAttemptState = {};

    try {
      const result = await abortable(() => summarizeOutput(
        prompt,
        output,
        config,
        context,
        attemptController.signal,
        attempt,
        completion,
        evidenceIsError,
      ), attemptController.signal);
      totalUsage = mergeSummaryUsage(totalUsage, result.usage);
      return {
        ...result,
        usage: totalUsage,
        attempts,
      };
    } catch (error) {
      totalUsage = mergeSummaryUsage(
        totalUsage,
        (error instanceof SummaryAttemptError || error instanceof SummaryRetryError || error instanceof SummaryJsonRepairError
          ? error.usage
          : undefined) ?? attempt.usage,
      );
      if (context.signal?.aborted || error instanceof PendingCancellationError) {
        const message = context.signal?.aborted ? "Summarization aborted" : (error as Error).message;
        if (attempt.jsonRepairAttempted) {
          const repairError = new SummaryJsonRepairError(message, totalUsage);
          repairError.attempts = attempts;
          throw repairError;
        }
        throw new SummaryRetryError(message, attempts, totalUsage);
      }
      // 已有响应只需修复 JSON 时，不再重新触发一次完整总结；否则会增加成本，
      // 也可能让第二次总结改写原本已经生成的事实。
      if (error instanceof SummaryJsonRepairError) {
        error.usage = totalUsage;
        error.attempts = attempts;
        throw error;
      }
      const retryLimit = timedOut ? config.timeoutRetryCount : config.errorRetryCount;
      const retriesUsed = timedOut ? timeoutRetries : errorRetries;
      if (retriesUsed >= retryLimit) {
        throw new SummaryRetryError(
          error instanceof Error ? error.message : String(error),
          attempts,
          totalUsage,
        );
      }
      if (timedOut) timeoutRetries += 1;
      else errorRetries += 1;
      notifyWithSource({ ctx: context.ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("retryingSummary", {
        kind: i18n.t(timedOut ? "retryKindTimeout" : "retryKindError"),
        retry: retriesUsed + 1,
        limit: retryLimit,
        error: error instanceof Error ? error.message : String(error),
      }) });
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

function getOutputRequest(params: Record<string, unknown>): string {
  return typeof params.outputRequest === "string"
    ? params.outputRequest.trim()
    : "";
}

export async function processToolResult(
  context: DistillExecutionContext,
  result: ToolResult,
  toolExecutionMs: number,
  completion?: SummaryCompletion,
): Promise<ToolResult> {
  const prompt = getOutputRequest(context.params);
  const loaded = loadDistillConfig();
  const config = loaded.config;
  const originalText = getTextContent(result);
  const base: SummaryDiagnostics = {
    toolExecutionMs,
    outputSummaryPrompt: prompt || undefined,
    outputSummaryRender: { ...loaded.render },
    originalOutputChars: originalText.length,
  };
  const retain = (status: string, extra: SummaryDiagnostics = {}): ToolResult => attachDiagnostics(result, {
    ...base, outputSummaryStatus: status,
    summaryChars: originalText.length,
    ...getTokenCompressionDiagnostics(originalText, originalText),
    ...extra,
  });
  if (loaded.warnings.length) notifyWithSource({ ctx: context.ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("configWarnings", { warnings: loaded.warnings.join(" ") }) });
  if (!loaded.enabled || !config) return retain(loaded.enabled ? "disabled" : "disabled-by-config");
  if (!processingEnabled(config, context.toolName)) return result;
  if (hasNonTextContent(result)) return retain("non-text-output");
  if (isRawSummary(prompt)) return retain("full-output", { outputSummaryIntent: "full" });
  if (context.signal?.aborted) return retain("summary-failed");
  if (isObjectRecord(result.details?.distill) && result.details.distill.version === 1) return result;
  if (result.isError && !config.summarizeErrors) return retain("errors-disabled");

  const settings = processingConfig(config);
  const scope = selectSourceScope(context.toolName, context.params, result);
  if (!scope) return retain("not-requested");
  const evidence = settings.evidence.enabled && Boolean(scope.command && isDiagnosticCommand(scope.command, settings.evidence.commands));
  // Fusion is evidence-only. Never feed a mutation confirmation or diff into the generic summarizer.
  if (isMutationTool(context.toolName) && !evidence) return retain("not-requested");
  if (!evidence && !prompt) return retain("not-requested");

  let source: Awaited<ReturnType<typeof loadSource>>;
  try {
    source = await loadSource(scope, settings.archive.maxSourceBytes, context.signal);
  } catch (error) {
    return retain("diagnostic-failed", { outputSummaryError: String(error) });
  }
  if (evidence && source.kind === "preview") return retain("incomplete-source");
  if (evidence && Buffer.byteLength(source.body, "utf8") < settings.evidence.minBytes) return retain("below-threshold");
  if (!evidence) {
    const decision = decideOutputSummary(prompt, source.body, config, result.isError === true);
    if (!decision.shouldSummarize) return retain(decision.reason, { outputSummaryIntent: decision.intent });
  }
  if (LIKELY_SECRET.test(source.body)) return retain("sensitive-source");
  if (context.signal?.aborted) return retain("summary-failed");

  const modelRef = config.modelProvider && config.modelId ? `${config.modelProvider}/${config.modelId}` : "";
  const runtimeModel = resolveDistillRuntimeModel(modelRef, context.ctx.modelRegistry, context.ctx.model);
  if (runtimeModel?.contextWindow && Number.isFinite(runtimeModel.contextWindow)) {
    const payload = evidence ? buildEvidencePrompt(source.body, prompt) : buildSummaryPrompt(prompt, source.body, context.originalUserPrompt);
    const outputReserve = Math.min(runtimeModel.maxTokens || 8192, evidence ? 4096 : 8192, Math.max(256, Math.ceil(config.maxChars / 2)));
    if (estimateHeuristicTokens(payload) + outputReserve + 1024 >= runtimeModel.contextWindow) return retain("input-over-budget");
  }
  let artifact: SourceArtifact;
  try {
    artifact = await archiveSource(source.body, {
      agentDir: resolveAgentDir(),
      sessionId: context.ctx.sessionManager.getSessionId(),
      kind: source.kind,
      ...settings.archive,
      signal: context.signal,
    });
  } catch (error) {
    return retain("archive-failed", { outputSummaryAdvice: processingI18n.t("archiveFailure"), outputSummaryError: String(error) });
  }
  const started = performance.now();
  try {
    const processed = await summarizeOutputWithRetries(prompt, source.body,
      evidence ? { ...config, timeoutRetryCount: 0, errorRetryCount: 0 } : config,
      context, completion, evidence ? result.isError === true : undefined);
    const diagnostics: SummaryDiagnostics = {
      summaryDurationMs: Math.round(performance.now() - started),
      summaryAttempts: processed.attempts,
      summaryModel: processed.summaryModel,
      summaryJsonRepairAttempted: processed.jsonRepairAttempted,
      summaryJsonRepairSucceeded: processed.jsonRepairSucceeded,
      outputSummaryDecisionMode: processed.decision.mode,
      outputSummaryReasonCode: processed.decision.reasonCode,
      outputSummaryReason: processed.decision.reason,
      ...getSummaryUsageDiagnostics(processed.usage),
    };
    if (context.signal?.aborted) return withProcessingUsage(retain("summary-failed", diagnostics), processed.usage);
    if (processed.decision.mode === "RAW") return withProcessingUsage(retain("full-output", { ...diagnostics, outputSummaryIntent: "full" }), processed.usage);
    const mode = evidence ? "evidence" : "summary";
    const receipt = processingReceipt(mode, processed.text, artifact, result.isError === true);
    const candidate = scope.project(receipt + source.suffix);
    const candidateText = getTextContent(candidate);
    // Measure what actually reaches context, including citations and protected mutation text.
    if (processed.summaryChars > config.maxChars || candidateText.length > config.maxOutputChars ||
      shouldFallbackToOriginal(originalText.length, candidateText.length)) {
      return withProcessingUsage(retain("summary-fallback", { ...diagnostics, outputSummaryAnomalies: ["ineffective-compression"] }), processed.usage);
    }
    return withProcessingUsage({
      ...candidate,
      details: {
        ...(result.details ?? {}),
        ...base,
        ...diagnostics,
        outputSummaryStatus: evidence ? "evidence-verified" : "summarized",
        summaryText: receipt,
        summaryChars: candidateText.length,
        ...getCompressionDiagnostics("summary", originalText.length, candidateText.length),
        ...getTokenCompressionDiagnostics(originalText, candidateText),
        distill: { version: 1, strategy: mode, source: artifact, verification: evidence ? "exact-quotes" : "none", coverage: "not-guaranteed" },
      },
    }, processed.usage);
  } catch (error) {
    const retry = error instanceof SummaryRetryError || error instanceof SummaryJsonRepairError ? error : undefined;
    return withProcessingUsage(retain(evidence ? "evidence-failed" : "summary-failed", {
      summaryDurationMs: Math.round(performance.now() - started),
      summaryAttempts: retry?.attempts,
      ...getSummaryUsageDiagnostics(retry?.usage),
      summaryJsonRepairAttempted: error instanceof SummaryJsonRepairError || undefined,
      summaryJsonRepairSucceeded: error instanceof SummaryJsonRepairError ? false : undefined,
      outputSummaryError: error instanceof Error ? error.message : String(error),
      outputSummaryAdvice: processingI18n.t(evidence ? "evidenceRejected" : "processingFailure"),
    }), retry?.usage);
  }
}
function restoreOutputRequestParameter(parameters: Record<string, unknown>): boolean {
  const state = outputRequestSchemaStates.get(parameters);
  if (!state) return false;

  const properties = parameters.properties;
  if (isObjectRecord(properties) && properties.outputRequest === state.injectedProperty) {
    if (!state.addedRequired && Array.isArray(parameters.required) && parameters.required.includes("outputRequest")) {
      // Another extension now requires the optional field. Hand it off rather
      // than leave a required key with no property, or erase its requirement.
      outputRequestSchemaStates.delete(parameters);
      return true;
    }
    delete properties.outputRequest;
    if (!state.hadProperties && Object.keys(properties).length === 0) delete parameters.properties;
    if (state.addedRequired && Array.isArray(parameters.required)) {
      const remaining = parameters.required.filter((key) => key !== "outputRequest");
      parameters.required = remaining;
      if (!state.hadRequired && remaining.length === 0) delete parameters.required;
    }
  }
  // Never restore an old complete required array over another extension's changes.
  outputRequestSchemaStates.delete(parameters);
  return true;
}

function extendOutputRequestParameter(
  tool: ToolInfo,
  enabled: boolean,
  reportWarning: DistillWarningReporter,
  optional = false,
): boolean {
  const parameters = tool.parameters as unknown as Record<string, unknown> | undefined;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    reportWarning(i18n.t("outputRequestUnavailable", { tool: tool.name }));
    return false;
  }

  if (!enabled) return restoreOutputRequestParameter(parameters);

  if (parameters.type !== "object") {
    reportWarning(i18n.t("outputRequestUnavailable", { tool: tool.name }));
    return false;
  }

  const hadProperties = Object.prototype.hasOwnProperty.call(parameters, "properties");
  const properties = parameters.properties;
  if (properties === undefined) {
    parameters.properties = {};
  } else if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    reportWarning(i18n.t("outputRequestUnavailable", { tool: tool.name }));
    return false;
  }

  const currentProperties = parameters.properties as Record<string, unknown>;
  let state = outputRequestSchemaStates.get(parameters);
  if ((Object.hasOwn(currentProperties, "outputRequest") && (!state || currentProperties.outputRequest !== state.injectedProperty)) ||
      (!state && Array.isArray(parameters.required) && parameters.required.includes("outputRequest"))) {
    reportWarning(processingI18n.t("schemaCollision", { tool: tool.name }));
    return false;
  }
  if (!state) {
    state = { hadProperties, hadRequired: Object.hasOwn(parameters, "required"), addedRequired: false, injectedProperty: {
      type: "string", minLength: 1, pattern: "\\S", description: processingI18n.t("outputRequest"),
    } };
    outputRequestSchemaStates.set(parameters, state);
  }
  currentProperties.outputRequest = state.injectedProperty;
  const required = Array.isArray(parameters.required) ? [...parameters.required] : [];
  if (optional && state.addedRequired) {
    parameters.required = required.filter((value) => value !== "outputRequest");
    state.addedRequired = false;
  } else if (!optional && !required.includes("outputRequest")) {
    parameters.required = [...required, "outputRequest"];
    state.addedRequired = true;
  }
  return true;
}

export function extendDistillToolParameters(
  pi: Pick<ExtensionAPI, "getAllTools">,
  loaded = loadDistillConfig(),
  reportWarning: DistillWarningReporter = () => undefined,
): number {
  let extended = 0;
  for (const tool of pi.getAllTools()) {
    const enabled = loaded.enabled && Boolean(loaded.config) && processingEnabled(loaded.config!, tool.name);
    const schema = tool.parameters as { properties?: Record<string, unknown> } | undefined;
    const supportsScope = !isMutationTool(tool.name) || Boolean(schema?.properties?.then_run);
    if (extendOutputRequestParameter(tool, enabled && supportsScope, reportWarning, isMutationTool(tool.name)) && enabled && supportsScope) extended += 1;
  }
  return extended;
}

function ownsOutputRequest(pi: Pick<ExtensionAPI, "getAllTools">, name: string): boolean {
  const schema = pi.getAllTools().find((tool) => tool.name === name)?.parameters as Record<string, unknown> | undefined;
  if (!schema) return false;
  const state = outputRequestSchemaStates.get(schema);
  return Boolean(state && isObjectRecord(schema.properties) && schema.properties.outputRequest === state.injectedProperty);
}

function toToolResultEventResult(result: ToolResult): ToolResultEventPatch {
  return {
    content: result.content as ToolResultEvent["content"],
    details: result.details,
    isError: result.isError,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

type DistillUiConfig = Required<Pick<DistillConfigFile, "enabled" | "model" | "minChars" | "maxChars" | "maxOutputChars" | "timeoutSeconds" | "timeoutRetryCount" | "errorRetryCount" | "missedCompressionRatio" | "summarizeErrors">> & {
  tools: DistillToolConfig;
  render: DistillRenderConfig;
  evidence: ReturnType<typeof processingConfig>["evidence"];
  archive: ReturnType<typeof processingConfig>["archive"];
};

function getDistillUiConfig(): DistillUiConfig {
  const loaded = loadDistillConfig();
  const config = loaded.config;
  return {
    enabled: loaded.enabled,
    model: config?.modelProvider && config.modelId
      ? `${config.modelProvider}/${config.modelId}`
      : "",
    minChars: config?.minChars ?? 200,
    maxChars: config?.maxChars ?? 100_000,
    maxOutputChars: config?.maxOutputChars ?? 10_000,
    timeoutSeconds: config?.timeoutSeconds ?? 10,
    timeoutRetryCount: config?.timeoutRetryCount ?? 1,
    errorRetryCount: config?.errorRetryCount ?? 1,
    missedCompressionRatio: config?.missedCompressionRatio ?? 10,
    summarizeErrors: config?.summarizeErrors ?? true,
    tools: Object.fromEntries(
      Object.entries(config?.tools ?? {}).map(([toolName, override]) => [toolName, { ...override }]),
    ),
    render: { ...loaded.render },
    ...processingConfig(config),
  };
}

async function editDistillNumber(
  ctx: ExtensionCommandContext,
  title: string,
  current: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(title, String(current));
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) <= 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("positiveInteger") });
    return undefined;
  }
  return Number(value);
}

async function editDistillNonNegativeInteger(
  ctx: ExtensionCommandContext,
  title: string,
  current: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(title, String(current));
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("nonNegativeInteger") });
    return undefined;
  }
  return parsed;
}

async function editDistillModel(
  ctx: ExtensionCommandContext,
  current: string,
): Promise<string | undefined> {
  const models = listDistillSelectableModels(ctx);
  if (models.length === 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("modelPickerNoModels") });
  }
  return selectDistillModel(ctx, models, current, {
    title: i18n.t("modelPickerTitle"),
    currentModel: i18n.t("currentModel"),
    filterPlaceholder: i18n.t("modelPickerFilter"),
    noMatch: i18n.t("modelPickerNoMatch"),
    navigate: i18n.t("modelPickerNavigate"),
    select: i18n.t("modelPickerSelect"),
    cancel: i18n.t("modelPickerCancel"),
    filter: i18n.t("modelPickerType"),
  });
}

async function saveDistillConfigFile(
  ctx: ExtensionCommandContext,
  config: DistillUiConfig,
  configPath: string,
  onSaved?: () => void,
): Promise<void> {
  updateJsonObjectAtomic(configPath, (current) => {
    const oldTools = isObjectRecord(current.tools) ? current.tools : {};
    const tools = { ...oldTools };
    for (const [name, override] of Object.entries(config.tools)) {
      tools[name] = { ...(isObjectRecord(oldTools[name]) ? oldTools[name] : {}), ...override };
    }
    return {
      ...current, ...config, tools,
      render: { ...(isObjectRecord(current.render) ? current.render : {}), ...config.render },
      evidence: { ...(isObjectRecord(current.evidence) ? current.evidence : {}), ...config.evidence },
      archive: { ...(isObjectRecord(current.archive) ? current.archive : {}), ...config.archive },
    };
  });
  const saved = loadDistillConfig();
  if (saved.warnings.length > 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("savedWarnings", { warnings: saved.warnings.join(" ") }) });
  }
  onSaved?.();
}

function getConfigurableToolNames(pi: Pick<ExtensionAPI, "getAllTools">): string[] {
  return [...new Set(
    pi.getAllTools()
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0),
  )].sort();
}

async function runDistillToolConfigUi(
  ctx: ExtensionCommandContext,
  pi: Pick<ExtensionAPI, "getAllTools">,
  config: DistillUiConfig,
  configPath: string,
  onSaved: () => void,
): Promise<void> {
  const toolNames = getConfigurableToolNames(pi);
  if (toolNames.length === 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noConfigurableTools") });
    return;
  }

  while (true) {
    const choices = toolNames.map((toolName) => i18n.t("toolStatus", {
      tool: toolName,
      value: processingEnabled(config, toolName) ? i18n.t("on") : i18n.t("off"),
    }));
    const choice = await ctx.ui.select(i18n.t("toolSettingsTitle"), choices);
    if (choice === undefined) return;
    const index = choices.indexOf(choice);
    if (index < 0) return;
    const toolName = toolNames[index];
    config.tools[toolName] = { enabled: !processingEnabled(config, toolName) };
    await saveDistillConfigFile(ctx, config, configPath, onSaved);
  }
}

async function runDistillConfigUi(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  configPath: string,
  onSaved: () => void,
): Promise<void> {
  const loaded = loadDistillConfig();
  if (loaded.warnings.length > 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("configWarnings", { warnings: loaded.warnings.join(" ") }) });
  }
  if (!loaded.config) return; // Critical invalid fields require manual repair; never overwrite them with defaults.
  const config = getDistillUiConfig();

  while (true) {
    const choices = [
      i18n.t("status", { value: config.enabled ? i18n.t("on") : i18n.t("off") }),
      i18n.t("model", { value: config.model || i18n.t("currentModel") }),
      i18n.t("minOutput", { value: config.minChars }),
      i18n.t("summaryLimit", { value: config.maxChars }),
      i18n.t("finalLimit", { value: config.maxOutputChars }),
      i18n.t("timeout", { value: config.timeoutSeconds }),
      i18n.t("timeoutRetryCount", { value: config.timeoutRetryCount }),
      i18n.t("errorRetryCount", { value: config.errorRetryCount }),
      i18n.t("threshold", { value: config.missedCompressionRatio }),
      i18n.t("summarizeErrors", { value: config.summarizeErrors ? i18n.t("on") : i18n.t("off") }),
      i18n.t("auditRenderer", { value: config.render.enabled ? i18n.t("on") : i18n.t("off") }),
      i18n.t("showOutputRequest", { value: config.render.showPrompt ? i18n.t("on") : i18n.t("off") }),
      i18n.t("showSummary", { value: config.render.showResult ? i18n.t("on") : i18n.t("off") }),
      i18n.t("toolOverrides"),
      processingI18n.t("evidenceSetting", { value: config.evidence.enabled ? i18n.t("on") : i18n.t("off") }),
      processingI18n.t("fusionSetting", { value: config.evidence.fusion ? i18n.t("on") : i18n.t("off") }),
    ];
    const choice = await ctx.ui.select(i18n.t("settingsTitle"), choices);
    if (choice === undefined) return;

    if (choice === choices[0]) {
      config.enabled = !config.enabled;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[1]) {
      const value = await editDistillModel(ctx, config.model);
      if (value !== undefined) {
        config.model = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[2]) {
      const value = await editDistillNumber(ctx, i18n.t("minOutputTitle"), config.minChars);
      if (value !== undefined) {
        config.minChars = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[3]) {
      const value = await editDistillNumber(ctx, i18n.t("summaryLimitTitle"), config.maxChars);
      if (value !== undefined) {
        config.maxChars = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[4]) {
      const value = await editDistillNumber(ctx, i18n.t("finalLimitTitle"), config.maxOutputChars);
      if (value !== undefined) {
        config.maxOutputChars = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[5]) {
      const value = await editDistillNumber(ctx, i18n.t("timeoutTitle"), config.timeoutSeconds);
      if (value !== undefined) {
        config.timeoutSeconds = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[6]) {
      const value = await editDistillNonNegativeInteger(
        ctx,
        i18n.t("timeoutRetryCountTitle"),
        config.timeoutRetryCount,
      );
      if (value !== undefined) {
        config.timeoutRetryCount = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[7]) {
      const value = await editDistillNonNegativeInteger(
        ctx,
        i18n.t("errorRetryCountTitle"),
        config.errorRetryCount,
      );
      if (value !== undefined) {
        config.errorRetryCount = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[8]) {
      const value = await editDistillNumber(ctx, i18n.t("thresholdTitle"), config.missedCompressionRatio);
      if (value !== undefined) {
        config.missedCompressionRatio = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[9]) {
      config.summarizeErrors = !config.summarizeErrors;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[10]) {
      config.render.enabled = !config.render.enabled;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[11]) {
      config.render.showPrompt = !config.render.showPrompt;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[12]) {
      config.render.showResult = !config.render.showResult;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[13]) {
      await runDistillToolConfigUi(ctx, pi, config, configPath, onSaved);
    } else if (choice === choices[14]) {
      config.evidence.enabled = !config.evidence.enabled;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[15]) {
      config.evidence.fusion = !config.evidence.fusion;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    }
  }
}

function registerDistillConfigCommand(
  pi: ExtensionAPI,
  onSaved: (ctx: ExtensionCommandContext) => void,
): void {
  const command = {
    description: i18n.t("commandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("interactiveOnly") });
        return;
      }
      await runDistillConfigUi(ctx, pi, getDistillConfigPath(), () => onSaved(ctx));
    },
  };
  for (const name of ["config:distill", "pi-distill"] as const) {
    pi.registerCommand(name, command);
  }
}

function registerDistillStatsCommand(
  pi: ExtensionAPI,
  getStats: () => DistillSessionStats,
): void {
  pi.registerCommand("distill:stats", {
    description: i18n.t("statsCommandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("interactiveOnly") });
        return;
      }
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: formatDistillSessionStats(getStats()) });
    },
  });
}

export default function piDistillExtension(pi: ExtensionAPI) {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  const pendingCalls = new Map<string, PendingDistillCall>();
  const reportedWarnings = new Set<string>();
  let sessionStats = createDistillSessionStats();
  let originalUserPrompt = "";
  registerDistillFallbackRenderer(pi);
  const extendParameters = (ctx: ExtensionContext) => {
    const reportWarning = (message: string) => {
      if (reportedWarnings.has(message)) return;
      reportedWarnings.add(message);
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message });
    };
    try {
      extendDistillToolParameters(pi, loadDistillConfig(), reportWarning);
    } catch (error) {
      reportWarning(i18n.t("extendOutputRequestFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionStats = createDistillSessionStats();
    extendParameters(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    originalUserPrompt = typeof event.prompt === "string" ? event.prompt : "";
    extendParameters(ctx);
    const loaded = loadDistillConfig();
    if (!loaded.enabled || !loaded.config) return;
    const controlled = pi.getAllTools().filter((tool) => ownsOutputRequest(pi, tool.name)).map((tool) => tool.name);
    if (controlled.length === 0) return;
    return {
      systemPrompt: [
        typeof event.systemPrompt === "string" ? event.systemPrompt : "",
        `<output-prompt-contract>\n${processingI18n.t("contract", { tools: controlled.join(", ") })}\n</output-prompt-contract>`,
      ].filter((value) => value.length > 0).join("\n\n"),
    };
  });
  pi.on("tool_call", (event) => {
    const loaded = loadDistillConfig();
    const owned = ownsOutputRequest(pi, event.toolName);
    const enabled = loaded.enabled
      && Boolean(loaded.config)
      && processingEnabled(loaded.config!, event.toolName)
      && owned;
    pendingCalls.set(event.toolCallId, {
      enabled,
      outputRequest: enabled ? getOutputRequest(event.input) : "",
      originalUserPrompt,
      startedAt: performance.now(),
    });
    // outputRequest 只控制结果处理，不能泄漏给底层内置工具。
    if (owned) delete (event.input as Record<string, unknown>).outputRequest;
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const pending = pendingCalls.get(event.toolCallId);
    pendingCalls.delete(event.toolCallId);
    if (pending ? !pending.enabled : !ownsOutputRequest(pi, event.toolName)) {
      const untouchedResult: ToolResult = {
        content: event.content,
        details: event.details as Record<string, unknown> | undefined,
        isError: event.isError,
        usage: event.usage,
      };
      recordDistillSessionResult(sessionStats, untouchedResult.details);
      return toToolResultEventResult(untouchedResult);
    }
    const outputRequest = pending?.outputRequest ?? getOutputRequest(event.input);
    const result = await processToolResult(
      {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        params: { ...event.input, outputRequest },
        originalUserPrompt: pending?.originalUserPrompt ?? originalUserPrompt,
        signal: ctx.signal,
        ctx,
      },
      {
        content: event.content,
        details: event.details as Record<string, unknown> | undefined,
        isError: event.isError,
        usage: event.usage,
      },
      pending ? Math.round(performance.now() - pending.startedAt) : 0,
    );
    recordDistillSessionResult(sessionStats, result.details);
    appendDistillFallbackAudit(pi, event.toolName, result.details, loadDistillConfig().render);
    return toToolResultEventResult(result);
  });
  pi.on("agent_end", () => pendingCalls.clear());
  registerDistillStatsCommand(pi, () => sessionStats);
  registerDistillConfigCommand(pi, extendParameters);
}
