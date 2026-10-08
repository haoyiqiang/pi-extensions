import { type Static, Type } from "typebox";
import { i18n } from "../state/i18n-bridge.js";
import { LABELS_BY_KIND, ROW_INTENT_META } from "../state/row-intent.js";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * User-facing labels for the three runtime sentinel rows, keyed by their
 * `WrappingSelectItem.kind` discriminator. Sourced from
 * `ROW_INTENT_META` via `LABELS_BY_KIND` (`row-intent.ts`) — single source of
 * truth. Adding a new sentinel requires extending the `WrappingSelectItem`
 * union AND adding an entry to `ROW_INTENT_META`; this map then auto-extends.
 */
export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

/**
 * Labels reserved for Pi-internal sentinels — authoring an option with any
 * of these labels triggers the `reserved_label` runtime guard. Two of the
 * three come from `ROW_INTENT_META` (the runtime kinds); `"Other"` is
 * reserved for CC parity only (the model is conditioned to reach for
 * "Other" in CC; we reject it so the runtime sentinel is the single source
 * of truth) and has no runtime kind.
 *
 * Reserved unconditionally — every question mode rejects these labels, even
 * when a given runtime sentinel is not appended in that mode.
 *
 * Order is pinned by `types.test.ts:292` — keep the explicit
 * `["Other", other, next]` literal so consumers using
 * `RESERVED_LABELS[i]` indexing or `Set` membership see no behavior change.
 */
export const RESERVED_LABELS = ["Other", ROW_INTENT_META.other.label, ROW_INTENT_META.next.label] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export function buildOptionSchema() {
	return Type.Object({
		label: Type.String({
			maxLength: MAX_LABEL_LENGTH,
			description: i18n.t("schema.option_label", { maxLength: MAX_LABEL_LENGTH }),
		}),
		description: Type.String({ description: i18n.t("schema.option_description") }),
		preview: Type.Optional(Type.String({ description: i18n.t("schema.option_preview") })),
	});
}

export function buildQuestionSchema() {
	return Type.Object({
		question: Type.String({ description: i18n.t("schema.question") }),
		header: Type.String({
			maxLength: MAX_HEADER_LENGTH,
			description: i18n.t("schema.header", { maxLength: MAX_HEADER_LENGTH }),
		}),
		options: Type.Array(buildOptionSchema(), {
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: i18n.t("schema.options", { minOptions: MIN_OPTIONS, maxOptions: MAX_OPTIONS }),
		}),
		multiSelect: Type.Optional(Type.Boolean({ default: false, description: i18n.t("schema.multi_select") })),
	});
}

export function buildQuestionsSchema() {
	return Type.Array(buildQuestionSchema(), {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: i18n.t("schema.questions", { maxQuestions: MAX_QUESTIONS }),
	});
}

export function buildQuestionParamsSchema() {
	return Type.Object({ questions: buildQuestionsSchema() });
}

// Compatibility snapshots; runtime registration builds descriptions in the active locale.
export const OptionSchema = buildOptionSchema();
export const QuestionSchema = buildQuestionSchema();
export const QuestionsSchema = buildQuestionsSchema();
export const QuestionParamsSchema = buildQuestionParamsSchema();

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

/**
 * Answer-intent discriminated union. `kind` is the single discriminator —
 * pre-1.0.3 boolean flags have been removed (see `banned-flags.test.ts`).
 * Mirrors the row-side `WrappingSelectItem.kind` vocabulary where possible;
 * `multi` is the multi-select variant (no row-side analog).
 *
 * Variant semantics:
 * - `option`: user picked one of the author-defined options. `answer` is the option's label.
 * - `custom`: user typed free-text via the "Type something." row. `answer` is the typed text or null.
 * - `multi`: user committed multi-select choices. `selected` carries chosen labels; `answer` is null.
 */
export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	/**
	 * Markdown text from the matched option's `preview` field, populated only
	 * when the user lands on a single-select option carrying a `preview`.
	 * Used by `buildQuestionnaireResponse` to echo `selected preview: <preview>`
	 * into the LLM-facing envelope. Undefined for multi-select and custom-text
	 * (`kind: "custom"`) answers.
	 */
	preview?: string;
}

export type QuestionnaireError =
	| "no_ui"
	| "no_custom_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label"
	| "session_load_failed"
	| "stale_module_cache";

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	/**
	 * Global note authored on the Submit tab: `n` opens the shared notes editor there,
	 * and the committed text lives at the `notesByTab[questions.length]` pseudo-index
	 * (a slot no question tab can occupy) until `doneFor` lifts it onto the result —
	 * attached on both submit and cancel, like per-question `answers[].notes`.
	 * Conditional-spread contract, mirroring `QuestionAnswer.notes`: the key appears
	 * only via conditional spread of a non-empty string — never assigned `undefined`,
	 * never kept for an empty/whitespace-only draft — so note-free results stay
	 * byte-identical (`!("globalNote" in result)` holds).
	 */
	globalNote?: string;
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}
