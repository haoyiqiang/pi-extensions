import { i18n } from "../state/i18n-bridge.js";
import { MAX_QUESTIONS, MIN_OPTIONS, type QuestionnaireError, type QuestionParams, RESERVED_LABELS } from "./types.js";

export const ERROR_NO_QUESTIONS = i18n.t("validation.no_questions");
export const ERROR_TOO_MANY_QUESTIONS = i18n.t("validation.too_many_questions", { maxQuestions: MAX_QUESTIONS });
export const ERROR_DUPLICATE_QUESTION = i18n.t("validation.duplicate_question");
export const ERROR_TOO_FEW_OPTIONS = i18n.t("validation.too_few_options", { minOptions: MIN_OPTIONS });
export const ERROR_RESERVED_LABEL = i18n.t("validation.reserved_label", { labels: RESERVED_LABELS.join(", ") });
export const ERROR_DUPLICATE_OPTION_LABEL = i18n.t("validation.duplicate_option_label");

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

/**
 * Pure runtime validator for `QuestionParams`. Covers every guard except
 * `no_ui` (which depends on `ctx.hasUI` and stays inline at the call site).
 * `reserved_label` MUST short-circuit before `duplicate_option_label`.
 */
export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
	if (typed.questions.length === 0) {
		return { ok: false, error: "no_questions", message: i18n.t("validation.no_questions") };
	}
	if (typed.questions.length > MAX_QUESTIONS) {
		return {
			ok: false,
			error: "too_many_questions",
			message: i18n.t("validation.too_many_questions", { maxQuestions: MAX_QUESTIONS }),
		};
	}

	const seenQuestions = new Set<string>();
	for (const q of typed.questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: i18n.t("validation.duplicate_question") };
		}
		seenQuestions.add(q.question);
	}

	for (const q of typed.questions) {
		if (q.options.length < MIN_OPTIONS) {
			return {
				ok: false,
				error: "empty_options",
				message: i18n.t("validation.too_few_options", { minOptions: MIN_OPTIONS }),
			};
		}
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if (RESERVED_LABEL_SET.has(o.label)) {
				return {
					ok: false,
					error: "reserved_label",
					message: i18n.t("validation.reserved_label", { labels: RESERVED_LABELS.join(", ") }),
				};
			}
			if (seenLabels.has(o.label)) {
				return {
					ok: false,
					error: "duplicate_option_label",
					message: i18n.t("validation.duplicate_option_label"),
				};
			}
			seenLabels.add(o.label);
		}
	}

	return { ok: true };
}
