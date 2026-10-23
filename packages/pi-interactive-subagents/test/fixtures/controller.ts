// A second real controller process, driven only through registered native tools.
import { join } from "node:path";
import subagents from "../../pi-extension/subagents/index.ts";
import { createMockExtensionApi } from "../harness.ts";
const root = process.argv[2];
const parentId = process.argv[3] ?? "identity-parent";
const api = createMockExtensionApi();
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
    const result = await api.tool(request.tool).execute("ipc", request.params, undefined, undefined, ctx);
    process.send!({ sequence: request.sequence, result });
  } catch (error: any) {
    process.send!({ sequence: request.sequence, error: error.message });
  }
});
process.send!({ ready: true });
