// Deterministic Pi runtime boundary: real child bridge and storage, no model calls.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import subagentDone from "../../pi-extension/subagents/subagent-done.ts";
import { createMockExtensionApi, plainTheme, waitFor } from "../harness.ts";

const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const root = process.env.SUBAGENT_TEST_TERMINAL!;
const taskArg = args.at(-1)!;
let task = taskArg.startsWith("@") ? readFileSync(taskArg.slice(1), "utf8") : taskArg;
const runtime = createMockExtensionApi();
const widgets: string[] = [];
let shutdown = false;
const branch: any[] = existsSync(sessionFile)
  ? readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type !== "session")
  : [];
const ctx = {
  sessionManager: {
    getBranch: () => branch,
    getSessionId: () => "fixture-child",
    getLeafId: () => branch.at(-1)?.id ?? null,
  },
  hasUI: true,
  ui: {
    setWidget(_name: string, factory: any) {
      widgets.push(factory({}, plainTheme).render(100).join("\n"));
    },
  },
  shutdown() { shutdown = true; },
};
subagentDone(runtime.api);
mkdirSync(dirname(sessionFile), { recursive: true });
if (!existsSync(sessionFile)) {
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "fixture-child", cwd: process.cwd() }) + "\n");
}
await runtime.emit("session_start", {}, ctx);
for (;;) {
  await runtime.emit("input", { text: task, source: "interactive" }, ctx);
  await runtime.emit("before_agent_start", { prompt: task }, ctx);
  await runtime.emit("agent_start", {}, ctx);
  writeFileSync(join(root, "received.tmp"), JSON.stringify({ task, widgets, tools: runtime.registeredTools.map((tool) => tool.name), args, autoExit: process.env.PI_SUBAGENT_AUTO_EXIT }));
  renameSync(join(root, "received.tmp"), join(root, "received.json"));
  await waitFor(() => existsSync(join(root, "finish")) ? true : undefined, "permission to complete delegated task");
  if (task.includes("EXIT_WITHOUT_RESULT")) {
    process.exitCode = 2;
    break;
  }
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
  if (!task.includes("NO_OUTPUT")) {
    branch.push(entry);
    appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
  }
  await runtime.emit("agent_end", { messages: [message] }, ctx);
  if (shutdown) throw new Error("Child shut down before final settlement");
  await runtime.emit("agent_before_settle", { outcome: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed" }, ctx);
  await runtime.emit("agent_settled", {}, ctx);
  if (task.includes("LONG_OUTPUT")) {
    // Result persistence won the race with process/surface loss; screen reads
    // can no longer help the parent and must not reverse the task outcome.
    writeFileSync(join(root, "diagnostics-unavailable"), "gone");
    writeFileSync(join(root, "surface"), "gone");
    shutdown = true;
  }
  if (shutdown) break;
  writeFileSync(join(root, "parked"), "waiting");
  await waitFor(() => existsSync(join(root, "next-task")) ? true : undefined, "resident/manual next input");
  task = readFileSync(join(root, "next-task"), "utf8");
  rmSync(join(root, "next-task"));
}
await runtime.emit("session_shutdown", { reason: "quit" }, ctx);
