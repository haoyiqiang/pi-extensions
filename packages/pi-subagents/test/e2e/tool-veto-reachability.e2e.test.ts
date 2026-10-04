/**
 * tool-veto-reachability.e2e.test.ts — reachability guard for the `ext:` turn-1
 * tool veto (issue #125).
 *
 * `installExtensionToolScope` enforces `ext:` narrowing two ways. Re-narrowing the
 * ACTIVE set on `turn_end` is built entirely on public API (`getAllTools`,
 * `getActiveToolNames`, `setActiveToolsByName`) and is covered by the unit tests.
 * The second half is not: turn 1 cannot be narrowed at all — `before_agent_start`
 * fires INSIDE `prompt()` and may widen the tool set, but `createContextSnapshot()`
 * freezes that turn's tools immediately after, leaving no window. Pi 0.87.1's
 * supported call-time veto is the native extension event
 * `pi.on("tool_call") -> { block, reason }`, so runAgent injects one hidden inline
 * extension into the child ResourceLoader.
 *
 * The unit tests use a small event-runner double. This guard closes the remaining
 * integration gap against a REAL AgentSession: the hidden handler survives loader
 * filtering, binds into Pi's ExtensionRunner, blocks an out-of-scope call, and
 * composes with the ordinary child extensions.
 *
 * No network/LLM: a faux Model satisfies session construction, and the native
 * ExtensionRunner event is invoked directly rather than through a model turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi-mono (loader + dynamic extension import + session construction).
vi.setConfig({ testTimeout: 30_000 });

/** Registers `alpha_read` / `alpha_write`; reused so no new fixture is needed. */
const ALPHA = resolve(fileURLToPath(new URL("../fixtures/ext-alpha.mjs", import.meta.url)));
/** Registers `beta_tool` — loaded but NOT selected by the `ext:` selector below. */
const BETA = resolve(fileURLToPath(new URL("../fixtures/ext-beta.mjs", import.meta.url)));

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("tool veto reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-veto-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("runAgent installs a native tool_call veto for out-of-scope tools", async () => {
    registerAgents(
      new Map([
        [
          "veto",
          {
            name: "veto",
            description: "veto guard",
            builtinToolNames: ["read"],
            // Select alpha only — beta loads (its handlers run) but is muted.
            extensions: [ALPHA, BETA],
            extSelectors: ["ext:ext-alpha.mjs"],
            skills: false,
            systemPrompt: "You are veto.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );

    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let session: any;
    try {
      await runAgent(ctx, "veto", "go", {
        pi: makePi(),
        model,
        onSessionCreated: (s: any) => {
          session = s;
        },
      });
    } catch {
      // A faux-model turn may not complete; the veto is fixed at construction.
    }

    expect(session.hasExtensionHandlers("tool_call")).toBe(true);

    // Out of scope: beta loaded but the ext: flip did not select it.
    await expect(session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "beta-1",
      toolName: "beta_tool",
      input: {},
    })).resolves.toMatchObject({ block: true, reason: expect.any(String) });

    // In scope: the hidden guard delegates to the rest of Pi's native handler chain.
    await expect(session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "alpha-1",
      toolName: "alpha_read",
      input: {},
    })).resolves.toSatisfy((r: any) => !r?.block);
  });
});
