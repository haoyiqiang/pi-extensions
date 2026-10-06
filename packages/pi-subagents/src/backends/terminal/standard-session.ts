import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { i18n } from "../../i18n.js";
import { readSessionSnapshot } from "../session-reader.js";
import type { SessionBranchEntry, TranscriptMessage } from "../session.js";
import type { PersistentSessionReference } from "../session-reference.js";
import { compileInvocationSchema } from "../invocation-policy.js";
import { assertPromptBindingMatches } from "../prompt-binding.js";
import type { ExecutionRestoreOptions } from "../types.js";
import { validateStandardTerminalPolicy, type StandardTerminalPolicy } from "./standard-policy.js";

const recordPath = (sessionFile: string) => `${sessionFile}.pi-subagents-terminal.json`;

interface StandardTerminalRecord {
  version: 1;
  reference: PersistentSessionReference<"terminal">;
  policy: StandardTerminalPolicy;
}

export interface StandardSessionSnapshot {
  readonly branch: readonly SessionBranchEntry[];
  readonly messages: readonly TranscriptMessage[];
}

function fail(key: string): never { throw new Error(i18n.t(key)); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function readHeader(sessionFile: string): { id: string; cwd: string } {
  let first: string;
  try { first = readFileSync(sessionFile, "utf8").split("\n", 1)[0] ?? ""; }
  catch { return fail("sessionStore.invalidFile"); }
  try {
    const header: unknown = JSON.parse(first);
    if (!object(header) || header.type !== "session" || header.version !== 3
      || !nonEmpty(header.id) || !nonEmpty(header.cwd)) fail("sessionStore.invalidFile");
    return { id: header.id, cwd: header.cwd };
  } catch { return fail("sessionStore.invalidFile"); }
}

function canonicalReference(reference: PersistentSessionReference): PersistentSessionReference<"terminal"> {
  if (!reference || reference.backend !== "terminal" || !nonEmpty(reference.sessionId)
    || !nonEmpty(reference.sessionFile) || !isAbsolute(reference.sessionFile)) fail("sessionStore.invalidRecord");
  let sessionFile: string;
  try { sessionFile = realpathSync(reference.sessionFile); }
  catch { return fail("sessionStore.invalidFile"); }
  const header = readHeader(sessionFile);
  if (header.id !== reference.sessionId) fail("sessionStore.invalidRecord");
  return Object.freeze({ backend: "terminal", sessionId: header.id, sessionFile });
}

function snapshotPolicy(value: unknown): StandardTerminalPolicy {
  try {
    validateStandardTerminalPolicy(value);
    return Object.freeze({
      ...value,
      ...(value.promptBinding ? { promptBinding: Object.freeze({ ...value.promptBinding }) } : {}),
      ...(value.model ? { model: Object.freeze({ ...value.model }) } : {}),
      agent: Object.freeze({
        ...value.agent,
        ...(value.agent.builtinToolNames ? { builtinToolNames: [...value.agent.builtinToolNames] } : {}),
        ...(value.agent.extSelectors ? { extSelectors: [...value.agent.extSelectors] } : {}),
        ...(value.agent.disallowedTools ? { disallowedTools: [...value.agent.disallowedTools] } : {}),
        ...(Array.isArray(value.agent.extensions) ? { extensions: [...value.agent.extensions] } : {}),
        ...(value.agent.excludeExtensions ? { excludeExtensions: [...value.agent.excludeExtensions] } : {}),
        ...(Array.isArray(value.agent.skills) ? { skills: [...value.agent.skills] } : {}),
        ...(Array.isArray(value.agent.allowedSubagents) ? { allowedSubagents: [...value.agent.allowedSubagents] } : {}),
      }),
      tools: Object.freeze([...value.tools]),
      ...(value.nested ? { nested: Object.freeze({ ...value.nested }) } : {}),
      ...(value.structuredSchema ? { structuredSchema: Object.freeze({ ...value.structuredSchema }) } : {}),
    });
  } catch { return fail("sessionStore.invalidRecord"); }
}

function writeRecord(reference: PersistentSessionReference<"terminal">, policy: StandardTerminalPolicy): void {
  const record: StandardTerminalRecord = { version: 1, reference, policy };
  writeFileSync(recordPath(reference.sessionFile), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function createStandardTerminalSession(
  policy: StandardTerminalPolicy,
  sessionDir: string,
): PersistentSessionReference<"terminal"> {
  validateStandardTerminalPolicy(policy);
  if (!isAbsolute(sessionDir)) fail("terminalBackend.invalidConfig");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionId = randomUUID();
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: policy.cwd };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
  const reference = Object.freeze({ backend: "terminal" as const, sessionId, sessionFile });
  writeRecord(reference, policy);
  return reference;
}

/** Adopt an ordinary Pi session supplied through RunOptions.resumeSessionFile. */
export function adoptStandardTerminalSession(
  sessionFile: string,
  policy: StandardTerminalPolicy,
): PersistentSessionReference<"terminal"> {
  if (!isAbsolute(sessionFile)) fail("sessionStore.invalidFile");
  let canonical: string;
  try { canonical = realpathSync(sessionFile); }
  catch { return fail("sessionStore.invalidFile"); }
  const header = readHeader(canonical);
  if (resolve(header.cwd) !== resolve(policy.cwd)) fail("sessionStore.invalidFile");
  const reference = Object.freeze({ backend: "terminal" as const, sessionId: header.id, sessionFile: canonical });
  writeRecord(reference, policy);
  return reference;
}

export function openStandardTerminalSession(
  reference: PersistentSessionReference,
  options: ExecutionRestoreOptions = {},
): { reference: PersistentSessionReference<"terminal">; policy: StandardTerminalPolicy } {
  const canonical = canonicalReference(reference);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(recordPath(canonical.sessionFile), "utf8")); }
  catch { return fail("sessionStore.invalidRecord"); }
  if (!object(raw) || raw.version !== 1 || !object(raw.reference)) fail("sessionStore.invalidRecord");
  const stored = canonicalReference(raw.reference as unknown as PersistentSessionReference);
  if (stored.sessionFile !== canonical.sessionFile || stored.sessionId !== canonical.sessionId) fail("sessionStore.invalidRecord");
  const policy = snapshotPolicy(raw.policy);
  assertPromptBindingMatches(policy.promptBinding, options.promptBinding);
  if (policy.structuredSchema === undefined) {
    if (options.structuredOutput !== undefined) fail("sessionStore.schemaMismatch");
  } else {
    if (!options.structuredOutput || typeof options.structuredOutput.check !== "function") fail("sessionStore.validatorRequired");
    if (!isDeepStrictEqual(compileInvocationSchema(options.structuredOutput.schema).schema, policy.structuredSchema)) {
      fail("sessionStore.schemaMismatch");
    }
  }
  if (resolve(readHeader(canonical.sessionFile).cwd) !== resolve(policy.cwd)) fail("sessionStore.invalidFile");
  return { reference: canonical, policy };
}

