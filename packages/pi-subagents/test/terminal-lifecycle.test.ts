import { afterEach, describe, expect, it, vi } from "vitest";
import { launchTerminalRun } from "../src/backends/terminal/lifecycle.js";
import type { PersistentSessionReference } from "../src/backends/session-reference.js";
import { i18n } from "../src/i18n.js";
import type {
  TerminalArtifacts,
  TerminalDependencies,
  TerminalExit,
  TerminalLaunchPlan,
  TerminalTranscriptCursor,
  TerminalTransport,
} from "../src/backends/terminal/types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface WaitRecord {
  readonly surface: string;
  readonly signal: AbortSignal;
  readonly options: { sessionFile: string; onTick?: (elapsedSeconds: number) => void };
  readonly exit: Deferred<TerminalExit>;
}

function createHarness() {
  const events: string[] = [];
  const waits: WaitRecord[] = [];
  const clock = { value: 1_000 };
  const summary = { value: "fresh child summary" as unknown };
  const cursor: TerminalTranscriptCursor = { byteOffset: 41, prefixDigest: "old-prefix" };
  let nextSurface = 0;

  const prepare = vi.fn((session: PersistentSessionReference<"terminal">): TerminalTranscriptCursor => {
    events.push(`prepare:${session.sessionId}`);
    return cursor;
  });
  const readSummary = vi.fn((sessionFile: string, prepared: TerminalTranscriptCursor): string | undefined => {
    events.push(`read:${sessionFile}:${prepared.byteOffset}`);
    return summary.value as string | undefined;
  });
  const artifacts: TerminalArtifacts = { prepare, readSummary };

  const createSurface = vi.fn((name: string): string => {
    const surface = `surface-${++nextSurface}`;
    events.push(`create:${name}:${surface}`);
    return surface;
  });
  const sendCommand = vi.fn((surface: string, command: string, scriptPath: string): void => {
    events.push(`send:${surface}:${command}:${scriptPath}`);
  });
  const sendEscape = vi.fn((surface: string): void => {
    events.push(`escape:${surface}`);
  });
  const closeSurface = vi.fn((surface: string): void => {
    events.push(`close:${surface}`);
  });
  const waitForExit = vi.fn((
    surface: string,
    signal: AbortSignal,
    options: { sessionFile: string; onTick?: (elapsedSeconds: number) => void },
  ): Promise<TerminalExit> => {
    events.push(`wait:${surface}:${options.sessionFile}`);
    const exit = deferred<TerminalExit>();
    waits.push({ surface, signal, options, exit });
    return exit.promise;
  });
  const transport: TerminalTransport = {
    createSurface,
    sendCommand,
    sendEscape,
    closeSurface,
    waitForExit,
  };

  const now = vi.fn((): number => {
    events.push(`now:${clock.value}`);
    return clock.value;
  });
  const delay = vi.fn(async (milliseconds: number, _signal: AbortSignal): Promise<void> => {
    events.push(`delay:${milliseconds}`);
  });
  const dependencies: TerminalDependencies = { transport, artifacts, now, delay };

  return {
    artifacts,
    clock,
    closeSurface,
    createSurface,
    cursor,
    delay,
    dependencies,
    events,
    now,
    prepare,
    readSummary,
    sendCommand,
    sendEscape,
    summary,
    transport,
    waitForExit,
    waits,
  };
}

function session(
  sessionId = "session-1",
  sessionFile = `/tmp/${sessionId}.jsonl`,
): PersistentSessionReference<"terminal"> {
  return { backend: "terminal", sessionId, sessionFile };
}

