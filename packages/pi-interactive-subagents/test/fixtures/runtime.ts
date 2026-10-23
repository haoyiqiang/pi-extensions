// Deterministic Pi process boundary: real child bridge/storage, controlled queues, no model calls.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import subagentDone from "../../pi-extension/subagents/subagent-done.ts";
import { mock } from "node:test";
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
const branch: any[] = existsSync(sessionFile)
  ? readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type !== "session") : [];
const ctx = {
  sessionManager: { getBranch: () => branch, getSessionId: () => "fixture-child", getLeafId: () => branch.at(-1)?.id ?? null },
  hasUI: true,
  ui: { setWidget(_name: string, factory: any) { widgets.push(factory({}, plainTheme).render(100).join("\n")); } },
  shutdown() { shutdown = true; },
};
subagentDone(runtime.api);
mkdirSync(dirname(sessionFile), { recursive: true });
if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "fixture-child", cwd: process.cwd() }) + "\n");
await runtime.emit("session_start", {}, ctx);
async function consume(message: any) {
  // Real Pi notifies extensions before appending message_end, then offers the
  // finalized custom message to context before its provider request.
  await runtime.emit("message_end", { message: { role: "custom", ...message } }, ctx);
  const entry = { type: "custom_message", id: `fixture-input-${branch.length}`, parentId: branch.at(-1)?.id ?? null,
    customType: message.customType, content: message.content, details: message.details, display: true };
  branch.push(entry);
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  await runtime.emit("context", { messages: [{ role: "custom", ...message }] }, ctx);
  writeFileSync(join(root, "consumed.tmp"), JSON.stringify(branch.filter((e) => e.type === "custom_message").map((e) => ({ content: e.content, details: e.details }))));
  renameSync(join(root, "consumed.tmp"), join(root, "consumed.json"));
  return message.content as string;
}
for (;;) {
  if (task === undefined) {
    await waitFor(() => pending.length ? true : undefined, "durable next input", 120_000);
    task = await consume(pending.shift());
  } else {
    await runtime.emit("input", { text: task, source: "interactive" }, ctx);
    await runtime.emit("before_agent_start", { prompt: task }, ctx);
  }
  await runtime.emit("agent_start", {}, ctx);
  if (task.includes("LONG_PROVIDER")) await runtime.emit("before_provider_request", {}, ctx);
  if (task.includes("LONG_TOOL")) await runtime.emit("tool_execution_start", { toolCallId: "long-tool", toolName: "bash" }, ctx);
  writeFileSync(join(root, "received.tmp"), JSON.stringify({ task, widgets, tools: runtime.registeredTools.map((tool) => tool.name), args, autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_SUBAGENT_") || key === "PI_CODING_AGENT_DIR" || key === "PI_TERMINAL_RENAME_CONTEXT")) }));
  renameSync(join(root, "received.tmp"), join(root, "received.json"));
  await waitFor(() => existsSync(join(root, "finish")) ? true : undefined, "permission to complete delegated task", 120_000);
  // Steering is consumed before followUp, independently of terminal editor state.
  for (let index = pending.findIndex((m) => m.options.deliverAs !== "followUp"); index >= 0; index = pending.findIndex((m) => m.options.deliverAs !== "followUp")) {
    const steering = await consume(pending.splice(index, 1)[0]);
    if (steering.includes("Return the exact phrase:")) task = steering;
  }
  if (task.includes("EXIT_WITHOUT_RESULT")) { process.exitCode = 2; break; }
  const answer = task.match(/Return the exact phrase: ([^\n]+)/)?.[1];
  if (!answer) throw new Error(`Fixture cannot process task: ${task}`);
  if (task.includes("FINAL_ERROR")) {
    const partial = { type: "message", id: `fixture-partial-${branch.length}`, parentId: branch.at(-1)?.id ?? null,
      message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: answer }] } };
    branch.push(partial);
    appendFileSync(sessionFile, JSON.stringify(partial) + "\n");
  }
  const message = {
    role: "assistant", content: task.includes("FINAL_ERROR") ? [] : [{ type: "text", text: task.includes("LONG_OUTPUT")
      ? "complete output start\n" + "retained evidence line\n".repeat(2000) + "complete output end" : answer }],
    stopReason: task.includes("FINAL_ERROR") ? "error" : task.includes("TRUNCATED") ? "length" : task.includes("ABORTED") ? "aborted" : "stop",
    ...(task.includes("FINAL_ERROR") ? { errorMessage: "provider retries exhausted: 529 overloaded" } : {}),
  };
  const entry = { type: "message", id: `fixture-answer-${branch.length}`, parentId: branch.at(-1)?.id ?? null, message };
  if (!task.includes("NO_OUTPUT")) { branch.push(entry); appendFileSync(sessionFile, JSON.stringify(entry) + "\n"); }
  await runtime.emit("agent_end", { messages: [message] }, ctx);
  if (shutdown) throw new Error("Child shut down before final settlement");
  if (pending.length) { task = undefined; continue; }
  await runtime.emit("agent_before_settle", { outcome: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed" }, ctx);
  if (pending.length) { task = undefined; continue; }
  await runtime.emit("agent_settled", {}, ctx);
  if (task.includes("LONG_OUTPUT")) {
    writeFileSync(join(root, "diagnostics-unavailable"), "gone");
    writeFileSync(join(root, "surface"), "gone");
    shutdown = true;
  }
  if (shutdown) break;
  writeFileSync(join(root, "parked"), "waiting");
  await waitFor(() => pending.length || existsSync(join(root, "next-task")) || existsSync(join(root, "close-resident")) ? true : undefined, "resident/manual next input or closure", 120_000);
  if (existsSync(join(root, "close-resident"))) break;
  if (pending.length) task = undefined;
  else { task = readFileSync(join(root, "next-task"), "utf8"); rmSync(join(root, "next-task")); }
}
await runtime.emit("session_shutdown", { reason: "quit" }, ctx);
