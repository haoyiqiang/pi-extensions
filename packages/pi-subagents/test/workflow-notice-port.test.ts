import { expect, it } from "vitest";
import { workflowNoticeObserver } from "../../pi-workflow/src/i18n.js";
import { executionFixture } from "./helpers/workflow-execution.js";

it("relays workflow notices through the consumer's outlet without an extra agents tag", async () => {
  const f = executionFixture();
  const notify = f.observer.ui.notify;
  const observer = workflowNoticeObserver(Object.assign(f.observer, { mode: "rpc" }));
  const host = f.host({ observer });
  try {
    host.ui.notify("root stage", "info");
    await host.spawnChild({ prompt: "plain", withSession: async child => {
      child.ui.notify("child stage", "warning");
    } });
    expect(notify).toHaveBeenNthCalledWith(1, "[workflow] root stage", "info");
    expect(notify).toHaveBeenNthCalledWith(2, "[workflow] child stage", "warning");
  } finally { await f.close(); }
});
