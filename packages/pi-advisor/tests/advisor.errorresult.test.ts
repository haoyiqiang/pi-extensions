import { createMockCtx, createMockPi } from "@maplezzk/pi-test-utils/rpiv";
import { describe, expect, it } from "vitest";

import { registerAdvisorTool, setAdvisorEffort, setAdvisorModel } from "./advisor-test-state.js";

describe("advisor execute — buildErrorResult envelope", () => {
	it("omits advisorModel when label undefined (no model selected)", async () => {
		setAdvisorModel(undefined);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get("advisor");
		expect(tool).toBeDefined();
		const ctx = createMockCtx();
		const result = await tool?.execute?.("tc1", {}, undefined as never, undefined as never, ctx);
		expect(result?.content[0]).toMatchObject({ type: "text" });
		expect(result?.details).toMatchObject({ errorMessage: "no advisor model selected" });
		expect(result?.details).not.toHaveProperty("advisorModel");
	});

	it("reflects current effort in details.effort", async () => {
		setAdvisorModel(undefined);
		setAdvisorEffort("medium");
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get("advisor");
		const ctx = createMockCtx();
		const result = await tool?.execute?.("tc1", {}, undefined as never, undefined as never, ctx);
		expect(result?.details).toMatchObject({ effort: "medium" });
	});

	it("includes advisorModel label when native request preparation reports an auth error", async () => {
		setAdvisorModel({ provider: "a", id: "m", api: "openai-responses" } as never);
		const { pi, captured } = createMockPi();
		registerAdvisorTool(pi);
		const tool = captured.tools.get("advisor");
		const ctx = createMockCtx();
		let preflightCalls = 0;
		ctx.modelRegistry = {
			...ctx.modelRegistry,
			getApiKeyAndHeaders: (async () => {
				preflightCalls += 1;
				return { ok: false, error: "unexpected preflight" };
			}) as never,
			streamSimple: (() => ({
				result: async () => ({
					role: "assistant",
					content: [],
					api: "openai-responses",
					provider: "a",
					model: "m",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: "bad auth",
					timestamp: Date.now(),
				}),
			})) as never,
		} as never;
		const result = await tool?.execute?.("tc1", {}, undefined as never, undefined as never, ctx);
		expect(preflightCalls).toBe(0);
		expect(result?.details).toMatchObject({ advisorModel: "a:m", stopReason: "error", errorMessage: "bad auth" });
	});
});
