import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../../agent-types.js";
import { i18n } from "../../i18n.js";
import type { LifetimeUsage } from "../../usage.js";
import { createStructuredCapture, createStructuredOutputTool, structuredFailure, structuredRetryPrompt,
  STRUCTURED_OUTPUT_TOOL_NAME, type StructuredCapture } from "../../structured-output.js";
import { compileTerminalSchema, policyContinuation, validTurnBudget } from "./run-policy.js";
import type { SessionViewEvent, TranscriptMessage } from "../session.js";
import {
  BRIDGE_VERSION,
  BridgeFrames,
  encodeBridgeFrame,
  modelFingerprint,
  TERMINAL_MANIFEST_ENV,
  type ChildFeedback,
  type ChildHello,
  type ChildPacket,
  type ParentControl,
  type TerminalChildManifest,
  type TerminalSnapshot,
} from "./bridge-protocol.js";

export type TerminalChildConnect = (options: { host: "127.0.0.1"; port: number }) => Socket;

type ManifestSource = unknown | (() => unknown);
type BridgeState = "waiting" | "connecting" | "running" | "settling" | "failed" | "closed";

type SocketListener = (...args: any[]) => void;

const BUILTIN_TOOLS = new Set(BUILTIN_TOOL_NAMES);

const defaultConnect: TerminalChildConnect = (options) => createConnection(options);

/**
 * Register the private terminal-child bridge. All Pi handlers are installed now;
 * manifest validation and transport creation are deferred until session_start.
 */
