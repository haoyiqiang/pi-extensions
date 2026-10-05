import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeConcurrentHost, createMockSessionChain } from "../../test/upstream/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow, produces } from "../api.js";
import {
	registerWorkflowExecutionHost,
	type WorkflowExecutionIdentity,
	type WorkflowExecutionProvider,
} from "../execution-host.js";
import { fanout } from "../loop-constructors.js";
import type { Outcome } from "../output-spec.js";
import { readAllStages, readHeader } from "../state/index.js";
import type { WorkflowHostContext, WorkflowSessionContext } from "../types.js";
import { resumeWorkflow, runWorkflow } from "./runner.js";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const identity = (backend = "memory"): WorkflowExecutionIdentity => ({
	version: 1,
	executor: "test-executor",
	backend,
	promptBinding: { resolverId: "test/resources@1", resourceSetDigest: "digest-v1", assetMode: "live" },
});

const scriptWorkflow = (run: () => void = () => {}) =>
	defineWorkflow({
		name: "execution-lifecycle",
		start: "step",
		stages: { step: acts.script({ run }) },
		edges: { step: "stop" },
	});

const assistantStop = () => [
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
];

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-workflow-execution-lifecycle-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("execution identity and awaited retirement", () => {
	it("persists returned identity, passes it back on resume, and closes before publishing success", async () => {
		let secondAttempts = 0;
		const workflow = defineWorkflow({
			name: "two-stage-resume",
			start: "first",
			stages: {
				first: acts.script({ run: () => {} }),
				second: acts.script({
					run: () => {
						secondAttempts++;
						if (secondAttempts === 1) throw new Error("retry me");
					},
				}),
			},
			edges: { first: "second", second: "stop" },
		});
		const host = createFakeConcurrentHost({ cwd });
		const calls: Array<{ identity?: WorkflowExecutionIdentity }> = [];
		const closeGates = [deferred(), deferred()];
		let generation = 0;
		registerWorkflowExecutionHost({
			createHost: (observer, options) => {
				const current = generation++;
				calls.push({ identity: options.identity });
				return {
					host: observer,
					identity: identity(),
					dispose: vi.fn(),
					close: () => closeGates[current]!.promise,
				};
			},
		});

		const firstPromise = runWorkflow(host.ctx, { workflow, input: "x" });
		await vi.waitFor(() => expect(generation).toBe(1));
		let firstSettled = false;
		void firstPromise.then(() => {
			firstSettled = true;
		});
		await Promise.resolve();
		expect(firstSettled).toBe(false);
		closeGates[0]!.resolve();
		const first = await firstPromise;
		expect(first.success).toBe(false);
		const header = readHeader(cwd, first.runId!);
		expect(header?.identity).toEqual(identity());

		const resumePromise = resumeWorkflow(host.ctx, { workflow, header: header!, ref: first.runId! });
		await vi.waitFor(() => expect(generation).toBe(2));
		let resumeSettled = false;
		void resumePromise.then(() => {
			resumeSettled = true;
		});
		await Promise.resolve();
		expect(resumeSettled).toBe(false);
		// The completion toast is delayed until the close barrier resolves.
		expect(host.notifications.some(({ msg }) => /complete/i.test(msg))).toBe(false);
		closeGates[1]!.resolve();
		const resumed = await resumePromise;

		expect(resumed.success).toBe(true);
		expect(calls[0]!.identity).toBeUndefined();
		expect(calls[1]!.identity).toEqual(identity());
		expect(secondAttempts).toBe(2);
		expect(readAllStages(cwd, first.runId!)).toHaveLength(3);
		expect(host.notifications.some(({ msg }) => /complete/i.test(msg))).toBe(true);
	});

	it("rejects a changed backend identity before model resolution or journal mutation", async () => {
		const workflow = defineWorkflow({
			name: "sticky-backend",
			start: "work",
			stages: { work: acts({}) },
			edges: { work: "stop" },
		});
		const host = createFakeConcurrentHost({ cwd });
		const initialAbort = new AbortController();
		initialAbort.abort();
		registerWorkflowExecutionHost({
			createHost: (observer) => ({ host: observer, identity: identity("embedded"), close: async () => {} }),
		});
		const first = await runWorkflow(host.ctx, { workflow, input: "x", signal: initialAbort.signal });
		const header = readHeader(cwd, first.runId!)!;
		const before = readAllStages(cwd, first.runId!);

		const resolveModel = vi.fn(() => ({ model: "should/not/run" }));
		const close = vi.fn(async () => {});
		registerWorkflowExecutionHost({
			createHost: (observer) => ({
				host: observer,
				identity: identity("terminal"),
				resolveModel,
				close,
			}),
		});
		const resumed = await resumeWorkflow(host.ctx, { workflow, header, ref: first.runId! });

		expect(resumed.success).toBe(false);
		expect(resumed.error).toContain("identity does not match");
		expect(resolveModel).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(readAllStages(cwd, first.runId!)).toEqual(before);
		expect(host.spawns).toHaveLength(0);
	});

	it("prefers per-call observers, then execution-bound observers, then provider fallbacks", async () => {
		const sessionFile = join(cwd, "child.jsonl");
		writeFileSync(sessionFile, "{}\n");
		const workflow = defineWorkflow({
			name: "observer-precedence",
			start: "work",
			stages: {
				work: acts({
					outcome: { collector: { collect: () => ({ kind: "fatal" as const, message: "expected failure" }) } },
				}),
			},
			edges: { work: "stop" },
		});
		const providerModel = vi.fn(() => ({ model: "provider/model" }));
		const executionModel = vi.fn(() => ({ model: "execution/model" }));
		const providerReader = vi.fn(() => []);
		const executionReader = vi.fn(() => []);
		registerWorkflowExecutionHost({
			createHost: (observer) => ({
				host: observer,
				resolveModel: executionModel,
				readSessionBranch: executionReader,
				close: async () => {},
			}),
			resolveModel: providerModel,
			readSessionBranch: providerReader,
		});

		const perCallModel = vi.fn(() => ({ model: "call/model" }));
		const perCallReader = vi.fn(() => []);
		const callChain = createMockSessionChain({ cwd, steps: [{ branch: assistantStop(), sessionFile }] });
		await runWorkflow(callChain.ctx, {
			workflow,
			input: "call",
			resolveModel: perCallModel,
			readSessionBranch: perCallReader,
		});
		expect(callChain.ctx.spawnChild).toHaveBeenCalledWith(expect.objectContaining({ model: { model: "call/model" } }));
		expect(perCallReader).toHaveBeenCalledWith(sessionFile);
		expect(executionModel).not.toHaveBeenCalled();
		expect(executionReader).not.toHaveBeenCalled();
		expect(providerModel).not.toHaveBeenCalled();
		expect(providerReader).not.toHaveBeenCalled();

		const executionChain = createMockSessionChain({ cwd, steps: [{ branch: assistantStop(), sessionFile }] });
		await runWorkflow(executionChain.ctx, { workflow, input: "execution" });
		expect(executionChain.ctx.spawnChild).toHaveBeenCalledWith(
			expect.objectContaining({ model: { model: "execution/model" } }),
		);
		expect(executionReader).toHaveBeenCalledWith(sessionFile);
		expect(providerModel).not.toHaveBeenCalled();
		expect(providerReader).not.toHaveBeenCalled();

		registerWorkflowExecutionHost({
			createHost: (observer) => ({ host: observer, close: async () => {} }),
			resolveModel: providerModel,
			readSessionBranch: providerReader,
		});
		const providerChain = createMockSessionChain({ cwd, steps: [{ branch: assistantStop(), sessionFile }] });
		await runWorkflow(providerChain.ctx, { workflow, input: "provider" });
		expect(providerChain.ctx.spawnChild).toHaveBeenCalledWith(
			expect.objectContaining({ model: { model: "provider/model" } }),
		);
		expect(providerReader).toHaveBeenCalledWith(sessionFile);
	});

	it("does not mistake an undefined cleanup rejection for successful retirement", async () => {
		const host = createFakeConcurrentHost({ cwd });
		registerWorkflowExecutionHost({
			createHost: (observer) => ({
				host: observer,
				close: async () => {
					throw undefined;
				},
			}),
		});

		let rejected = false;
		try {
			await runWorkflow(host.ctx, { workflow: scriptWorkflow(), input: "x" });
		} catch (error) {
			rejected = true;
			expect(error).toBeUndefined();
		}
		expect(rejected).toBe(true);
		expect(host.notifications.some(({ msg }) => /complete/i.test(msg))).toBe(false);
	});

	it("preserves close failure and never publishes workflow success", async () => {
		const host = createFakeConcurrentHost({ cwd });
		const dispose = vi.fn();
		registerWorkflowExecutionHost({
			createHost: (observer) => ({
				host: observer,
				identity: identity(),
				dispose,
				close: async () => {
					throw new Error("close boom");
				},
			}),
		});

		await expect(runWorkflow(host.ctx, { workflow: scriptWorkflow(), input: "x" })).rejects.toThrow("close boom");
		expect(dispose).toHaveBeenCalledOnce();
		expect(host.notifications.some(({ msg }) => /complete/i.test(msg))).toBe(false);
	});
});

