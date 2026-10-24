// Deterministic Pi process boundary: actual SessionManager and child bridge, controlled queues/provider IO.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import subagentDone from "../../pi-extension/subagents/subagent-done.ts";
import { mock } from "node:test";
// Same exported SDK class, without initializing the unrelated CLI/UI graph in
// each terminal stand-in. Only public SessionManager APIs are used.
const { SessionManager }: typeof import("@earendil-works/pi-coding-agent") = await import(
  new URL("./core/session-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
import { createMockExtensionApi, plainTheme, waitFor } from "../harness.ts";

const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const root = process.env.SUBAGENT_TEST_TERMINAL!;
writeFileSync(join(root, "control-pid"), String(process.pid));
if (process.env.SUBAGENT_TEST_CLOCK) {
  const realInterval = setInterval;
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Number(process.env.SUBAGENT_TEST_CLOCK) });
  realInterval(() => {
    if (!existsSync(join(root, "clock"))) return;
    const at = Number(readFileSync(join(root, "clock"), "utf8"));
    if (at > Date.now()) mock.timers.tick(at - Date.now());
    writeFileSync(join(root, "clock-applied"), String(Date.now()));
  }, 10).unref();
}
const taskArg = args.at(-1)!;
let task: string | undefined = process.env.PI_SUBAGENT_INBOX_ONLY === "1" ? undefined : taskArg.startsWith("@") ? readFileSync(taskArg.slice(1), "utf8") : taskArg;
const runtime = createMockExtensionApi();
const pending: any[] = [];
const received: any[] = [];
runtime.api.sendMessage = (message: any, options: any) => {
  pending.push({ ...message, options });
  received.push({ ...message, options });
  writeFileSync(join(root, "inbox-received.tmp"), JSON.stringify(received));
  renameSync(join(root, "inbox-received.tmp"), join(root, "inbox-received.json"));
};
const widgets: string[] = [];
let shutdown = false;
let aborted = false;
mkdirSync(dirname(sessionFile), { recursive: true });
if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "fixture-child", cwd: process.cwd() }) + "\n");
let session = SessionManager.open(sessionFile); // This fenced process owns the writer.
runtime.api.appendEntry = (type: string, data: unknown) => { session.appendCustomEntry(type, data); };
let assistantCount = session.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
let abandonedLeaf: string | undefined;
function abandonOldBranch() {
  const activeLeaf = session.getLeafId();
  abandonedLeaf = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "An old abandoned answer must never complete this task." }], stopReason: "stop" } as any);
  if (activeLeaf) session.branch(activeLeaf); else session.resetLeaf();
}
if (task?.includes("ABANDONED_BRANCH")) abandonOldBranch();
const ctx = {
  get model() { return { provider: "fixture", id: task?.includes("UNKNOWN_CAPACITY") ? "claude-fixture-unknown" : "parent-model", ...(task?.includes("UNKNOWN_CAPACITY") ? {} : { contextWindow: 64_000 }) }; },
  sessionManager: {
    getBranch: () => session.getBranch(), getEntries: () => session.getEntries(),
    buildSessionProjection: () => session.buildSessionProjection(),
    getSessionId: () => session.getSessionId(), getLeafId: () => session.getLeafId(),
    getSessionFile: () => session.getSessionFile(), getSessionDir: () => session.getSessionDir(),
  },
  // This fixture's raw user inputs happen only at startup/resident idle; its
  // mid-run inputs use Pi's managed custom-message path instead.
  isIdle: () => true,
  hasUI: true,
  ui: { setWidget(_name: string, factory: any) { widgets.push(factory({}, plainTheme).render(100).join("\n")); } },
  abort() { writeFileSync(join(root, "abort-requested"), "cooperative request, not exit"); if (!existsSync(join(root, "ignore-abort"))) aborted = true; },
  shutdown() { shutdown = true; },
};
subagentDone(runtime.api);
await runtime.emit("session_start", {}, ctx);
async function consume(message: any) {
  abandonedLeaf = undefined;
  if (message.content.includes("ABANDONED_BRANCH")) abandonOldBranch();
  // Real Pi notifies extensions before appending message_end, then offers the
  // finalized custom message to context before its provider request.
  await runtime.emit("message_end", { message: { role: "custom", ...message } }, ctx);
  session.appendCustomMessageEntry(message.customType, message.content, true, message.details);
  await runtime.emit("context", { messages: [{ role: "custom", ...message }] }, ctx);
  writeFileSync(join(root, "consumed.tmp"), JSON.stringify(session.getEntries().filter((entry) => entry.type === "custom_message").map((entry) => ({ content: entry.content, details: entry.details }))));
  renameSync(join(root, "consumed.tmp"), join(root, "consumed.json"));
  return message.content as string;
}
for (;;) {
  if (task === undefined) {
    await waitFor(() => shutdown || pending.length ? true : undefined, "durable next input", 120_000);
    if (shutdown) break;
    task = await consume(pending.shift());
  } else {
    await runtime.emit("input", { text: task, source: "interactive" }, ctx);
    await runtime.emit("before_agent_start", { prompt: task }, ctx);
    session.appendMessage({ role: "user", content: task, timestamp: Date.now() });
  }
  await runtime.emit("agent_start", {}, ctx);
  if (task.includes("LONG_PROVIDER")) await runtime.emit("before_provider_request", {}, ctx);
  if (task.includes("LONG_TOOL")) await runtime.emit("tool_execution_start", { toolCallId: "long-tool", toolName: "bash" }, ctx);
  writeFileSync(join(root, "received.tmp"), JSON.stringify({ context: session.buildSessionContext().messages, header: session.getHeader(), task, widgets, tools: runtime.registeredTools.map((tool) => tool.name), args, autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_SUBAGENT_") || key === "PI_CODING_AGENT_DIR" || key === "PI_TERMINAL_RENAME_CONTEXT")) }));
  renameSync(join(root, "received.tmp"), join(root, "received.json"));
  await waitFor(() => aborted || existsSync(join(root, "finish")) ? true : undefined, "permission to complete delegated task", 120_000);
  if (aborted) {
    await runtime.emit("agent_before_settle", { outcome: "aborted" }, ctx);
    await runtime.emit("agent_settled", {}, ctx);
    await waitFor(() => shutdown ? true : undefined, "cooperative shutdown", 120_000);
    break;
  }
  // Actual Pi emits the tool's terminal event before settlement. Aborted tools
  // above intentionally keep their interruption evidence instead.
  if (task.includes("LONG_TOOL")) await runtime.emit("tool_execution_end", { toolCallId: "long-tool", toolName: "bash", isError: false }, ctx);
  for (let index = pending.findIndex((m) => m.options.deliverAs !== "followUp"); index >= 0; index = pending.findIndex((m) => m.options.deliverAs !== "followUp")) {
    const steering = await consume(pending.splice(index, 1)[0]);
    if (steering.includes("Return the exact phrase:")) task = steering;
  }
  if (task.includes("ASK_AFTER_INPUT")) {
    for (const question of task.includes("ASK_TWICE") ? ["Confirm the next step?", "Which region?"] : ["Confirm the next step?"]) {
      await runtime.tool("ask_question").execute("fixture-question", { question }, undefined, undefined, ctx);
    }
    await runtime.emit("context", { messages: session.getBranch().filter((entry) => entry.type === "custom_message").map((entry) => ({ role: "custom", ...entry })) }, ctx);
  }
  if (task.includes("EXIT_WITHOUT_RESULT")) {
    appendFileSync(sessionFile, '{"type":"message","id":"unfinished');
    process.exitCode = 2;
    break;
  }
  const history = task.includes("new continuation") ? session.buildSessionContext().messages
    .filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : "").join("\n") : "";
  const answer = task.match(/Return the exact phrase: ([^\n]+)/)?.[1] ?? history.match(/Return the exact phrase: ([^\n]+)/)?.[1];
  if (!answer) throw new Error(`Fixture cannot process task: ${task}`);
  if (task.includes("FINAL_ERROR") || task.includes("OMITTED_FINAL")) {
    const partial = { type: "message", id: `fixture-partial-${assistantCount++}`, parentId: session.getLeafId(),
      message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: answer }] } };
    appendFileSync(sessionFile, JSON.stringify(partial) + "\n");
    session = SessionManager.open(sessionFile);
  }
  const message = {
    role: "assistant", provider: ctx.model.provider, model: ctx.model.id,
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.01 } },
    content: task.includes("FINAL_ERROR") ? [] : [{ type: "text", text: task.includes("LONG_OUTPUT")
      ? "complete output start\n" + "retained evidence line\n".repeat(2000) + "complete output end" : answer }],
    stopReason: task.includes("FINAL_ERROR") ? "error" : task.includes("TRUNCATED") ? "length" : task.includes("ABORTED") ? "aborted" : "stop",
    ...(task.includes("FINAL_ERROR") ? { errorMessage: "provider retries exhausted: 529 overloaded" } : {}),
  };
  const entry = { type: "message", id: `fixture-answer-${assistantCount++}`, parentId: session.getLeafId(), message };
  if (!task.includes("NO_OUTPUT")) appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  session = SessionManager.open(sessionFile);
  if (abandonedLeaf) session.branch(abandonedLeaf);
  if (task.includes("USAGE_EVENTS")) {
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 };
    session.appendUsage("cache_warm", ctx.model.provider, ctx.model.id, { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost });
    session.appendCompaction("Settled work retained.", entry.id, 18, undefined, true,
      { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { ...cost, total: 0.03 } });
  }
  if (task.includes("CONTEXT_EDIT")) session.appendContextEdit(entry.id, { content: "The effective revised answer." });
  if (task.includes("OMITTED_FINAL")) session.appendContextEdit(entry.id, null);
  if (task.includes("FOLLOWUP_WITHOUT_ANSWER")) session.appendCustomMessageEntry("fixture_followup", "New instruction without a response.", false);
  if (task.includes("PARTIAL_TAIL")) appendFileSync(sessionFile, '{"type":"message","id":"unfinished');
  await runtime.emit("agent_end", { messages: [message] }, ctx);
  if (shutdown) throw new Error("Child shut down before final settlement");
  if (pending.length) { task = undefined; continue; }
  await runtime.emit("agent_before_settle", { outcome: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed" }, ctx);
  if (pending.length) { task = undefined; continue; }
  await runtime.emit("agent_settled", {}, ctx);
  if (shutdown && existsSync(join(root, "hold-exit"))) {
    writeFileSync(join(root, "waiting-exit"), "outcome retained, process still live");
    await waitFor(() => existsSync(join(root, "release-exit")) ? true : undefined, "permission for writer exit", 120_000);
  }
  if (task.includes("LONG_OUTPUT")) {
    writeFileSync(join(root, "diagnostics-unavailable"), "gone");
    writeFileSync(join(root, "surface"), "gone");
    shutdown = true;
  }
  if (shutdown) break;
  writeFileSync(join(root, "parked"), "waiting");
  await waitFor(() => shutdown || pending.length || existsSync(join(root, "next-task")) || existsSync(join(root, "close-resident")) ? true : undefined, "resident/manual next input or closure", 120_000);
  if (shutdown || existsSync(join(root, "close-resident"))) break;
  if (pending.length) task = undefined;
  else { task = readFileSync(join(root, "next-task"), "utf8"); rmSync(join(root, "next-task")); }
}
await runtime.emit("session_shutdown", { reason: "quit" }, ctx);