export function registerTerminalChild(
  pi: ExtensionAPI,
  manifestSource: ManifestSource,
  connectFn: TerminalChildConnect = defaultConnect,
): void {
  let state: BridgeState = "waiting";
  let manifest: TerminalChildManifest | undefined;
  let socket: Socket | undefined;
  let sessionContext: ExtensionContext | undefined;
  let connected = false;
  let cleaned = false;
  let sequence = 0;
  let turnCount = 0;
  let softLimitReached = false;
  let hardLimitReached = false;
  let structuredCapture: StructuredCapture | undefined;
  let structuredRetried = false;
  const allowedTools = () => [...(manifest?.tools ?? []), ...(structuredCapture ? [STRUCTURED_OUTPUT_TOOL_NAME] : [])];
  let permitted = false;
  let agentStarted = false;
  const pendingSteers: Array<Extract<ParentControl, { type: "steer" }>> = [];
  let abortRequested = false;
  let shutdownRequested = false;
  let settledFlushed = false;
  let pendingWrites = 0;
  let resolveSessionStart: (() => void) | undefined;
  let connectListener: SocketListener | undefined;
  let finalAssistant: AssistantMessage | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  let policyFailure: string | undefined;
  const frames = new BridgeFrames();

  const safeAbort = (ctx: ExtensionContext): void => {
    try { ctx.abort(); } catch { /* fail-closed shutdown continues */ }
  };

  const safeShutdown = (ctx: ExtensionContext): void => {
    if (shutdownRequested) return;
    try {
      ctx.shutdown();
      shutdownRequested = true;
    } catch { /* allow another flush/disconnect callback to retry; parent retirement is bounded */ }
  };

  const maybeShutdownAfterSettled = (): void => {
    if (!settledFlushed || pendingWrites !== 0 || !sessionContext) return;
    safeShutdown(sessionContext);
  };

  const writeFrame = (
    value: unknown,
    options: {
      allowTerminalState?: boolean;
      onFlushed?: () => void;
      onFailure?: () => void;
    } = {},
  ): boolean => {
    const target = socket;
    if (!target || !connected || (!options.allowTerminalState && state !== "running" && state !== "settling")) {
      options.onFailure?.();
      return false;
    }

    let encoded: string;
    try {
      encoded = encodeBridgeFrame(value);
    } catch {
      options.onFailure?.();
      return false;
    }

    pendingWrites++;
    let callbackCalled = false;
    const finish = (error?: Error | null) => {
      if (callbackCalled) return;
      callbackCalled = true;
      pendingWrites = Math.max(0, pendingWrites - 1);
      if (error) options.onFailure?.();
      else options.onFlushed?.();
      maybeShutdownAfterSettled();
    };

    try {
      target.write(encoded, finish);
      return true;
    } catch {
      finish(new Error(i18n.t("bridge.disconnected")));
      return false;
    }
  };

  const nextPacket = (feedback: ChildFeedback): ChildPacket => ({ ...feedback, seq: ++sequence });

  const sendFeedback = (feedback: ChildFeedback, onFlushed?: () => void): boolean => writeFrame(
    nextPacket(feedback),
    { onFlushed },
  );

  const failClosed = (
    error: string,
    ctx: ExtensionContext,
    options: { report?: boolean } = {},
  ): void => {
    if (state === "failed" || state === "closed") return;
    state = "failed";
    if (authenticationTimer) clearTimeout(authenticationTimer);
    resolveSessionStart?.();
    resolveSessionStart = undefined;
    safeAbort(ctx);

    if (options.report !== false && connected && socket) {
      const sent = writeFrame(nextPacket({ type: "failure", error }), {
        allowTerminalState: true,
        onFlushed: () => safeShutdown(ctx),
        onFailure: () => safeShutdown(ctx),
      });
      if (sent) return;
    }
    safeShutdown(ctx);
  };

  const snapshot = (ctx: ExtensionContext): TerminalSnapshot => {
    const messages = ctx.sessionManager.buildSessionProjection().messages as readonly TranscriptMessage[];
    let input = 0;
    let output = 0;
    let cacheWrite = 0;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const usage = (message as AssistantMessage).usage;
      if (!usage) continue;
      input += finiteNumber(usage.input);
      output += finiteNumber(usage.output);
      cacheWrite += finiteNumber(usage.cacheWrite);
    }

    const contextPercent = safeContextPercent(ctx);
    const model = safeModel(ctx);
    let thinkingLevel: TerminalSnapshot["thinkingLevel"];
    try {
      thinkingLevel = pi.getThinkingLevel();
    } catch {
      thinkingLevel = undefined;
    }

    return {
      messages,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      stats: {
        tokens: { input, output, cacheWrite },
        contextUsage: { percent: contextPercent },
      },
    };
  };

  const sendSnapshot = (event: SessionViewEvent, ctx: ExtensionContext): void => {
    if (state !== "running") return;
    try {
      if (!sendFeedback({ type: "snapshot", event, snapshot: snapshot(ctx) })) {
        failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
      }
    } catch {
      failClosed(i18n.t("bridge.protocol"), ctx);
    }
  };

  const enforceTools = (ctx: ExtensionContext, allowed: readonly string[]): boolean => {
    try {
      pi.setActiveTools([...allowed]);
      const active = pi.getActiveTools();
      if (active.length !== allowed.length || active.some((name) => !allowed.includes(name))) {
        failClosed(i18n.t("bridge.protocol"), ctx);
        return false;
      }
      return true;
    } catch {
      failClosed(i18n.t("bridge.protocol"), ctx);
      return false;
    }
  };

  const handleControl = (value: unknown, ctx: ExtensionContext): void => {
    if (!isParentControl(value)) {
      failClosed(i18n.t("bridge.protocol"), ctx);
      return;
    }

    if (value.type === "accepted") {
      if (state !== "connecting" || !manifest || value.version !== BRIDGE_VERSION
        || value.runId !== manifest.run.runId || value.sessionId !== manifest.run.session.sessionId) {
        failClosed(i18n.t("bridge.protocol"), ctx);
        return;
      }
      if (authenticationTimer) clearTimeout(authenticationTimer);
      state = "running";
      try {
        if (!sendFeedback({ type: "ready", snapshot: snapshot(ctx) })) failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
      } catch { failClosed(i18n.t("bridge.protocol"), ctx); }
      if (state === "running") {
        authenticationTimer = setTimeout(() => failClosed(i18n.t("bridge.protocol"), ctx, { report: false }), 30_000);
        authenticationTimer.unref();
      }
      return;
    }

    if (value.type === "start") {
      if (state !== "running" || permitted || abortRequested) { failClosed(i18n.t("bridge.protocol"), ctx); return; }
      permitted = true;
      if (authenticationTimer) clearTimeout(authenticationTimer);
      resolveSessionStart?.();
      resolveSessionStart = undefined;
      return;
    }

    if (value.type === "abort") {
      if (state !== "running") {
        failClosed(i18n.t("bridge.protocol"), ctx);
        return;
      }
      abortRequested = true;
      pendingSteers.length = 0;
      if (authenticationTimer) clearTimeout(authenticationTimer);
      resolveSessionStart?.();
      resolveSessionStart = undefined;
      safeAbort(ctx);
      if (ctx.isIdle()) safeShutdown(ctx);
      return;
    }

    if (state === "running" && !agentStarted && !abortRequested) {
      pendingSteers.push(value);
      return;
    }
    if (state === "settling" || abortRequested || (state === "running" && ctx.isIdle())) {
      writeFrame(nextPacket({ type: "ack", id: value.id, error: i18n.t("bridge.notRunning") }), {
        allowTerminalState: true,
      });
      return;
    }
    if (state !== "running") {
      failClosed(i18n.t("bridge.protocol"), ctx);
      return;
    }

    dispatchSteer(value, ctx);
  };

  const dispatchSteer = (value: Extract<ParentControl, { type: "steer" }>, ctx: ExtensionContext): void => {
    try {
      pi.sendUserMessage(value.message, { deliverAs: "steer" });
      if (!sendFeedback({ type: "ack", id: value.id })) {
        failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
      }
    } catch {
      writeFrame(nextPacket({ type: "ack", id: value.id, error: i18n.t("bridge.notRunning") }), {
        allowTerminalState: true,
      });
    }
  };

  const onData: SocketListener = (chunk: Buffer | string) => {
    const ctx = sessionContext;
    if (!ctx || state === "closed" || state === "failed") return;
    try {
      for (const frame of frames.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        handleControl(frame, ctx);
      }
    } catch {
      failClosed(i18n.t("bridge.protocol"), ctx);
    }
  };

  const onConnectionLost: SocketListener = () => {
    const ctx = sessionContext;
    connected = false;
    resolveSessionStart?.();
    resolveSessionStart = undefined;
    if (!ctx || state === "settling" || state === "failed" || state === "closed") return;
    failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
  };

  const cleanupSocket = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (authenticationTimer) clearTimeout(authenticationTimer);
    resolveSessionStart?.();
    resolveSessionStart = undefined;
    state = "closed";
    connected = false;
    const target = socket;
    socket = undefined;
    if (!target) return;

    if (connectListener) target.off("connect", connectListener);
    target.off("data", onData);
    target.off("error", onConnectionLost);
    // Closing a socket may still emit an asynchronous EPIPE after the SDK teardown.
    target.on("error", () => {});
    target.off("end", onConnectionLost);
    target.off("close", onConnectionLost);
    try {
      if (!target.destroyed) target.end();
    } catch {
      try { target.destroy(); } catch { /* idempotent teardown */ }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (state !== "waiting") {
      failClosed(i18n.t("bridge.protocol"), ctx);
      return;
    }
    sessionContext = ctx;

    try {
      const source = typeof manifestSource === "function" ? manifestSource() : manifestSource;
      manifest = validateManifest(source);
    } catch {
      failClosed(i18n.t("bridge.invalidManifest"), ctx, { report: false });
      return;
    }

    if (!matchesSession(manifest, ctx)) {
      failClosed(i18n.t("bridge.identityMismatch"), ctx, { report: false });
      return;
    }
    if (!matchesModel(manifest, ctx)) {
      failClosed(i18n.t("bridge.modelMismatch"), ctx, { report: false });
      return;
    }
    if (manifest.structuredSchema !== undefined) {
      try {
        const compiled = compileTerminalSchema(manifest.structuredSchema);
        if (pi.getAllTools().some((tool) => tool.name === STRUCTURED_OUTPUT_TOOL_NAME)) throw invalidManifest();
        structuredCapture = createStructuredCapture();
        const tool = createStructuredOutputTool(compiled, structuredCapture);
        pi.registerTool({ ...tool, execute: async (id, params, signal, onUpdate, toolCtx) => {
          if (state !== "running" || !permitted || abortRequested || signal?.aborted) throw new Error(i18n.t("bridge.notRunning"));
          return tool.execute(id, params, signal, onUpdate, toolCtx);
        } });
      } catch {
        failClosed(i18n.t("bridge.invalidManifest"), ctx, { report: false });
        return;
      }
    }
    if (!enforceTools(ctx, allowedTools())) return;
    const validatedManifest = manifest;

    state = "connecting";
    await new Promise<void>((resolveStart) => {
      let startResolved = false;
      const finishStart = () => {
        if (startResolved) return;
        startResolved = true;
        resolveSessionStart = undefined;
        resolveStart();
      };
      resolveSessionStart = finishStart;

      const onConnect = () => {
        if (state !== "connecting") {
          finishStart();
          return;
        }
        connected = true;
        const hello: ChildHello = {
          type: "hello",
          version: BRIDGE_VERSION,
          token: validatedManifest.endpoint.token,
          runId: validatedManifest.run.runId,
          sessionId: validatedManifest.run.session.sessionId,
        };
        authenticationTimer = setTimeout(() => failClosed(i18n.t("bridge.protocol"), ctx, { report: false }), 30_000);
        authenticationTimer.unref();
        if (!writeFrame(hello, { allowTerminalState: true, onFailure: () => failClosed(i18n.t("bridge.disconnected"), ctx, { report: false }) })) {
          failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
        }
        // Do not let Pi accept its initial prompt until the parent authenticates this run.
      };

      try {
        socket = connectFn({
          host: validatedManifest.endpoint.host,
          port: validatedManifest.endpoint.port,
        });
        connectListener = onConnect;
        socket.once("connect", onConnect);
        socket.on("data", onData);
        socket.on("error", onConnectionLost);
        socket.on("end", onConnectionLost);
        socket.on("close", onConnectionLost);
      } catch {
        failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
        finishStart();
      }
    });
  });

  pi.on("input", (_event, ctx) => {
    if (!manifest || state !== "running" || !permitted || abortRequested) return { action: "handled" };
    if (!matchesSession(manifest, ctx)) {
      failClosed(i18n.t("bridge.identityMismatch"), ctx);
      return { action: "handled" };
    }
    if (!matchesModel(manifest, ctx)) {
      failClosed(i18n.t("bridge.modelMismatch"), ctx);
      return { action: "handled" };
    }
    if (!enforceTools(ctx, allowedTools())) return { action: "handled" };
    return { action: "continue" };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!permitted || state !== "running" || abortRequested) { safeAbort(ctx); return; }
    agentStarted = true;
    for (const pending of pendingSteers.splice(0)) dispatchSteer(pending, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!manifest || state !== "running" || !permitted || abortRequested) {
      if (state !== "failed" && state !== "closed") failClosed(i18n.t("bridge.notRunning"), ctx);
      event.systemPromptOptions.selectedTools = [];
      return;
    }
    if (!matchesSession(manifest, ctx)) {
      event.systemPromptOptions.selectedTools = [];
      failClosed(i18n.t("bridge.identityMismatch"), ctx);
      return;
    }
    if (!matchesModel(manifest, ctx)) {
      event.systemPromptOptions.selectedTools = [];
      failClosed(i18n.t("bridge.modelMismatch"), ctx);
      return;
    }
    if (!enforceTools(ctx, allowedTools())) {
      event.systemPromptOptions.selectedTools = [];
      return;
    }

    event.systemPromptOptions.selectedTools = allowedTools();
    event.systemPromptOptions.forceSystemPrompt = manifest.systemPrompt;
    return { systemPrompt: manifest.systemPrompt };
  });

  pi.on("message_update", (event, ctx) => {
    if (state !== "running" || event.assistantMessageEvent.type !== "text_delta") return;
    const feedback: ChildFeedback = {
      type: "text",
      delta: event.assistantMessageEvent.delta,
      fullText: assistantText(event.assistantMessageEvent.partial),
    };
    if (!sendFeedback(feedback)) failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (state !== "running") return;
    if (!sendFeedback({ type: "tool", activity: { type: "start", toolName: event.toolName } })) {
      failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (state !== "running") return;
    if (!sendFeedback({ type: "tool", activity: { type: "end", toolName: event.toolName } })) {
      failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (state !== "running" || event.message.role !== "assistant") return;
    finalAssistant = event.message;
    const usage = lifetimeUsage(event);
    if (usage && !sendFeedback({ type: "usage", usage })) {
      failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
    }
  });

  pi.on("turn_end", (event, ctx) => {
    // Pi may emit an abort bookkeeping turn after the hard boundary, without another request.
    if (state !== "running" || hardLimitReached) return;
    turnCount++;
    if (!sendFeedback({ type: "turn", count: turnCount })) {
      failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
      return;
    }
    sendSnapshot({ type: "turn_end" }, ctx);
    if (event.outcome === "aborted") abortRequested = true;
    if (state !== "running" || abortRequested || policyFailure || manifest?.maxTurns === undefined) return;
    if (turnCount >= manifest.maxTurns + manifest.graceTurns!) {
      hardLimitReached = true;
      abortRequested = true;
      pendingSteers.length = 0;
      safeAbort(ctx);
      return { continue: false };
    }
    if (!softLimitReached && turnCount >= manifest.maxTurns && event.outcome === "completed") {
      softLimitReached = true;
      return policyContinuation(i18n.t("terminalPolicy.wrapUp"));
    }
  });

  pi.on("agent_before_settle", (event) => {
    if (event.outcome === "aborted") abortRequested = true;
    if (state !== "running" || !permitted || abortRequested || policyFailure || !structuredCapture
      || structuredCapture.json !== undefined || structuredRetried || event.outcome !== "completed") return;
    structuredRetried = true;
    return policyContinuation(structuredRetryPrompt(structuredCapture));
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (state !== "running") return;
    sendSnapshot({ type: "compaction_start" }, ctx);
  });

  pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
    if (state === "running" && !sendFeedback({ type: "compaction", info: {
      reason: event.reason, tokensBefore: finiteNumber(event.compactionEntry.tokensBefore),
    } })) failClosed(i18n.t("bridge.disconnected"), ctx, { report: false });
    queueMicrotask(() => sendSnapshot({ type: "compaction_end", aborted: false, result: true }, ctx));
  });

  pi.on("session_compact_failed", (event: SessionCompactFailedEvent, ctx) => {
    queueMicrotask(() => sendSnapshot({ type: "compaction_end", aborted: event.aborted, result: false }, ctx));
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (!manifest || state !== "running" || !permitted || abortRequested || policyFailure) { safeAbort(ctx); return; }
    if (!matchesSession(manifest, ctx)) failClosed(i18n.t("bridge.identityMismatch"), ctx);
    else if (!matchesModel(manifest, ctx)) failClosed(i18n.t("bridge.modelMismatch"), ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (state === "running" && permitted && !abortRequested && manifest
      && matchesSession(manifest, ctx) && matchesModel(manifest, ctx) && allowedTools().includes(event.toolName)) return;
    policyFailure = i18n.t("bridge.toolDenied", { name: event.toolName });
    return { block: true, reason: policyFailure, terminate: true };
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (state !== "running") return;
    state = "settling";

    let finalSnapshot: TerminalSnapshot;
    try {
      finalSnapshot = snapshot(ctx);
    } catch {
      failClosed(i18n.t("bridge.protocol"), ctx);
      return;
    }

    const aborted = abortRequested || finalAssistant?.stopReason === "aborted";
    const feedback: ChildFeedback = {
      type: "settled",
      snapshot: finalSnapshot,
      text: finalAssistant ? assistantText(finalAssistant).trim() : "",
      aborted,
      failure: (hardLimitReached ? i18n.t("terminalPolicy.turnLimit") : policyFailure)
        ?? settledFailure(finalAssistant, aborted).failure
        ?? (structuredCapture ? structuredFailure(structuredCapture) : undefined),
      ...(structuredCapture?.json !== undefined ? { structuredJson: structuredCapture.json } : {}),
      ...(structuredRetried ? { structuredRetried: true } : {}),
      ...(softLimitReached ? { steered: true } : {}),
    };

    const sent = writeFrame(nextPacket(feedback), {
      allowTerminalState: true,
      onFlushed: () => {
        settledFlushed = true;
        maybeShutdownAfterSettled();
      },
      onFailure: () => {
        settledFlushed = true;
        maybeShutdownAfterSettled();
      },
    });
    if (!sent) {
      settledFlushed = true;
      maybeShutdownAfterSettled();
    }
  });

  pi.on("session_shutdown", () => {
    cleanupSocket();
  });
}

