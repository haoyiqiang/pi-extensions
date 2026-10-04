import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { openTerminalBridge, type TerminalBridge } from "../src/backends/terminal/bridge-server.js";
import { BridgeFrames, encodeBridgeFrame, MAX_BRIDGE_FRAME_BYTES, type ChildFeedback, type TerminalSnapshot } from "../src/backends/terminal/bridge-protocol.js";
import { i18n } from "../src/i18n.js";

const reference = { runId: "run-a", session: { backend: "terminal" as const, sessionId: "session-a", sessionFile: "/sessions/a.jsonl" } };
const snapshot: TerminalSnapshot = { messages: [], stats: { tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: null } } };
const bridges: TerminalBridge[] = [];
const sockets: Socket[] = [];
async function server(onFeedback: (event: ChildFeedback) => void = () => {}, timeout?: number) {
  const bridge = await openTerminalBridge(reference, onFeedback, timeout);
  bridges.push(bridge);
  return bridge;
}
async function connect(bridge: TerminalBridge, token = bridge.endpoint.token) {
  const socket = createConnection({ host: bridge.endpoint.host, port: bridge.endpoint.port });
  sockets.push(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(encodeBridgeFrame({ type: "hello", version: 1, token, runId: reference.runId, sessionId: reference.session.sessionId }));
  if (token === bridge.endpoint.token) {
    const [bytes] = await once(socket, "data");
    expect(new BridgeFrames().push(bytes as Buffer)[0]).toMatchObject({ type: "accepted", runId: reference.runId });
  }
  return socket;
}
function packet(socket: Socket, seq: number, value: ChildFeedback) { socket.write(encodeBridgeFrame({ ...value, seq })); }

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("terminal feedback framing", () => {
  it("handles split UTF-8 frames and multiple packets per chunk", () => {
    const frames = new BridgeFrames();
    const bytes = Buffer.from(encodeBridgeFrame({ text: "你好🙂" }) + encodeBridgeFrame({ ok: true }));
    const split = bytes.indexOf(Buffer.from("🙂")) + 2;
    expect(frames.push(bytes.subarray(0, split))).toEqual([]);
    expect(frames.push(bytes.subarray(split))).toEqual([{ text: "你好🙂" }, { ok: true }]);
  });
  it("bounds unfinished frames and does not echo secret-bearing invalid JSON", () => {
    expect(() => new BridgeFrames().push(Buffer.alloc(MAX_BRIDGE_FRAME_BYTES + 1, 32)))
      .toThrow(i18n.t("bridge.frameTooLarge"));
    expect(() => new BridgeFrames().push(Buffer.from('{"token":"do-not-echo",oops\n')))
      .toThrow(i18n.t("bridge.protocol"));
  });
});

describe("explicit ephemeral loopback bridge (no external network)", () => {
  it("authenticates run/session identity before allowing observations", async () => {
    const observed: ChildFeedback[] = [];
    const bridge = await server((event) => observed.push(event));
    const wrong = await connect(bridge, "x".repeat(64));
    await once(wrong, "close");
    expect(observed).toEqual([]);
    const child = await connect(bridge);
    packet(child, 1, { type: "ready", snapshot });
    await expect(bridge.ready).resolves.toEqual(snapshot);
    packet(child, 2, { type: "settled", snapshot, text: "done", aborted: false });
    await expect(bridge.settled).resolves.toMatchObject({ text: "done" });
  });

  it("rejects wrong session identity without consuming the valid connection slot", async () => {
    const bridge = await server();
    const child = createConnection({ host: "127.0.0.1", port: bridge.endpoint.port });
    sockets.push(child);
    await once(child, "connect");
    child.write(encodeBridgeFrame({ type: "hello", version: 1, token: bridge.endpoint.token, runId: "old-run", sessionId: "session-a" }));
    await once(child, "close");
    const current = await connect(bridge);
    packet(current, 1, { type: "ready", snapshot });
    await bridge.ready;
  });

  it("delivers observation packets in distinct microtasks for compaction re-anchoring", async () => {
    const order: string[] = [];
    const bridge = await server((event) => {
      if (event.type === "snapshot") {
        order.push(event.event.type);
        if (event.event.type === "compaction_end") queueMicrotask(() => order.push("anchor"));
      }
    });
    const child = await connect(bridge);
    child.write([
      { type: "ready", snapshot },
      { type: "snapshot", snapshot, event: { type: "compaction_start" } },
      { type: "snapshot", snapshot, event: { type: "compaction_end", aborted: false, result: true } },
      { type: "snapshot", snapshot, event: { type: "turn_end" } },
      { type: "settled", snapshot, text: "done", aborted: false },
    ].map((event, index) => encodeBridgeFrame({ ...event, seq: index + 1 })).join(""));
    await bridge.settled;
    expect(order).toEqual(["compaction_start", "compaction_end", "anchor", "turn_end"]);
  });

  it("keeps steering pending until child acknowledgement and rejects late steering", async () => {
    const bridge = await server();
    const child = await connect(bridge);
    packet(child, 1, { type: "ready", snapshot });
    await bridge.ready;
    await expect(bridge.steer("   ")).rejects.toThrow(i18n.t("bridge.invalidControl"));
    const receiving = once(child, "data");
    const sending = bridge.steer("correct this");
    let delivered = false;
    void sending.then(() => { delivered = true; });
    const [bytes] = await receiving;
    const [command] = new BridgeFrames().push(bytes as Buffer) as Array<{ type: string; id: string; message: string }>;
    expect(command).toMatchObject({ type: "steer", message: "correct this" });
    expect(delivered).toBe(false);
    packet(child, 2, { type: "ack", id: command.id });
    await sending;
    expect(delivered).toBe(true);
    packet(child, 3, { type: "settled", snapshot, text: "done", aborted: false });
    await bridge.settled;
    await expect(bridge.steer("too late")).rejects.toThrow(i18n.t("bridge.notRunning"));
  });

  it("rejects duplicate/out-of-order frames instead of double-counting usage", async () => {
    const bridge = await server();
    const child = await connect(bridge);
    packet(child, 1, { type: "ready", snapshot });
    await bridge.ready;
    packet(child, 1, { type: "turn", count: 1 });
    await expect(bridge.settled).rejects.toThrow(i18n.t("bridge.protocol"));
  });

  it("fails startup on timeout and pending controls on disconnect", async () => {
    const idle = await server(undefined, 30);
    await expect(idle.ready).rejects.toThrow(i18n.t("bridge.timeout"));
    const bridge = await server();
    const child = await connect(bridge);
    packet(child, 1, { type: "ready", snapshot });
    await bridge.ready;
    const sending = bridge.steer("pending");
    child.destroy();
    await expect(sending).rejects.toThrow(i18n.t("bridge.disconnected"));
    await expect(bridge.settled).rejects.toThrow(i18n.t("bridge.disconnected"));
    await bridge.close();
    await bridge.close();
  });
});
