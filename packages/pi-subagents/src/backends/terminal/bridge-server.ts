import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { i18n } from "../../i18n.js";
import type { RunReference } from "../session-reference.js";
import {
  BRIDGE_VERSION, BridgeFrames, encodeBridgeFrame,
  type ChildFeedback, type ChildPacket, type TerminalChildManifest, type TerminalSnapshot,
} from "./bridge-protocol.js";

type Settled = Extract<ChildFeedback, { type: "settled" }>;
export interface TerminalBridge {
  readonly endpoint: TerminalChildManifest["endpoint"];
  readonly ready: Promise<TerminalSnapshot>;
  readonly settled: Promise<Settled>;
  start(): void;
  steer(message: string): Promise<void>;
  abort(): void;
  close(): Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Lifecycle consumers may not start awaiting both phases at the same time.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const model = (value: unknown) => value === undefined || (object(value) && typeof value.provider === "string" && typeof value.id === "string" && (value.name === undefined || typeof value.name === "string"));
function snapshot(value: unknown): value is TerminalSnapshot {
  return object(value) && Array.isArray(value.messages)
    && value.messages.every((message: unknown) => object(message) && typeof message.role === "string"
      && (message.content === undefined || typeof message.content === "string" || (Array.isArray(message.content)
        && message.content.every((block: unknown) => object(block) && typeof block.type === "string"))))
    && model(value.model) && (value.thinkingLevel === undefined || ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel))
    && object(value.stats) && object(value.stats.tokens)
    && [value.stats.tokens.input, value.stats.tokens.output, value.stats.tokens.cacheWrite].every(number)
    && (value.stats.contextUsage === undefined || (object(value.stats.contextUsage)
      && (value.stats.contextUsage.percent === null || number(value.stats.contextUsage.percent))));
}
function feedback(value: unknown): value is ChildPacket {
  if (!object(value) || !Number.isSafeInteger(value.seq)) return false;
  switch (value.type) {
    case "ready": return snapshot(value.snapshot);
    case "snapshot": return snapshot(value.snapshot) && object(value.event)
      && (["changed", "turn_end", "compaction_start"].includes(value.event.type)
        || (value.event.type === "compaction_end" && typeof value.event.aborted === "boolean"
          && (value.event.result === undefined || typeof value.event.result === "boolean")));
    case "text": return typeof value.delta === "string" && typeof value.fullText === "string";
    case "tool": return object(value.activity) && ["start", "end"].includes(value.activity.type) && typeof value.activity.toolName === "string";
    case "usage": return object(value.usage) && [value.usage.input, value.usage.output, value.usage.cacheWrite, value.usage.cost].every(number)
      && (value.usage.cacheRead === undefined || number(value.usage.cacheRead));
    case "turn": return Number.isSafeInteger(value.count) && value.count > 0;
    case "compaction": return object(value.info) && ["manual", "threshold", "overflow"].includes(value.info.reason) && number(value.info.tokensBefore);
    case "idle":
    case "settled": return snapshot(value.snapshot) && typeof value.text === "string" && typeof value.aborted === "boolean"
      && (value.failure === undefined || typeof value.failure === "string")
      && (value.structuredJson === undefined || typeof value.structuredJson === "string")
      && (value.structuredRetried === undefined || typeof value.structuredRetried === "boolean")
      && (value.steered === undefined || typeof value.steered === "boolean")
      && (value.witness === undefined || (object(value.witness)
        && (value.witness.leafId === null || typeof value.witness.leafId === "string")
        && Number.isSafeInteger(value.witness.entries) && value.witness.entries >= 0
        && typeof value.witness.digest === "string" && /^[a-f0-9]{64}$/.test(value.witness.digest)));
    case "ack": return typeof value.id === "string" && (value.error === undefined || typeof value.error === "string");
    case "failure": return typeof value.error === "string";
    default: return false;
  }
}