export default function terminalChildExtension(pi: ExtensionAPI): void {
  const manifestPath = process.env[TERMINAL_MANIFEST_ENV];
  if (!manifestPath) return;
  registerTerminalChild(pi, () => JSON.parse(readFileSync(manifestPath, "utf8")));
}

function validateManifest(value: unknown): TerminalChildManifest {
  if (!isRecord(value) || value.version !== BRIDGE_VERSION) throw invalidManifest();
  if (!isRecord(value.endpoint)
    || value.endpoint.host !== "127.0.0.1"
    || !Number.isInteger(value.endpoint.port)
    || (value.endpoint.port as number) < 1
    || (value.endpoint.port as number) > 65_535
    || !nonEmptyString(value.endpoint.token)) {
    throw invalidManifest();
  }
  if (!isRecord(value.run)
    || !nonEmptyString(value.run.runId)
    || !isRecord(value.run.session)
    || value.run.session.backend !== "terminal"
    || !nonEmptyString(value.run.session.sessionId)
    || !nonEmptyString(value.run.session.sessionFile)
    || !isAbsolute(value.run.session.sessionFile as string)) {
    throw invalidManifest();
  }
  if (!isRecord(value.model)
    || !nonEmptyString(value.model.provider)
    || !nonEmptyString(value.model.id)
    || (value.modelFingerprint !== undefined && (typeof value.modelFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.modelFingerprint)))
    || typeof value.systemPrompt !== "string"
    || !Array.isArray(value.tools)
    || value.tools.some((tool) => !nonEmptyString(tool) || !BUILTIN_TOOLS.has(tool as string))
    || new Set(value.tools).size !== value.tools.length || !validTurnBudget(value.maxTurns, value.graceTurns)) {
    throw invalidManifest();
  }
  if (value.structuredSchema !== undefined) compileTerminalSchema(value.structuredSchema);
  return value as unknown as TerminalChildManifest;
}

