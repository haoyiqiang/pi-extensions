import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { SubagentLoadout } from "./loadout.ts";
import { readSubagentLoadout } from "./session.ts";
import { processExitFile, readSubagentOutcomes, type SubagentOutcome } from "./outcome.ts";

export interface SubagentControl { id: string; kind: "suspend" | "stop" }
export interface SubagentCheckpoint {
  requestId: string;
  executionId: string;
  leafId: string | null;
  resultAfterSequence: number;
  wait: "continue" | "question" | "descendants";
  uncertainty?: { actionId: string; reason: string; activeTools: string[] };
}
export function controlFile(sessionFile: string, executionId: string): string { return `${sessionFile}.control-${executionId}.json`; }
export function checkpointFile(sessionFile: string, executionId: string): string { return `${sessionFile}.checkpoint-${executionId}.json`; }
export function readControl(sessionFile: string, executionId: string): SubagentControl | undefined {
  const file = controlFile(sessionFile, executionId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}
export function readCheckpoint(run: Pick<SubagentRun, "sessionFile" | "executionId" | "control">): SubagentCheckpoint | undefined {
  const file = checkpointFile(run.sessionFile, run.executionId);
  const checkpoint: SubagentCheckpoint | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  return checkpoint?.executionId === run.executionId && checkpoint.requestId === run.control?.id ? checkpoint : undefined;
}

/** Parent-owned facts. Child outcomes remain immutable, separate writer-owned evidence. */
export interface SubagentRun {
  id: string;
  name: string;
  parentSessionId: string;
  parentSessionFile: string;
  sessionFile: string;
  sessionId: string | null;
  generation: number;
  executionId: string;
  writerToken: string;
  resultAfterSequence: number;
  state: "starting" | "running" | "completed" | "failed" | "aborted" | "interrupted" | "suspending" | "suspended" | "stopping" | "stopped";
  control?: SubagentControl;
  backend: string;
  surface?: string;
  loadout: SubagentLoadout | null;
  startTime: number;
  latestResult?: { resultFile: string; outcome: SubagentOutcome["outcome"]; sequence: number; generation: number };
  closure?: "confirmed" | "unconfirmed";
  diagnostic?: string;
}

export function normalizeSubagentName(input: string): string {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)) throw new Error("Subagent name must not contain control characters or line breaks");
  const name = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if ([...name].length < 1 || [...name].length > 64) throw new Error("Subagent name must contain 1–64 characters");
  return name;
}

/** Short, synchronous critical sections only. Never steal a lock on elapsed time. */
export function transaction<T>(directory: string, action: () => T): T {
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "subagent-runs.lock");
  const deadline = performance.now() + 2_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new Error(`Subagent records busy; no request accepted. Inspect retained lock ${lock}; it is never reclaimed by age.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return action(); } finally { rmdirSync(lock); }
}

export function replace(file: string, data: unknown): void {
  const temporary = `${file}.tmp-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(data), "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
}

