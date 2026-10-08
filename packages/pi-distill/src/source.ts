/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Fusion log selection and native Bash spool handling adapted from NVlabs/SoL-Pi candidate.ts.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative } from "node:path";
import type { SourceKind } from "./archive.ts";
import { isMutationTool } from "./processing-config.ts";

export type ProcessingResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: { [key: string]: unknown };
  isError?: boolean;
};
export interface SourceScope {
  inline: string;
  command?: string;
  details?: Record<string, unknown>;
  nativeBash: boolean;
  project: (receipt: string) => ProcessingResult;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Select only a final command block; skipped mutations and ambiguous marker boundaries fail open. */
export function selectSourceScope(toolName: string, params: Record<string, unknown>, result: ProcessingResult): SourceScope | undefined {
  if (!isMutationTool(toolName)) {
    return {
      inline: result.content.map((part) => part.text ?? "").join("\n"),
      command: toolName === "bash" && typeof params.command === "string" ? params.command : undefined,
      details: result.details,
      nativeBash: toolName === "bash",
      project: (receipt) => ({ ...result, content: [{ type: "text", text: receipt }] }),
    };
  }
  const thenRun = record(params.then_run);
  if (typeof thenRun?.command !== "string" || !thenRun.command.trim()) return undefined;
  const allText = result.content.map((part) => part.text ?? "").join("\n");
  if (/(?:^|\n)\[then_run:(?:skipped|running)\]/.test(allText)) return undefined;
  const marker = result.isError ? "[then_run:failed]" : "[then_run:succeeded]";
  const matches: Array<{ index: number; start: number; end: number }> = [];
  for (const [index, part] of result.content.entries()) {
    if (part.type !== "text" || typeof part.text !== "string") return undefined;
    const pattern = new RegExp(`(?:^|\\n)${marker.replace(/[\[\]]/g, "\\$&")}(?=\\r?\\n|$)`, "g");
    for (const match of part.text.matchAll(pattern)) {
      const markerEnd = match.index! + match[0].length;
      const separator = part.text.slice(markerEnd).match(/^\r?\n/)?.[0] ?? "";
      matches.push({ index, start: match.index!, end: markerEnd + separator.length });
    }
  }
  if (matches.length !== 1 || matches[0].index !== result.content.length - 1) return undefined;
  const { index, start, end } = matches[0];
  const part = result.content[index];
  const fusion = record(result.details?.actionFusion);
  if (!result.isError && (start !== 0 || fusion?.status !== "succeeded" || fusion.command !== thenRun.command)) return undefined;
  const prefix = part.text!.slice(0, end);
  return {
    inline: part.text!.slice(end),
    command: thenRun.command,
    details: record(fusion?.bashDetails),
    nativeBash: true,
    project: (receipt) => ({
      ...result,
      content: result.content.map((block, position) => position === index ? { ...block, text: `${prefix}${prefix.endsWith("\n") ? "" : "\n"}${receipt}` } : block),
    }),
  };
}

/** Only split unquoted command boundaries. This is intentionally not a shell interpreter. */
function shellSegments(command: string): string[][] {
  if (command.length > 8192 || /[`]|\$\(|<<|\0/.test(command)) return [];
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  const flushWord = () => { if (word) words.push(word); word = ""; };
  const flushSegment = () => { flushWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    // Process substitution runs an independent producer/consumer outside the
    // visible diagnostic segment; quoted literal forms are harmless data.
    if ((char === "<" || char === ">") && command[i + 1] === "(") return [];
    if (char === "#" && !word) { while (i < command.length && command[i] !== "\n") i++; flushSegment(); continue; }
    if (char === "&" || char === "|" || char === ";" || char === "\n") { flushSegment(); continue; }
    if (/\s/.test(char)) flushWord();
    else word += char;
  }
  if (quote || escaped) return [];
  flushSegment();
  return segments;
}

export function isDiagnosticCommand(command: string, additional: readonly string[] = []): boolean {
  const segments = shellSegments(command);
  let hasDiagnostic = false;
  const allAllowed = segments.every((original) => {
    // Setup segments must not emit unrelated output. Compound commands such as
    // npm test; cat confidential.txt are not eligible for automatic evidence.
    if (original.every((token) => /^[A-Za-z_][A-Za-z_\d]*=/.test(token))) return true;
    if (original.length === 1 && ["true", ":"].includes(original[0])) return true;
    if (original[0] === "cd" && (original.length === 2 || (original.length === 3 && original[1] === "--"))) return true;
    const diagnostic = (() => {
    let words = [...original];
    if (words[0] === "env") words.shift();
    while (/^[A-Za-z_][A-Za-z_\d]*=/.test(words[0] ?? "")) words.shift();
    if (words[0] === "rtk") words.shift();
    if (!words.length) return false;
    words[0] = basename(words[0]).replace(/\.(?:cmd|exe)$/, "");
    const [program, arg, next] = words;
    const scripts = /^(?:test|build|check|lint|typecheck)(?::[^\s]+)?$/;
    if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
      const args = words.slice(1);
      // Common flags with arguments before the script, without guessing arbitrary shell expansion.
      while (args[0]?.startsWith("-")) {
        const flag = args.shift()!;
        if (["--workspace", "-w", "--filter", "-F", "--prefix", "-C", "--cwd"].includes(flag)) args.shift();
      }
      if (args[0] === "run" || args[0] === "run-script") args.shift();
      if (scripts.test(args[0] ?? "")) return true;
    }
    if (["pytest", "ctest", "make", "ninja", "tsc", "vitest", "jest", "eslint"].includes(program)) return true;
    if (/^python(?:\d+(?:\.\d+)?)?$/.test(program) && arg === "-m" && ["pytest", "unittest"].includes(next)) return true;
    if ((program === "go" && arg === "test") || (program === "cargo" && ["test", "build", "check", "clippy"].includes(arg))) return true;
    if ((program === "cmake" && arg === "--build") || (["zig", "lake", "bazel"].includes(program) && ["build", "test"].includes(arg))) return true;
    return additional.some((prefix) => {
      const parsed = shellSegments(prefix);
      return parsed.length === 1 && parsed[0].length > 0 && parsed[0].every((token, i) => token === words[i]);
    });
    })();
    hasDiagnostic ||= diagnostic;
    return diagnostic;
  });
  return allAllowed && hasDiagnostic;
}

export const LIKELY_SECRET = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|(?:authorization\s*:\s*bearer\s+|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?)[A-Za-z0-9_./+=-]{12,}/i;

async function boundedTempText(path: string, nativeBash: boolean, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(path) || (nativeBash && !/^pi-bash-[^/\\]+\.log$/.test(basename(path)))) throw new Error("untrusted-source-path");
  const root = await realpath(tmpdir());
  const resolved = await realpath(path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || (nativeBash && dirname(resolved) !== root)) throw new Error("untrusted-source-path");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new Error("invalid-source-file");
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || current.size > maxBytes) throw new Error("source-file-changed");
    const buffer = Buffer.alloc(Math.min(current.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== current.dev || after.ino !== current.ino
      || length !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error("source-file-changed");
    // Reject malformed UTF-8 instead of silently altering the archived source.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

export async function loadSource(scope: SourceScope, maxBytes: number, signal?: AbortSignal): Promise<{ body: string; kind: SourceKind; suffix: string }> {
  signal?.throwIfAborted();
  const metadataPath = typeof scope.details?.fullOutputPath === "string" ? scope.details.fullOutputPath : undefined;
  // Error normalization can remove Bash details. Accept only a native spool-shaped footer, never arbitrary paths in log prose.
  const footer = scope.nativeBash ? scope.inline.match(/\n\n\[Showing (?:lines|last) [^\r\n]*?Full output: ([^\]\r\n]+)\](?:\n\nCommand (?:exited with code \d+|aborted|timed out after [^\n]+|terminated without an exit code))?\s*$/) : undefined;
  const candidate = metadataPath ?? footer?.[1];
  if (candidate) {
    const body = await boundedTempText(candidate, scope.nativeBash, maxBytes, signal);
    const status = scope.nativeBash ? scope.inline.match(/\n\n(Command (?:exited with code \d+|aborted|timed out after [^\n]+|terminated without an exit code))\s*$/)?.[1] : undefined;
    return { body, kind: "full-log", suffix: status ? `\n\n${status}` : "" };
  }
  const truncation = record(scope.details?.truncation);
  const preview = scope.details?.outputTruncated === true || truncation?.truncated === true || /\n\n\[(?:Showing (?:lines|last)|Output truncated)/.test(scope.inline);
  if (Buffer.byteLength(scope.inline, "utf8") > maxBytes) throw new Error("source-over-budget");
  return { body: scope.inline, kind: preview ? "preview" : "tool-output", suffix: "" };
}