export function forkStandardTerminalSession(
  source: PersistentSessionReference,
  policy: StandardTerminalPolicy,
  sessionDir: string,
): PersistentSessionReference<"terminal"> {
  const canonical = canonicalReference(source);
  const snapshot = readStandardSessionSnapshot(canonical.sessionFile, policy.cwd);
  const reference = createStandardTerminalSession(policy, sessionDir);
  const manager = SessionManager.inMemory(policy.cwd, {
    id: reference.sessionId,
    parentSession: canonical.sessionFile,
  }, snapshot.branch as FileEntry[]);
  const contents = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(reference.sessionFile, contents, { mode: 0o600 });
  writeRecord(reference, policy);
  return reference;
}

export function readStandardSessionSnapshot(sessionFile: string, cwd?: string): StandardSessionSnapshot {
  try {
    const snapshot = readSessionSnapshot(sessionFile, cwd);
    return { branch: Object.freeze(snapshot.branch), messages: Object.freeze(snapshot.messages) };
  } catch { return fail("sessionStore.invalidFile"); }
}

/** Remove only backend-owned ephemeral artifacts after the handle retires. */
export function removeStandardTerminalSession(reference: PersistentSessionReference<"terminal">): void {
  rmSync(reference.sessionFile, { force: true });
  rmSync(recordPath(reference.sessionFile), { force: true });
  rmSync(`${reference.sessionFile}.exit`, { force: true });
}


export function hasStandardTerminalRecord(sessionFile: string): boolean {
  return existsSync(recordPath(sessionFile));
}
