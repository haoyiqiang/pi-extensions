import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Retained settlement evidence, independent of the process and terminal surface. */
export interface SubagentOutcome {
  version: 1;
  executionId: string;
  sequence: number;
  outcome: "succeeded" | "failed" | "aborted" | "truncated" | "no-output";
  output: string;
  errorMessage?: string;
  autoExit: boolean;
  source: {
    kind: "agent_settled" | "process_exit" | "surface_absent";
    sessionFile: string;
    sessionId: string;
    entryId: string | null;
    leafId: string | null;
    stopReason: string | null;
    outputEntryIds: string[];
  };
}

function outcomeDirectory(sessionFile: string, executionId: string): string {
  return join(`${sessionFile}.results`, executionId);
}

/** Publish only a complete file; failures must prevent notification and exit. */
export function writeSubagentOutcome(result: SubagentOutcome): string {
  const file = join(outcomeDirectory(result.source.sessionFile, result.executionId), `${String(result.sequence).padStart(8, "0")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(result), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  return file;
}

/** Do not consume/delete evidence when a parent runtime observes it. */
export function readSubagentOutcomes(sessionFile: string, executionId: string, afterSequence = 0): Array<{ result: SubagentOutcome; resultFile: string }> {
  const directory = outcomeDirectory(sessionFile, executionId);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json") && Number.parseInt(name, 10) > afterSequence).sort().map((name) => {
    const resultFile = join(directory, name);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as SubagentOutcome;
    if (result.version !== 1 || result.executionId !== executionId || typeof result.output !== "string" ||
      !Number.isInteger(result.sequence) || result.sequence < 1 || typeof result.autoExit !== "boolean" ||
      !["succeeded", "failed", "aborted", "truncated", "no-output"].includes(result.outcome) ||
      result.source?.sessionFile !== sessionFile || typeof result.source.sessionId !== "string" ||
      !["agent_settled", "process_exit", "surface_absent"].includes(result.source.kind) || !Array.isArray(result.source.outputEntryIds)) {
      throw new Error(`Invalid subagent outcome: ${resultFile}`);
    }
    return { result, resultFile };
  });
}

/** Shell-level process termination is fallback evidence, not task success. */
export function processExitFile(sessionFile: string, executionId: string): string {
  return `${sessionFile}.process-exit-${executionId}`;
}