/** One transient loopback server per invocation. No discovery, polling, or shared run registry. */
export async function openTerminalBridge(
  run: RunReference<"terminal">,
  onFeedback: (feedback: ChildFeedback) => void,
  timeoutMs = 30_000,
): Promise<TerminalBridge> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(i18n.t("terminalBackend.invalidConfig"));
  const token = randomBytes(32).toString("hex");
  const ready = deferred<TerminalSnapshot>();
  const settled = deferred<Settled>();
  const peers = new Set<Socket>();
  const acknowledgements = new Map<string, { resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let active: Socket | undefined;
  let closed = false;
  let finished = false;
  let receivedReady = false;
  let started = false;
  let sequence = 0;
  let queue = Promise.resolve();
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = deferred<void>();
  const fail = (error: unknown) => {
    if (closed) return;
    closed = true;
    if (startupTimer) clearTimeout(startupTimer);
    ready.reject(error);
    settled.reject(error);
    for (const pending of acknowledgements.values()) { clearTimeout(pending.timer); pending.reject(error); }
    acknowledgements.clear();
    for (const peer of peers) peer.destroy();
    if (server.listening) server.close(); else stopped.resolve();
  };
  const server = createServer((socket) => {
    if (closed || active || peers.size >= 8) { socket.destroy(); return; }
    peers.add(socket);
    socket.setTimeout(Math.min(timeoutMs, 5_000), () => socket.destroy());
    const frames = new BridgeFrames();
    let authenticated = false;
    let handshakeBytes = 0;
    socket.on("error", () => { if (active === socket) fail(new Error(i18n.t("bridge.disconnected"))); });
    socket.on("close", () => {
      peers.delete(socket);
      if (active === socket) void queue.then(() => {
        if (!finished && !closed) fail(new Error(i18n.t("bridge.disconnected")));
      });
    });
    socket.on("data", (chunk: Buffer) => {
      if (!authenticated && (handshakeBytes += chunk.length) > 4_096) { socket.destroy(); return; }
      try {
        for (const value of frames.push(chunk)) {
          if (!authenticated) {
            if (active || !object(value) || value.type !== "hello" || value.version !== BRIDGE_VERSION
              || value.runId !== run.runId || value.sessionId !== run.session.sessionId
              || typeof value.token !== "string" || Buffer.byteLength(value.token) !== Buffer.byteLength(token)
              || !timingSafeEqual(Buffer.from(value.token), Buffer.from(token))) {
              socket.destroy(); return;
            }
            authenticated = true;
            active = socket;
            socket.setTimeout(0);
            socket.write(encodeBridgeFrame({ type: "accepted", version: BRIDGE_VERSION, runId: run.runId, sessionId: run.session.sessionId }));
            continue;
          }
          if (!feedback(value) || value.seq !== ++sequence) throw new Error("protocol");
          // Separate delivery microtasks preserve the output writer's post-compaction re-anchor.
          queue = queue.then(() => {
            if (closed) return;
            if (value.type === "failure") { fail(new Error(value.error)); return; }
            if (value.type === "ack") {
              const pending = acknowledgements.get(value.id);
              if (!pending) return;
              acknowledgements.delete(value.id);
              clearTimeout(pending.timer);
              if (value.error) pending.reject(new Error(value.error)); else pending.resolve();
              return;
            }
            if (finished || (value.type === "ready" && receivedReady) || (!receivedReady && value.type !== "ready")) {
              fail(new Error(i18n.t("bridge.protocol"))); return;
            }
            if (value.type === "ready") {
              receivedReady = true;
              if (startupTimer) clearTimeout(startupTimer);
            }
            onFeedback(value);
            if (value.type === "ready") ready.resolve(value.snapshot);
            if (value.type === "settled") {
              finished = true;
              settled.resolve(value);
              for (const pending of acknowledgements.values()) {
                clearTimeout(pending.timer); pending.reject(new Error(i18n.t("bridge.notRunning")));
              }
              acknowledgements.clear();
            }
          }).catch(() => fail(new Error(i18n.t("bridge.protocol"))));
        }
      } catch {
        if (authenticated) fail(new Error(i18n.t("bridge.protocol"))); else socket.destroy();
      }
    });
  });
  server.on("close", () => stopped.resolve());
  server.on("error", (error) => fail(error));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(i18n.t("bridge.protocol"));
  startupTimer = setTimeout(() => fail(new Error(i18n.t("bridge.timeout"))), timeoutMs);
  return {
    endpoint: { host: "127.0.0.1", port: address.port, token },
    ready: ready.promise,
    settled: settled.promise,
    start() {
      if (closed || finished || !receivedReady || !active || active.destroyed || started) throw new Error(i18n.t("bridge.notRunning"));
      started = true;
      active.write(encodeBridgeFrame({ type: "start" }));
    },
    steer(message) {
      if (typeof message !== "string" || !message.trim()) return Promise.reject(new Error(i18n.t("bridge.invalidControl")));
      if (closed || finished || !receivedReady || !active || active.destroyed) return Promise.reject(new Error(i18n.t("bridge.notRunning")));
      const id = randomUUID();
      const pending = deferred<void>();
      const timer = setTimeout(() => {
        acknowledgements.delete(id); pending.reject(new Error(i18n.t("bridge.timeout")));
      }, timeoutMs);
      acknowledgements.set(id, { resolve: () => pending.resolve(), reject: pending.reject, timer });
      try { active.write(encodeBridgeFrame({ type: "steer", id, message })); }
      catch { clearTimeout(timer); acknowledgements.delete(id); pending.reject(new Error(i18n.t("bridge.protocol"))); }
      return pending.promise;
    },
    abort() {
      if (active && !active.destroyed && !finished && !closed) active.write(encodeBridgeFrame({ type: "abort" }));
    },
    async close() {
      fail(new Error(i18n.t("bridge.disconnected")));
      await stopped.promise;
    },
  };
}