function plan(overrides: Partial<TerminalLaunchPlan> = {}): TerminalLaunchPlan {
  return {
    run: { runId: "run-1", session: session() },
    name: "researcher",
    launchScriptFile: "/tmp/launch-subagent.sh",
    buildCommand: vi.fn((surface: string) => `run-child --surface ${surface}`),
    ...overrides,
  };
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal lifecycle", () => {
  it.each([
    ["backend", (target: TerminalLaunchPlan) => ({
      ...target,
      run: { ...target.run, session: { ...target.run.session, backend: "embedded" } },
    })],
    ["run id", (target: TerminalLaunchPlan) => ({ ...target, run: { ...target.run, runId: "  " } })],
    ["session id", (target: TerminalLaunchPlan) => ({
      ...target,
      run: { ...target.run, session: { ...target.run.session, sessionId: "" } },
    })],
    ["session path", (target: TerminalLaunchPlan) => ({
      ...target,
      run: { ...target.run, session: { ...target.run.session, sessionFile: "relative/session.jsonl" } },
    })],
    ["script path", (target: TerminalLaunchPlan) => ({ ...target, launchScriptFile: "relative/launch.sh" })],
  ])("validates the %s before any injected side effect", async (_label, mutate) => {
    const harness = createHarness();
    const invalid = mutate(plan()) as TerminalLaunchPlan;

    await expect(launchTerminalRun(invalid, harness.dependencies)).rejects.toThrow(
      i18n.t("terminal.invalidReference"),
    );

    expect(harness.now).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.createSurface).not.toHaveBeenCalled();
    expect(harness.delay).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, null])(
    "rejects invalid readiness delay %s before side effects",
    async (shellReadyDelayMs) => {
      const harness = createHarness();

      await expect(launchTerminalRun(plan({
        shellReadyDelayMs: shellReadyDelayMs as number,
      }), harness.dependencies)).rejects.toThrow(
        i18n.t("terminal.invalidDelay"),
      );

      expect(harness.now).not.toHaveBeenCalled();
      expect(harness.prepare).not.toHaveBeenCalled();
      expect(harness.createSurface).not.toHaveBeenCalled();
    },
  );

  it.each(["/tmp/session-1.jsonl", "/tmp/dir/../session-1.jsonl", "/tmp/session-1.jsonl.exit"])(
    "rejects a launch script that would overwrite a session artifact: %s",
    async (launchScriptFile) => {
      const harness = createHarness();
      await expect(launchTerminalRun(plan({ launchScriptFile }), harness.dependencies))
        .rejects.toThrow(i18n.t("terminal.scriptOverwritesSession"));
      expect(harness.prepare).not.toHaveBeenCalled();
      expect(harness.createSurface).not.toHaveBeenCalled();
    },
  );

  it("passes an explicit PowerShell interpreter to dispatch and rejects unsupported choices", async () => {
    const harness = createHarness();
    const launchPlan = plan({ interpreter: "powershell", launchScriptFile: "/tmp/launch-subagent.ps1" });
    const run = await launchTerminalRun(launchPlan, harness.dependencies);
    expect(harness.sendCommand).toHaveBeenCalledWith(
      "surface-1", "run-child --surface surface-1", "/tmp/launch-subagent.ps1", "powershell",
    );
    await run.cancel();
    harness.createSurface.mockClear();
    await expect(launchTerminalRun(plan({ interpreter: "python" as never }), harness.dependencies))
      .rejects.toThrow(i18n.t("terminal.invalidInterpreter"));
    expect(harness.createSurface).not.toHaveBeenCalled();
  });

  it("rejects an already aborted parent before listeners or lifecycle side effects", async () => {
    const harness = createHarness();
    const parent = new AbortController();
    const reason = new Error("parent already stopped");
    parent.abort(reason);
    const addListener = vi.spyOn(parent.signal, "addEventListener");

    await expect(launchTerminalRun(plan({ signal: parent.signal }), harness.dependencies)).rejects.toBe(reason);

    expect(addListener).not.toHaveBeenCalled();
    expect(harness.now).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.createSurface).not.toHaveBeenCalled();
    expect(harness.closeSurface).not.toHaveBeenCalled();
  });

  it("does not dispatch until the injected readiness timer settles", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.delay.mockImplementation((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }));

    const launching = launchTerminalRun(plan(), harness.dependencies);
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.sendCommand).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(harness.sendCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const run = await launching;
    expect(harness.sendCommand).toHaveBeenCalledOnce();
    harness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });
    await run.completion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a created surface and detaches parent linkage when cancellation reaches the readiness delay", async () => {
    const harness = createHarness();
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const delayStarted = deferred<void>();
    harness.delay.mockImplementation((_milliseconds: number, signal: AbortSignal) => {
      delayStarted.resolve();
      return new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    });
    const reason = new Error("cancel during shell readiness");

    const launching = launchTerminalRun(plan({ signal: parent.signal }), harness.dependencies);
    await delayStarted.promise;
    parent.abort(reason);

    await expect(launching).rejects.toBe(reason);
    expect(harness.sendCommand).not.toHaveBeenCalled();
    expect(harness.closeSurface).toHaveBeenCalledOnce();
    expect(harness.closeSurface).toHaveBeenCalledWith("surface-1");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cleans up the right startup phases without dispatching later work", async () => {
    const prepareHarness = createHarness();
    const prepareError = new Error("prepare failed");
    prepareHarness.prepare.mockImplementation(() => { throw prepareError; });
    await expect(launchTerminalRun(plan(), prepareHarness.dependencies)).rejects.toBe(prepareError);
    expect(prepareHarness.createSurface).not.toHaveBeenCalled();
    expect(prepareHarness.closeSurface).not.toHaveBeenCalled();

    const createHarnessFailure = createHarness();
    const createError = new Error("create failed");
    createHarnessFailure.createSurface.mockImplementation(() => { throw createError; });
    await expect(launchTerminalRun(plan(), createHarnessFailure.dependencies)).rejects.toBe(createError);
    expect(createHarnessFailure.delay).not.toHaveBeenCalled();
    expect(createHarnessFailure.closeSurface).not.toHaveBeenCalled();

    const buildHarness = createHarness();
    const buildError = new Error("build failed");
    await expect(launchTerminalRun(plan({
      buildCommand: () => { throw buildError; },
    }), buildHarness.dependencies)).rejects.toBe(buildError);
    expect(buildHarness.sendCommand).not.toHaveBeenCalled();
    expect(buildHarness.closeSurface).toHaveBeenCalledOnce();

    const sendHarness = createHarness();
    const sendError = new Error("send failed");
    sendHarness.sendCommand.mockImplementation(() => { throw sendError; });
    await expect(launchTerminalRun(plan(), sendHarness.dependencies)).rejects.toBe(sendError);
    expect(sendHarness.closeSurface).toHaveBeenCalledOnce();
    expect(sendHarness.waitForExit).not.toHaveBeenCalled();
  });

  it("preserves both a startup error and its cleanup error", async () => {
    const harness = createHarness();
    const startupError = new Error("command construction failed");
    const cleanupError = new Error("surface close failed");
    harness.closeSurface.mockImplementation(() => { throw cleanupError; });

    const failure = await rejectedValue(launchTerminalRun(plan({
      buildCommand: () => { throw startupError; },
    }), harness.dependencies));

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startupError, cleanupError]);
    expect((failure as Error & { cause?: unknown }).cause).toBe(startupError);
    expect(harness.closeSurface).toHaveBeenCalledOnce();
  });

  it("prepares before dispatch, freezes identity snapshots, ignores tick faults and reads only the fresh cursor", async () => {
    const harness = createHarness();
    const parent = new AbortController();
    const removeParentListener = vi.spyOn(parent.signal, "removeEventListener");
    const originalSession = session();
    const onTick = vi.fn(() => { throw new Error("observer failed"); });
    const buildCommand = vi.fn((surface: string) => {
      harness.events.push(`build:${surface}`);
      return `launch ${surface}`;
    });
    const launchPlan = plan({
      run: { runId: "run-frozen", session: originalSession },
      signal: parent.signal,
      onTick,
      buildCommand,
    });

    const run = await launchTerminalRun(launchPlan, harness.dependencies);
    const wait = harness.waits[0];
    const removeLocalListener = vi.spyOn(wait.signal, "removeEventListener");

    expect(run.run).not.toBe(launchPlan.run);
    expect(run.run.session).not.toBe(originalSession);
    expect(Object.isFrozen(run.run)).toBe(true);
    expect(Object.isFrozen(run.run.session)).toBe(true);
    expect(run.run).toEqual(launchPlan.run);
    expect(harness.delay).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    expect(harness.events).toEqual([
      "now:1000",
      "prepare:session-1",
      "create:researcher:surface-1",
      "delay:500",
      "build:surface-1",
      "send:surface-1:launch surface-1:/tmp/launch-subagent.sh",
      "wait:surface-1:/tmp/session-1.jsonl",
    ]);

    expect(() => wait.options.onTick?.(1.25)).not.toThrow();
    expect(onTick).toHaveBeenCalledWith(1.25);
    harness.clock.value = 3_750;
    wait.exit.resolve({ reason: "done", exitCode: 0 });

    const result = await run.completion;
    expect(result).toMatchObject({
      run: run.run,
      status: "completed",
      exitCode: 0,
      reason: "done",
      summary: "fresh child summary",
      elapsedSeconds: 2.75,
    });
    expect(harness.readSummary).toHaveBeenCalledOnce();
    expect(harness.readSummary).toHaveBeenCalledWith("/tmp/session-1.jsonl", harness.cursor);
    expect(harness.closeSurface).toHaveBeenCalledOnce();
    expect(removeParentListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(removeLocalListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("classifies a nonzero child exit as failed and uses the localized fallback", async () => {
    const harness = createHarness();
    harness.summary.value = undefined;
    const run = await launchTerminalRun(plan(), harness.dependencies);
    harness.clock.value = 2_000;
    harness.waits[0].exit.resolve({ reason: "sentinel", exitCode: 7 });

    const result = await run.completion;

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 7,
      reason: "sentinel",
      summary: i18n.t("terminal.exitError", { code: 7 }),
      elapsedSeconds: 1,
    });
    expect(harness.closeSurface).toHaveBeenCalledOnce();
  });

  it("uses the localized empty-output fallback for a successful exit", async () => {
    const harness = createHarness();
    harness.summary.value = undefined;
    const run = await launchTerminalRun(plan(), harness.dependencies);
    harness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });

    await expect(run.completion).resolves.toMatchObject({
      status: "completed",
      summary: i18n.t("terminal.finished"),
    });
  });

  it("preserves ping metadata", async () => {
    const harness = createHarness();
    const ping = { name: "review-needed", message: "Please inspect the diff" };
    const run = await launchTerminalRun(plan(), harness.dependencies);
    harness.waits[0].exit.resolve({ reason: "ping", exitCode: 0, ping });

    await expect(run.completion).resolves.toMatchObject({ reason: "ping", ping });
  });

  it.each([false, 0, null])("preserves structured output value %s", async (structuredOutput) => {
    const harness = createHarness();
    const run = await launchTerminalRun(plan(), harness.dependencies);
    harness.waits[0].exit.resolve({ reason: "structured_output", exitCode: 0, structuredOutput });

    const result = await run.completion;
    expect(result).toHaveProperty("structuredOutput");
    expect(result.structuredOutput).toBe(structuredOutput);
  });

  it("resolves wait and malformed-summary failures instead of rejecting completion", async () => {
    const waitHarness = createHarness();
    const waitError = new Error("exit watcher failed");
    const waitingRun = await launchTerminalRun(plan(), waitHarness.dependencies);
    waitHarness.waits[0].exit.reject(waitError);

    await expect(waitingRun.completion).resolves.toMatchObject({
      status: "failed",
      exitCode: 1,
      summary: i18n.t("terminal.failed", { error: waitError.message }),
      error: waitError.message,
    });
    expect(waitHarness.readSummary).not.toHaveBeenCalled();
    expect(waitHarness.closeSurface).toHaveBeenCalledOnce();

    const readerHarness = createHarness();
    readerHarness.readSummary.mockImplementation(() => 42 as never);
    const readingRun = await launchTerminalRun(plan(), readerHarness.dependencies);
    readerHarness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });

    await expect(readingRun.completion).resolves.toMatchObject({
      status: "failed",
      exitCode: 0,
      reason: "done",
      error: i18n.t("terminal.invalidSummary"),
      summary: i18n.t("terminal.failed", {
        error: i18n.t("terminal.invalidSummary"),
      }),
    });
    expect(readerHarness.closeSurface).toHaveBeenCalledOnce();
  });

  it("cancels promptly even when the transport ignores abort and shares one completion", async () => {
    const harness = createHarness();
    const run = await launchTerminalRun(plan(), harness.dependencies);
    const ignoredWait = harness.waits[0];

    const first = run.cancel();
    const second = run.cancel();

    expect(first).toBe(run.completion);
    expect(second).toBe(run.completion);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(firstResult).toMatchObject({
      status: "cancelled",
      exitCode: 1,
      summary: i18n.t("terminal.cancelled"),
    });
    expect(ignoredWait.signal.aborted).toBe(true);
    expect(harness.closeSurface).toHaveBeenCalledOnce();
    expect(harness.readSummary).not.toHaveBeenCalled();
    expect(harness.sendEscape).not.toHaveBeenCalled();

    // The losing wait remains observed; a late rejection must not change or reject completion.
    ignoredWait.exit.reject(new Error("late watcher rejection"));
    await Promise.resolve();
    await expect(run.completion).resolves.toBe(firstResult);
  });

  it.each(["completed", "cancelled"])("ignores late observations after %s and rejects interrupts during cancel", async (status) => {
    const harness = createHarness();
    const onTick = vi.fn();
    const run = await launchTerminalRun(plan({ onTick }), harness.dependencies);
    const tick = harness.waits[0].options.onTick!;
    tick(1);
    expect(onTick).toHaveBeenCalledOnce();
    if (status === "completed") {
      harness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });
    } else {
      void run.cancel();
      tick(2);
      await expect(run.interrupt()).rejects.toThrow(i18n.t("terminal.notRunning"));
    }
    await run.completion;
    tick(3);
    expect(onTick).toHaveBeenCalledOnce();
    expect(harness.sendEscape).not.toHaveBeenCalled();
  });

  it("links parent abort to cancellation and detaches the listener", async () => {
    const harness = createHarness();
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const run = await launchTerminalRun(plan({ signal: parent.signal }), harness.dependencies);

    parent.abort(new Error("parent cancelled"));

    await expect(run.completion).resolves.toMatchObject({ status: "cancelled" });
    expect(harness.closeSurface).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps the child result when close fails and reports cleanup separately", async () => {
    const harness = createHarness();
    harness.closeSurface.mockImplementation(() => { throw new Error("mux close failed"); });
    const run = await launchTerminalRun(plan(), harness.dependencies);
    harness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });

    await expect(run.completion).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
      summary: "fresh child summary",
      cleanupError: "mux close failed",
    });
    expect(harness.closeSurface).toHaveBeenCalledOnce();
  });

  it("reports a cancellation close failure without retrying cleanup", async () => {
    const harness = createHarness();
    harness.closeSurface.mockImplementation(() => { throw new Error("cancel close failed"); });
    const run = await launchTerminalRun(plan(), harness.dependencies);

    const result = await run.cancel();
    const repeated = await run.cancel();

    expect(repeated).toBe(result);
    expect(result).toMatchObject({ status: "cancelled", cleanupError: "cancel close failed" });
    expect(harness.closeSurface).toHaveBeenCalledOnce();
  });

  it("sends Escape without cancelling, propagates Escape errors, and rejects interrupts after completion", async () => {
    const harness = createHarness();
    const run = await launchTerminalRun(plan(), harness.dependencies);

    await expect(run.interrupt()).resolves.toBeUndefined();
    expect(harness.sendEscape).toHaveBeenCalledWith("surface-1");
    expect(harness.closeSurface).not.toHaveBeenCalled();
    expect(harness.waits[0].signal.aborted).toBe(false);

    const escapeError = new Error("escape delivery failed");
    harness.sendEscape.mockImplementationOnce(() => { throw escapeError; });
    await expect(run.interrupt()).rejects.toBe(escapeError);
    expect(harness.closeSurface).not.toHaveBeenCalled();
    expect(harness.waits[0].signal.aborted).toBe(false);

    harness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });
    await run.completion;
    await expect(run.interrupt()).rejects.toThrow(i18n.t("terminal.notRunning"));
    expect(harness.sendEscape).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh surface for repeated runs of one persistent session", async () => {
    const harness = createHarness();
    const persistent = session("shared-session", "/tmp/shared-session.jsonl");

    const first = await launchTerminalRun(plan({
      run: { runId: "run-a", session: persistent },
      name: "first",
    }), harness.dependencies);
    harness.waits[0].exit.resolve({ reason: "done", exitCode: 0 });
    const firstResult = await first.completion;

    const second = await launchTerminalRun(plan({
      run: { runId: "run-b", session: persistent },
      name: "second",
    }), harness.dependencies);
    harness.waits[1].exit.resolve({ reason: "done", exitCode: 0 });
    const secondResult = await second.completion;

    expect(first.surface).toBe("surface-1");
    expect(second.surface).toBe("surface-2");
    expect(first.run.runId).toBe("run-a");
    expect(second.run.runId).toBe("run-b");
    expect(first.run.session).toEqual(second.run.session);
    expect(firstResult.run.runId).toBe("run-a");
    expect(secondResult.run.runId).toBe("run-b");
    expect(harness.prepare).toHaveBeenCalledTimes(2);
    expect(harness.createSurface).toHaveBeenCalledTimes(2);
    expect(harness.closeSurface).toHaveBeenCalledTimes(2);
  });

  it("keeps simultaneous terminal runs independent", async () => {
    const harness = createHarness();
    const cursorByFile = new Map<string, TerminalTranscriptCursor>([
      ["/tmp/alpha.jsonl", { byteOffset: 11, prefixDigest: "alpha-old" }],
      ["/tmp/beta.jsonl", { byteOffset: 22, prefixDigest: "beta-old" }],
    ]);
    harness.prepare.mockImplementation((target) => cursorByFile.get(target.sessionFile)!);
    harness.readSummary.mockImplementation((sessionFile, prepared) => `${sessionFile}:${prepared.byteOffset}`);

    const [alpha, beta] = await Promise.all([
      launchTerminalRun(plan({
        run: { runId: "run-alpha", session: session("alpha", "/tmp/alpha.jsonl") },
        name: "alpha",
      }), harness.dependencies),
      launchTerminalRun(plan({
        run: { runId: "run-beta", session: session("beta", "/tmp/beta.jsonl") },
        name: "beta",
      }), harness.dependencies),
    ]);

    expect(alpha.surface).not.toBe(beta.surface);
    const alphaWait = harness.waits.find((item) => item.surface === alpha.surface)!;
    const betaWait = harness.waits.find((item) => item.surface === beta.surface)!;
    betaWait.exit.resolve({ reason: "done", exitCode: 0 });
    alphaWait.exit.resolve({ reason: "done", exitCode: 0 });

    const [alphaResult, betaResult] = await Promise.all([alpha.completion, beta.completion]);
    expect(alphaResult).toMatchObject({
      run: { runId: "run-alpha" },
      summary: "/tmp/alpha.jsonl:11",
    });
    expect(betaResult).toMatchObject({
      run: { runId: "run-beta" },
      summary: "/tmp/beta.jsonl:22",
    });
    expect(alphaWait.options.sessionFile).toBe("/tmp/alpha.jsonl");
    expect(betaWait.options.sessionFile).toBe("/tmp/beta.jsonl");
    expect(harness.closeSurface).toHaveBeenCalledTimes(2);
  });
});
