// A second real controller process, driven only through registered native tools.
import { join } from "node:path";
import subagents from "../../pi-extension/subagents/index.ts";
import { createMockExtensionApi } from "../harness.ts";
const root = process.argv[2];
const parentId = process.argv[3] ?? "identity-parent";
const api = createMockExtensionApi();
// A controlled parent history writer. Unlike an array push, these public Pi
// SessionManager appends produce actual JSONL bytes for replacement processes.
if (process.env.SUBAGENT_TEST_PARENT_HISTORY) {
  const { SessionManager } = await import(new URL("./core/session-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const history = SessionManager.open(join(root, "sessions/parent.jsonl"));
  api.api.sendMessage = (message: any, options: any) => {
    if (process.env.SUBAGENT_TEST_PARENT_HISTORY === "crash-before-send") process.kill(process.pid, "SIGKILL");
    history.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    process.send?.({ notification: { message, options } });
    if (process.env.SUBAGENT_TEST_PARENT_HISTORY === "crash-after-persist") process.kill(process.pid, "SIGKILL");
  };
} else {
  api.api.sendMessage = (message: any, options: any) => { api.sentMessages.push({ message, options }); process.send?.({ notification: { message, options } }); };
}
api.api.getThinkingLevel = () => "off";
const ctx = {
  cwd: join(root, "project"), hasUI: false,
  model: { provider: "fixture", id: "parent-model" },
  modelRegistry: { getAll: () => [{ provider: "fixture", id: "parent-model" }] },
  sessionManager: { getSessionFile: () => join(root, "sessions/parent.jsonl"), getSessionId: () => parentId, getSessionDir: () => join(root, "sessions") },
  ui: { setWidget() {} },
};
subagents(api.api);
await api.emit("session_start", {}, ctx);
process.on("message", async (request: any) => {
  try {
    const result = request.lifecycle ? await api.emit(request.lifecycle, request.params, ctx)
      : await api.tool(request.tool).execute("ipc", request.params, undefined, undefined, ctx);
    process.send!({ sequence: request.sequence, result });
  } catch (error: any) {
    process.send!({ sequence: request.sequence, error: error.message });
  }
});
process.send!({ ready: true });