describe("cancellation propagation and late-write exclusion", () => {
	it("combines caller and execution signals instead of letting either mask the other", async () => {
		for (const source of ["caller", "execution"] as const) {
			const host = createFakeConcurrentHost({ cwd: mkdtempSync(join(cwd, `${source}-`)) });
			const caller = new AbortController();
			const execution = new AbortController();
			registerWorkflowExecutionHost({
				createHost: (observer) => ({ host: observer, signal: execution.signal, close: async () => {} }),
			});
			if (source === "caller") caller.abort();
			else execution.abort();
			const result = await runWorkflow(host.ctx, {
				workflow: scriptWorkflow(),
				input: source,
				signal: caller.signal,
			});
			expect(result.termination?.status).toBe("aborted");
		}
	});

	it("propagates canonical cancellation through a retrying fanout without collecting the cancelled unit", async () => {
		const host = createFakeConcurrentHost({ cwd, maxConcurrency: 1, childBranch: assistantStop });
		const executionAbort = new AbortController();
		const collectorEntered = deferred();
		let cancellationError!: (signal: AbortSignal) => Error;
		const outcome: Outcome = {
			name: "units",
			collector: {
				collect: async () => {
					collectorEntered.resolve();
					if (executionAbort.signal.aborted) throw cancellationError(executionAbort.signal);
					await new Promise<never>((_, reject) =>
						executionAbort.signal.addEventListener(
							"abort",
							() => reject(cancellationError(executionAbort.signal)),
							{ once: true },
						),
					);
					throw new Error("unreachable");
				},
			},
		};
		const workflow = defineWorkflow({
			name: "cancel-retry",
			start: "fan",
			stages: {
				fan: produces({
					outcome,
					loop: fanout({
						units: () => [{ id: "u0", label: "u0", prompt: "work" }],
						retryHaltedUnits: 1,
					}),
				}),
			},
			edges: { fan: "stop" },
		});
		registerWorkflowExecutionHost({
			createHost: (observer, options) => {
				cancellationError = options.cancellationError;
				return { host: host.ctx, signal: executionAbort.signal, close: async () => {} };
			},
		} as WorkflowExecutionProvider);

		const running = runWorkflow(host.ctx, { workflow, input: "x" });
		await collectorEntered.promise;
		executionAbort.abort("cancel fanout");
		const result = await running;
		const rows = readAllStages(cwd, result.runId!);

		expect(result.termination?.status).toBe("aborted");
		expect(host.spawns).toHaveLength(1);
		expect(rows.filter((row) => row.collected)).toHaveLength(0);
		expect(rows.at(-1)?.status).toBe("aborted");
	});

	it("blocks an abandoned callback from appending after run termination", async () => {
		const observer = createFakeConcurrentHost({ cwd });
		const executionAbort = new AbortController();
		const collectorEntered = deferred();
		const releaseCollector = deferred();
		const lateSettled = deferred();
		let cancellationError!: (signal: AbortSignal) => Error;
		const outcome: Outcome = {
			collector: {
				collect: async () => {
					collectorEntered.resolve();
					await releaseCollector.promise;
					return { kind: "ok", artifacts: [] };
				},
			},
		};
		const workflow = defineWorkflow({
			name: "late-write",
			start: "work",
			stages: { work: acts({ outcome }) },
			edges: { work: "stop" },
		});

		registerWorkflowExecutionHost({
			createHost: (_observer, options) => {
				cancellationError = options.cancellationError;
				const spawnChild: WorkflowHostContext["spawnChild"] = async (input) => {
					const child = {
						...observer.ctx,
						signal: input.signal,
						sessionManager: {
							getBranch: () => assistantStop(),
							getSessionId: () => "late-child",
							getSessionFile: () => undefined,
						},
						sendUserMessage: async () => {},
					} as WorkflowSessionContext;
					const callback = Promise.resolve(input.withSession(child));
					void callback.finally(() => lateSettled.resolve()).catch(() => {});
					if (!input.signal) return callback;
					const cancelled = new Promise<never>((_, reject) => {
						if (input.signal!.aborted) reject(cancellationError(input.signal!));
						else
							input.signal!.addEventListener(
								"abort",
								() => reject(cancellationError(input.signal!)),
								{ once: true },
							);
					});
					return Promise.race([callback, cancelled]);
				};
				return {
					host: { ...observer.ctx, spawnChild },
					signal: executionAbort.signal,
					close: async () => {},
				};
			},
		});

		const running = runWorkflow(observer.ctx, { workflow, input: "x" });
		await collectorEntered.promise;
		executionAbort.abort("stop awaiting callback");
		const result = await running;
		const before = readAllStages(cwd, result.runId!);
		expect(before.at(-1)?.status).toBe("aborted");

		releaseCollector.resolve();
		await lateSettled.promise;
		await Promise.resolve();
		expect(readAllStages(cwd, result.runId!)).toEqual(before);
		expect(readAllStages(cwd, result.runId!).filter((row) => row.status === "completed")).toHaveLength(0);
	});
});
