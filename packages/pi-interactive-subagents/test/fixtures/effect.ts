import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  let settled = false;
  pi.on("agent_settled", () => { settled = true; });
  pi.on("session_shutdown", async (event) => {
    if (!settled || process.env.PI_SUBAGENT_AGENT !== "slow") return;
    writeFileSync(join(process.env.SUBAGENT_TEST_TERMINAL!, "slow-shutdown-started"), JSON.stringify({ reason: event.reason, autoExit: process.env.PI_SUBAGENT_AUTO_EXIT, executionId: process.env.PI_SUBAGENT_ID }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  });
  pi.registerTool({
    name: "fixture_effect", label: "fixture effect", description: "Harmless owned-temp effect followed by unfinished work",
    parameters: Type.Object({}),
    async execute() {
      writeFileSync(join(process.env.SUBAGENT_TEST_TERMINAL!, "effect-started"), "Harmless effect occurred; tool has not returned");
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      return { content: [{ type: "text", text: "done" }], details: undefined };
    },
  });
}