function invalidManifest(): Error {
  return new Error(i18n.t("bridge.invalidManifest"));
}

function matchesSession(manifest: TerminalChildManifest, ctx: ExtensionContext): boolean {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    return sessionId === manifest.run.session.sessionId
      && typeof sessionFile === "string"
      && resolve(sessionFile) === resolve(manifest.run.session.sessionFile);
  } catch {
    return false;
  }
}

function matchesModel(manifest: TerminalChildManifest, ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return model?.provider === manifest.model.provider && model.id === manifest.model.id
    && (!manifest.modelFingerprint || modelFingerprint(model) === manifest.modelFingerprint);
}

function safeModel(ctx: ExtensionContext): TerminalSnapshot["model"] | undefined {
  const model = ctx.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
  return {
    provider: model.provider,
    id: model.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
  };
}

function safeContextPercent(ctx: ExtensionContext): number | null {
  try {
    const percent = ctx.getContextUsage()?.percent;
    return typeof percent === "number" && Number.isFinite(percent) ? percent : null;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lifetimeUsage(event: MessageEndEvent): LifetimeUsage | undefined {
  if (event.message.role !== "assistant") return undefined;
  const usage: Usage | undefined = event.message.usage;
  if (!usage) return undefined;
  return {
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    cacheWrite: finiteNumber(usage.cacheWrite),
    cacheRead: finiteNumber(usage.cacheRead),
    cost: finiteNumber(usage.cost?.total),
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function settledFailure(
  finalAssistant: AssistantMessage | undefined,
  aborted: boolean,
): { failure?: string } {
  if (aborted) return { failure: i18n.t("bridge.aborted") };
  if (!finalAssistant) return { failure: i18n.t("bridge.failed") };
  if (finalAssistant.stopReason === "error") {
    return { failure: finalAssistant.errorMessage?.trim() || i18n.t("bridge.failed") };
  }
  if (finalAssistant.stopReason === "length" && !assistantText(finalAssistant).trim()) {
    return { failure: i18n.t("bridge.failed") };
  }
  return {};
}

function isParentControl(value: unknown): value is ParentControl {
  if (!isRecord(value)) return false;
  if (value.type === "abort" || value.type === "start") return true;
  if (value.type === "accepted") return value.version === BRIDGE_VERSION && nonEmptyString(value.runId) && nonEmptyString(value.sessionId);
  return value.type === "steer" && nonEmptyString(value.id) && nonEmptyString(value.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
