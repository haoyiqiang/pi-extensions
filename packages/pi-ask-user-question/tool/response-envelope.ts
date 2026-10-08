import { i18n } from "../state/i18n-bridge.js";
import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = i18n.t("envelope.decline");
export const ENVELOPE_PREFIX = i18n.t("envelope.prefix");
export const ENVELOPE_SUFFIX = i18n.t("envelope.suffix");

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 * "No segments" means no answers AND no global note — the `global note:` segment is
 * pushed before the zero-segments check, so a note-bearing submit with zero answers
 * still yields the answered envelope.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		// Decline text stays canonical even when a global note rides the cancelled result;
		// the note survives in `details` (like partial `answers`) for replay consumers.
		return buildToolResult(i18n.t("envelope.decline"), {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	// Global note rides after the per-question segments: raw multiline echo (no
	// reformatting), trailing period mirroring `buildAnswerSegment`'s shape.
	if (result.globalNote && result.globalNote.length > 0) {
		segments.push(i18n.t("envelope.global_note", { note: result.globalNote }));
	}
	if (segments.length === 0) {
		return buildToolResult(i18n.t("envelope.decline"), { answers: result.answers, cancelled: true });
	}
	return buildToolResult(`${i18n.t("envelope.prefix")} ${segments.join(" ")} ${i18n.t("envelope.suffix")}`, result);
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(i18n.t("envelope.selected_preview", { preview: a.preview }));
	if (a.notes && a.notes.length > 0) parts.push(i18n.t("envelope.user_notes", { notes: a.notes }));
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