export class SubagentRuns {
  readonly directory: string;
  private readonly file: string;
  constructor(readonly parentSessionId: string, readonly parentSessionFile: string, sessionDir: string) {
    this.directory = join(sessionDir, "artifacts", parentSessionId);
    this.file = join(this.directory, "subagent-runs.json");
  }
  private read(): SubagentRun[] {
    const stored = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, runs: [] };
    if (stored.version !== 1 || !Array.isArray(stored.runs)) throw new Error(`Invalid subagent records: ${this.file}`);
    for (const run of stored.runs) {
      if (run.parentSessionId !== this.parentSessionId || resolve(run.parentSessionFile) !== resolve(this.parentSessionFile)) {
        throw new Error("Subagent parent ownership mismatch; refusing access");
      }
    }
    const runs: SubagentRun[] = stored.runs;
    const legacyFile = join(this.directory, "subagent-registry.json");
    if (existsSync(legacyFile)) {
      const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new Error(`Invalid legacy registry: ${legacyFile}`);
      for (const [rawName, value] of Object.entries(legacy)) {
        const entry = value as { sessionFile: string; sessionId: string | null };
        if (!entry || typeof entry.sessionFile !== "string") throw new Error(`Invalid legacy registry: ${legacyFile}`);
        if (runs.some((run) => run.sessionFile === entry.sessionFile)) continue;
        const id = `legacy-${createHash("sha256").update(resolve(entry.sessionFile)).digest("hex").slice(0, 24)}`;
        runs.push({ id, name: normalizeSubagentName(rawName), parentSessionId: this.parentSessionId, parentSessionFile: this.parentSessionFile,
          sessionFile: entry.sessionFile, sessionId: entry.sessionId, generation: 0, executionId: id, writerToken: "", resultAfterSequence: 0,
          state: "interrupted", backend: "unknown", loadout: readSubagentLoadout(entry.sessionFile), startTime: 0,
          diagnostic: "Legacy writer ownership is unknown; inspect retained history or delegate a fresh named role." });
      }
    }
    return runs;
  }
  list(): SubagentRun[] { return this.read(); }
  resolve(target: { id?: string; name?: string }): SubagentRun {
    const runs = this.read();
    const named = target.name === undefined ? undefined : normalizeSubagentName(target.name);
    if (!target.id && named === undefined) throw new Error("Provide a subagent id or name");
    const matches = named === undefined ? [] : runs.filter((run) => run.name === named);
    if (matches.length > 1) throw new Error(`Ambiguous subagent name "${named}"; use a stable id`);
    const byId = target.id ? runs.find((run) => run.id === target.id) : undefined;
    if (target.id && !byId) throw new Error(`No subagent id "${target.id}" owned by this parent session`);
    if (named !== undefined && !matches.length) throw new Error(`No subagent named "${named}" in this session`);
    if (byId && named !== undefined && byId.id !== matches[0].id) throw new Error("Subagent id/name mismatch; both must identify the same collaborator");
    return byId ?? matches[0];
  }
  reserve(input: Omit<SubagentRun, "id" | "name" | "parentSessionId" | "parentSessionFile" | "generation" | "state" | "writerToken" | "resultAfterSequence"> & { name: string }): SubagentRun {
    return transaction(this.directory, () => {
      const runs = this.read();
      const base = normalizeSubagentName(input.name);
      let name = base;
      for (let suffix = 2; runs.some((run) => run.name === name); suffix++) {
        const tail = `-${suffix}`;
        name = [...base].slice(0, 64 - tail.length).join("") + tail;
      }
      const run: SubagentRun = { ...input, id: randomUUID(), name, parentSessionId: this.parentSessionId,
        parentSessionFile: this.parentSessionFile, generation: 1, state: "starting", writerToken: randomUUID(), resultAfterSequence: 0 };
      if (run.loadout) claimWriter(run);
      runs.push(run);
      try { replace(this.file, { version: 1, runs }); }
      catch (error) { if (run.loadout) unlinkSync(writerFile(run.sessionFile)); throw error; }
      return run;
    });
  }
  /** Publish intent before any await; repeated stop/suspend never grants a new writer. */
  control(id: string, kind: SubagentControl["kind"]): SubagentRun {
    return transaction(this.directory, () => {
      const runs = this.read();
      const run = runs.find((entry) => entry.id === id);
      if (!run) throw new Error("Subagent is not owned by this parent");
      if (run.control?.kind === "stop" || run.control?.kind === kind) return run;
      run.control = { id: randomUUID(), kind };
      replace(controlFile(run.sessionFile, run.executionId), run.control);
      run.state = kind === "stop" ? "stopping" : "suspending";
      replace(this.file, { version: 1, runs });
      return run;
    });
  }
  /** Called under the inbox publication lock: concurrent instructions share one reservation. */
  messageTarget(id: string): { run: SubagentRun; launch: boolean; waitingForExit?: boolean } {
    return transaction(this.directory, () => {
      const runs = this.read();
      const run = runs.find((entry) => entry.id === id);
      if (!run) throw new Error("Subagent is not owned by this parent");
      if (run.control?.kind === "stop") throw new Error("Subagent explicitly stopped or stopping; history retained, no automatic or message restart. Delegate a fresh named role.");
      if (run.control && !writerExited(run)) throw new Error("Subagent suspension is not confirmed; inspect status before sending more work");
      if (!writerExited(run)) {
        if (!run.writerToken) throw new Error("Legacy writer ownership is uncertain; no request accepted");
        if (existsSync(writerClosingFile(run.sessionFile, run.executionId))) return { run, launch: false, waitingForExit: true };
        const projected = projectRun(run);
        if (run.state !== "starting" && projected.latestResult?.generation === run.generation && projected.latestResult.sequence > run.resultAfterSequence) {
          run.generation++;
          run.resultAfterSequence = projected.latestResult.sequence;
          run.state = "running";
          replace(this.file, { version: 1, runs });
        }
        return { run, launch: false };
      }
      return { run, launch: true };
    });
  }
  /** Reserve before native creation or any await. The inbox lock serializes callers. */
  resume(id: string, generation: number, loadout: SubagentLoadout): SubagentRun {
    return transaction(this.directory, () => {
      const runs = this.read();
      const run = runs.find((entry) => entry.id === id);
      if (run?.control?.kind === "stop") throw new Error("Explicit stop forbids replacement writer; history retained");
      if (!run || run.generation !== generation || run.state === "starting") throw new Error("Subagent busy; this request was not accepted");
      if (run.closure === "unconfirmed") throw new Error("Prior closure remains uncertain; no replacement writer started");
      if (!writerExited(run)) throw new Error("Prior writer is active or uncertain; no replacement started and this request was not accepted");
      Object.assign(run, projectRun(run));
      run.generation++;
      run.executionId = randomUUID();
      run.writerToken = randomUUID();
      run.resultAfterSequence = 0;
      run.loadout = loadout;
      run.state = "starting";
      run.startTime = Date.now();
      delete run.surface;
      delete run.control;
      delete run.closure;
      delete run.diagnostic;
      claimWriter(run);
      replace(this.file, { version: 1, runs });
      return run;
    });
  }
  /** Every callback carries the generation it observed, never just a friendly name. */
  update(id: string, generation: number, patch: Partial<SubagentRun>, controlId?: string): boolean {
    return transaction(this.directory, () => {
      const runs = this.read();
      const run = runs.find((entry) => entry.id === id);
      if (!run || run.generation !== generation || (run.control && run.control.id !== controlId)) return false;
      Object.assign(run, patch);
      replace(this.file, { version: 1, runs });
      return true;
    });
  }
  current(id: string, generation: number): boolean {
    return this.read().some((run) => run.id === id && run.generation === generation);
  }
}

