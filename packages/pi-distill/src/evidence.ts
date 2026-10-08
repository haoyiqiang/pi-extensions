/*
 * Adapted from SoL-Pi's evidence-preserving reducer receipt validation.
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const evidenceI18n = createTranslator(loadCatalog(new URL("./evidence-catalog.json", import.meta.url)));

const EVIDENCE_SCHEMA = "pi-distill-evidence/v1";
const MAX_EVIDENCE_ITEMS = 12;
const MAX_QUOTE_CHARS = 2_000;
const MAX_RAW_BYTES = 64 * 1024;
const EVIDENCE_KINDS = ["fatal", "failure", "warning", "target", "summary"] as const;
const EVIDENCE_KIND_SET = new Set<string>(EVIDENCE_KINDS);
const FAILURE_SIGNAL = /\b(?:errors?|fail(?:ed|ures?|ing|s)?|fatal|exceptions?|panic(?:ked)?|timeouts?|unsolved|type mismatch|assertionerror|traceback|segmentation fault)\b|\bassert(?:ion)?\s+failed\b|npm\s+err!|\bnot ok\b|\bexit(?:ed)?(?:\s+with)?\s+(?:status|code)\s+[1-9]\d*\b|\bnon[- ]zero exit\b/i;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface VerifiedEvidence {
  kind: EvidenceKind;
  quote: string;
  line: number;
  endLine: number;
}

export type EvidenceValidation =
  | { ok: true; evidence: VerifiedEvidence[]; uncertain: boolean; reason?: never }
  | { ok: false; reason: string; evidence?: never; uncertain?: never };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function countLineBreaks(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    // Native read and archived source_lines split on LF, not Unicode/CR separators.
    if (value.charCodeAt(index) === 10) count++;
  }
  return count;
}

function locationOf(body: string, quote: string): { line: number; endLine: number } {
  const index = body.indexOf(quote);
  const line = 1 + countLineBreaks(body.slice(0, index));
  return { line, endLine: line + countLineBreaks(quote) };
}

function stripBenignCounts(value: string): string {
  return value
    .replace(/\b(?:0|zero|no)\s+(?:(?:tests?|checks?|cases?|suites?)\s+)?(?:errors?|failures?|failed(?:\s+(?:tests?|checks?))?)\b/gi, "")
    .replace(/\b(?:errors?|failures?|failed)\s*[:=]\s*0\b/gi, "")
    .replace(/\bwithout\s+(?:errors?|failures?)\b/gi, "");
}

function containsFailureSignal(value: string): boolean {
  return FAILURE_SIGNAL.test(stripBenignCounts(value));
}

function containsStrongFailureSignal(value: string): boolean {
  const text = stripBenignCounts(value);
  return /^\s*(?:FAIL\b|ERROR\b|fatal\b|Traceback\b|not ok\b|npm\s+ERR!|AssertionError\b|panic\b|thread[^\n]*\bpanicked\b)/im.test(text)
    || /\b[1-9]\d*\s+(?:(?:tests?|checks?|cases?|suites?)\s+)?(?:failures?|failed|errors?)\b/i.test(text)
    || /\b(?:failures?|failed|errors?)\s*[:=]\s*[1-9]\d*\b/i.test(text)
    || /\b(?:assert(?:ion)?\s+failed|panicked\s+at|segmentation fault|non[- ]zero exit)\b/i.test(text)
    || /\bexit(?:ed)?(?:\s+with)?\s+(?:status|code)\s+[1-9]\d*\b/i.test(text);
}

export function buildEvidencePrompt(body: string, focus: string): string {
  return evidenceI18n.t("prompt", {
    focus: JSON.stringify(focus),
    body: JSON.stringify(body),
  });
}

export function validateEvidence(raw: string, body: string, isError: boolean): EvidenceValidation {
  if (typeof raw !== "string") return { ok: false, reason: "invalid-response" };
  if (Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES) return { ok: false, reason: "response-too-large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (
    !isRecord(parsed)
    || !hasExactKeys(parsed, ["schema", "uncertain", "evidence"])
    || parsed.schema !== EVIDENCE_SCHEMA
    || typeof parsed.uncertain !== "boolean"
    || !Array.isArray(parsed.evidence)
  ) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (parsed.evidence.length === 0) return { ok: false, reason: "empty-evidence" };
  if (parsed.evidence.length > MAX_EVIDENCE_ITEMS) return { ok: false, reason: "too-many-evidence-items" };

  const evidence: VerifiedEvidence[] = [];
  const seen = new Set<string>();
  for (const item of parsed.evidence) {
    if (!isRecord(item) || !hasExactKeys(item, ["kind", "quote"])) {
      return { ok: false, reason: "schema-mismatch" };
    }
    const { kind, quote } = item;
    if (typeof kind !== "string" || !EVIDENCE_KIND_SET.has(kind)) {
      return { ok: false, reason: "invalid-evidence-kind" };
    }
    if (typeof quote !== "string" || quote.trim().length === 0) {
      return { ok: false, reason: "empty-quote" };
    }
    if (unicodeLength(quote) > MAX_QUOTE_CHARS) {
      return { ok: false, reason: "quote-too-long" };
    }
    if (!body.includes(quote)) {
      return { ok: false, reason: "unverifiable-quote" };
    }

    const evidenceKind = kind as EvidenceKind;
    const key = `${evidenceKind}\0${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({ kind: evidenceKind, quote, ...locationOf(body, quote) });
  }

  if (
    (isError ? containsFailureSignal(body) : containsStrongFailureSignal(body))
    && !evidence.some((item) =>
      (item.kind === "fatal" || item.kind === "failure") && (isError ? containsFailureSignal(item.quote) : containsStrongFailureSignal(item.quote))
    )
  ) {
    return { ok: false, reason: "missing-failure-signal-evidence" };
  }

  return { ok: true, evidence, uncertain: parsed.uncertain };
}

function kindLabel(kind: EvidenceKind): string {
  const keys: Record<EvidenceKind, string> = {
    fatal: "kindFatal",
    failure: "kindFailure",
    warning: "kindWarning",
    target: "kindTarget",
    summary: "kindSummary",
  };
  return evidenceI18n.t(keys[kind]);
}

export function formatEvidence(evidence: VerifiedEvidence[], uncertain: boolean): string {
  const lines = evidence.map((item) => {
    const location = item.line === item.endLine
      ? evidenceI18n.t("line", { line: item.line })
      : evidenceI18n.t("lineRange", { line: item.line, endLine: item.endLine });
    return evidenceI18n.t("evidenceItem", {
      kind: kindLabel(item.kind),
      location,
      quote: JSON.stringify(item.quote),
    });
  });
  lines.push(evidenceI18n.t(uncertain ? "uncertainTrue" : "uncertainFalse"));
  lines.push(evidenceI18n.t("completenessDisclaimer"));
  return lines.join("\n");
}
