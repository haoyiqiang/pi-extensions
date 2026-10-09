import { createMockCtx, createMockPi, mockStdout } from "pi-utils/rpiv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult } from "./tool/types.js";

// Issue #107: Pi's jiti loader registers a module in its graph cache BEFORE
// evaluating the body and does not evict it on evaluation failure, so one
// failed load of the lazy session graph (host deps replaced on disk
// mid-session) leaves every later import resolving to a namespace without the
// class — `new QuestionnaireSession(...)` then throws a bare "not a
// constructor" TypeError. These tests pin the structured envelopes that
// replace that crash, and the session-start pre-warm that prevents it without
// adding factory-time timers.

type CustomFn = (...args: unknown[]) => Promise<unknown>;

const SESSION_SPECIFIER = "./state/questionnaire-session.js";

const BASE_PARAMS = {
	questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
};

/** Re-import the tool module AFTER vi.doMock so the mocked session graph is picked up. */
async function registerFresh() {
	const { registerAskUserQuestionTool } = await import("./ask-user-question.js");
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	return captured.tools.get("ask_user_question")!;
}

function ctxWithCustom(result: QuestionnaireResult | null) {
	const custom = vi.fn(async () => result) as unknown as CustomFn;
	return createMockCtx({ hasUI: true, mode: "tui", ui: { custom } as never });
}

beforeEach(async (ctx) => {
	vi.resetModules();
	// The healthy-path assertion tests dispatch; cold graph compilation is fixture setup.
	if (ctx.task.name === "loads the real session graph and reaches ctx.ui.custom when the module is healthy") {
		await import("./state/questionnaire-session.js");
	}
}, 120_000);

afterEach(() => {
	vi.doUnmock(SESSION_SPECIFIER);
	vi.useRealTimers();
});

describe("ask_user_question.execute — lazy session-graph load guards (#107)", () => {
	it("returns error: session_load_failed (not a throw) when the lazy import rejects", async () => {
		vi.doMock(SESSION_SPECIFIER, () => {
			throw new Error("Cannot find module '/replaced/store/pi-coding-agent/dist/index.js'");
		});
		const tool = await registerFresh();
		const ctx = ctxWithCustom(null);
		const stdout = mockStdout(true);
		try {
			const r = await tool.execute?.(
				"tc",
				BASE_PARAMS as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
			expect(r?.details).toMatchObject({ answers: [], cancelled: true, error: "session_load_failed" });
			expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("failed to load") });
			expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("restarting Pi") });
			// Diagnostic suffix carries the underlying loader error. (vitest's mock
			// layer rewrites the thrown message, so pin the marker, not the text.)
			expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("(cause:") });
			expect(r?.content[0]).toMatchObject({ text: expect.not.stringContaining("declined") });
			expect(stdout.stdoutWrite).not.toHaveBeenCalled();
		} finally {
			stdout.restore();
		}
	});

	it("returns error: stale_module_cache when the namespace resolves without a constructable class", async () => {
		// The poisoned-cache shape: import succeeds but the class never evaluated.
		vi.doMock(SESSION_SPECIFIER, () => ({ QuestionnaireSession: undefined }));
		const tool = await registerFresh();
		const ctx = ctxWithCustom(null);
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(r?.details).toMatchObject({ answers: [], cancelled: true, error: "stale_module_cache" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("restart Pi") });
		// Diagnostic includes the resolved namespace shape the issue asked for.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("resolved namespace keys") });
		expect(r?.content[0]).toMatchObject({ text: expect.not.stringContaining("declined") });
	});

	it("cancellation while the lazy import is held returns without opening late UI", async () => {
		let releaseImport!: () => void;
		const importStarted = vi.fn();
		vi.doMock(SESSION_SPECIFIER, async () => {
			importStarted();
			await new Promise<void>((resolve) => {
				releaseImport = resolve;
			});
			return { QuestionnaireSession: class {} };
		});

		const { registerAskUserQuestionTool } = await import("./ask-user-question.js");
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		const tool = captured.tools.get("ask_user_question")!;
		const custom = vi.fn(async () => ({ answers: [], cancelled: true }));
		const ctx = createMockCtx({ hasUI: true, mode: "tui", ui: { custom } as never });
		const controller = new AbortController();
		const stdout = mockStdout(true);
		try {
			const pending = tool.execute?.(
				"tc",
				BASE_PARAMS as never,
				controller.signal,
				undefined as never,
				ctx as never,
			);
			await vi.waitFor(() => expect(importStarted).toHaveBeenCalledOnce());
			controller.abort();
			releaseImport();
			const result = await pending;

			expect(result?.details).toMatchObject({ answers: [], cancelled: true });
			expect(custom).not.toHaveBeenCalled();
			expect(captured.eventsEmitted.has("rpiv:ask-user:prompt")).toBe(false);
			expect(captured.eventsEmitted.has("rpiv:ask-user:blocked")).toBe(false);
			expect(stdout.stdoutWrite).not.toHaveBeenCalled();
		} finally {
			stdout.restore();
		}
	});

	it("loads the real session graph and reaches ctx.ui.custom when the module is healthy", async () => {
		const tool = await registerFresh();
		const custom = vi.fn(async () => ({ answers: [], cancelled: true }));
		const ctx = createMockCtx({ hasUI: true, mode: "tui", ui: { custom } as never });
		const r = await tool.execute?.("tc", BASE_PARAMS as never, undefined as never, undefined as never, ctx as never);
		expect(custom).toHaveBeenCalled();
		expect(r?.details).toMatchObject({ cancelled: true });
		expect(r?.details).not.toHaveProperty("error", "stale_module_cache");
	});
});

describe("ask_user_question — session-start pre-warm (#107)", () => {
	it("keeps factory registration timer-free and schedules pre-warm from TUI session_start", async () => {
		vi.useFakeTimers();
		const factory = vi.fn(() => ({ QuestionnaireSession: class {} }));
		vi.doMock(SESSION_SPECIFIER, factory);
		const { registerAskUserQuestionTool, PREWARM_DELAY_MS } = await import("./ask-user-question.js");
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);

		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(factory).not.toHaveBeenCalled();

		const start = captured.events.get("session_start")![0]!;
		start(undefined as never, createMockCtx({ hasUI: true, mode: "tui" }));
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(factory).toHaveBeenCalledOnce();
	});

	it("swallows a session-start pre-warm failure", async () => {
		vi.useFakeTimers();
		vi.doMock(SESSION_SPECIFIER, () => {
			throw new Error("Cannot find module '/replaced/store/pi-coding-agent/dist/index.js'");
		});
		const { registerAskUserQuestionTool, PREWARM_DELAY_MS } = await import("./ask-user-question.js");
		const { pi, captured } = createMockPi();
		registerAskUserQuestionTool(pi);
		captured.events.get("session_start")![0]!(undefined as never, createMockCtx({ hasUI: true, mode: "tui" }));
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
	});
});