export function writerFile(sessionFile: string): string { return `${sessionFile}.writer.json`; }
export function writerClosingFile(sessionFile: string, executionId: string): string { return `${sessionFile}.closing-${executionId}.json`; }

/** Only the wrapper's observed Pi exit releases a writer, never surface/heartbeat age. */
export function writerExited(run: SubagentRun): boolean {
  return existsSync(processExitFile(run.sessionFile, run.executionId));
}

function claimWriter(run: SubagentRun): void {
  transaction(`${run.sessionFile}.ownership`, () => {
    const file = writerFile(run.sessionFile);
    if (existsSync(file)) {
      const old = JSON.parse(readFileSync(file, "utf8"));
      if (!existsSync(processExitFile(run.sessionFile, old.executionId))) {
        throw new Error("Session writer is active or uncertain; request not accepted");
      }
    }
    replace(file, { executionId: run.executionId, token: run.writerToken, subagentId: run.id });
  });
}

/** The same durable settlement projection drives status and the parent widget. */
export function projectRun(run: SubagentRun): SubagentRun {
  const published = readSubagentOutcomes(run.sessionFile, run.executionId, run.resultAfterSequence, run.generation).at(-1);
  if (!published) {
    return writerExited(run) && ["starting", "running"].includes(run.state)
      ? { ...run, state: "interrupted", diagnostic: "Writer exited without a settled result; history retained, no automatic restart." }
      : run;
  }
  if (run.latestResult?.generation === run.generation && published.result.sequence < run.latestResult.sequence) return run;
  return { ...run, sessionId: published.result.source.sessionId, state: run.control?.kind === "stop" ? run.state : published.result.outcome === "succeeded" ? "completed" : published.result.outcome === "aborted" ? "aborted" : "failed",
    latestResult: { resultFile: published.resultFile, outcome: published.result.outcome, sequence: published.result.sequence, generation: run.generation } };
}
