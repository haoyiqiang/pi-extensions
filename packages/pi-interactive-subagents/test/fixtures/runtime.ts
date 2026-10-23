// A deterministic Pi runtime boundary. Load the real child control extension,
// deliver the CLI task, and withhold the final answer until the test releases it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import subagentDone from "../../pi-extension/subagents/subagent-done.ts";
import { createMockExtensionApi, plainTheme, waitFor } from "../harness.ts";

const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const root = process.env.SUBAGENT_TEST_TERMINAL!;
const taskArg = args.at(-1)!;
const task = taskArg.startsWith("@") ? readFileSync(taskArg.slice(1), "utf8") : taskArg;
const runtime = createMockExtensionApi();
const widgets: string[] = [];
let shutdown = false;
const ctx = {
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
await runtime.emit("input", { text: task, source: "interactive" }, ctx);
await runtime.emit("before_agent_start", { prompt: task }, ctx);
await runtime.emit("agent_start", {}, ctx);
writeFileSync(join(root, "received.tmp"), JSON.stringify({ task, widgets, tools: runtime.registeredTools.map((tool) => tool.name), args }));
renameSync(join(root, "received.tmp"), join(root, "received.json"));
await waitFor(() => existsSync(join(root, "finish")) ? true : undefined, "permission to complete delegated task");
const answer = task.match(/Return the exact phrase: ([^\n]+)/)?.[1];
if (!answer) throw new Error(`Fixture cannot process task: ${task}`);
const message = { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" };
appendFileSync(sessionFile, JSON.stringify({ type: "message", id: "fixture-answer", parentId: null, message }) + "\n");
await runtime.emit("agent_end", { messages: [message] }, ctx);
if (!shutdown) throw new Error("Autonomous child did not request shutdown");
await runtime.emit("session_shutdown", { reason: "quit" }, ctx);
