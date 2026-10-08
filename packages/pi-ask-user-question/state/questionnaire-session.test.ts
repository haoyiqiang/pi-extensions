import { setImmediate as nextTask } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@maplezzk/pi-test-utils/rpiv";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";

const params: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

function itemsFor(value: QuestionParams): WrappingSelectItem[][] {
	return value.questions.map((question) => [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other" as const, label: "Type something." },
	]);
}

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.input.newLine":
				return data === SHIFT_ENTER;
			case "tui.editor.cursorUp":
				return data === UP;
			case "tui.editor.cursorDown":
				return data === DOWN;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

interface SessionTestOptions {
	params?: QuestionParams;
	itemsByTab?: WrappingSelectItem[][];
	editInput?: (value: string, signal: AbortSignal) => Promise<string | undefined>;
	keybindings?: typeof keybindings;
	signal?: AbortSignal;
}

function makeSession(options: SessionTestOptions = {}) {
	const sessionParams = options.params ?? params;
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
		theme: makeTheme() as unknown as Theme,
		params: sessionParams,
		itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
		done,
		keybindings: options.keybindings ?? keybindings,
		editInput: options.editInput ?? (async () => undefined),
		signal: options.signal ?? new AbortController().signal,
		collapseKey: "off",
		canReopenWhileHidden: false,
	});
	return { session, done };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

describe("QuestionnaireSession — custom-answer drafts", () => {
	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("submits a multiline custom answer composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		const view = session.component.render(120).join("\n");
		expect(view).toContain("first line");
		expect(view).toContain("second line");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("uses vertical arrows within the draft and returns to row navigation at the boundary", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch("!");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("opens an owned editor view and applies its multiline draft on configured confirm", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("inline");
		session.dispatch(CTRL_G);
		session.component.handleInput(SHIFT_ENTER);
		session.component.handleInput("child");
		expect(session.component.render(120).join("\n")).toContain("child");
		session.component.handleInput(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "inline\nchild" })],
			cancelled: false,
		});
	});

	it("abandons the editor subview with Esc without mutating the inline draft", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("inline");
		session.dispatch(CTRL_G);
		session.component.handleInput(" discarded");
		session.component.handleInput(ESC);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "inline" })],
			cancelled: false,
		});
	});

	it("commits expanded multiline paste content from the editor subview", () => {
		const pasted = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch(CTRL_G);
		session.component.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		session.component.handleInput(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: pasted })],
			cancelled: false,
		});
	});

	it("uses the second Ctrl+G to replace the child draft through the external editor", async () => {
		const editInput = vi.fn(async (value: string) => `${value} + edited`);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		session.component.handleInput(CTRL_G);
		await nextTask();
		expect(editInput).toHaveBeenCalledWith("draft", expect.any(AbortSignal));
		session.component.handleInput(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});

	it("closes completion before a late external result and waits for cleanup before done", async () => {
		let resolveEditor!: (value: string | undefined) => void;
		const editInput = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				}),
		);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		session.component.handleInput(CTRL_G);

		const cancelling = session.cancelExternal();
		expect(done).not.toHaveBeenCalled();
		resolveEditor("late edit");
		await cancelling;
		session.component.handleInput(ENTER);

		expect(done).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledWith({ answers: [], cancelled: true });
	});

	it("attaches multiline notes composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		session.dispatch("n");
		session.dispatch("first note");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second note");
		session.dispatch(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
			cancelled: false,
		});
	});

	it("commits the typed draft with a remapped tui.input.submit key (#156)", () => {
		// Slack-style config: enter is folded into tui.input.newLine (colliding with
		// the default tui.select.confirm), submit lives on its own key. The submit
		// key must confirm the custom answer instead of falling through to the
		// editor, whose own submit handling would wipe the draft.
		const CTRL_ENTER = "<CTRL_ENTER>";
		const remapped: typeof keybindings = {
			matches(data: string, name: string): boolean {
				if (name === "tui.input.submit") return data === CTRL_ENTER;
				if (name === "tui.input.newLine") return data === ENTER || data === SHIFT_ENTER;
				return keybindings.matches(data, name);
			},
		};
		const { session, done } = makeSession({ keybindings: remapped });
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		session.dispatch(CTRL_ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("a raw Enter byte the router does not match cannot wipe the draft via the editor's own submit (#156)", () => {
		// The session fake matches only the <ENTER> sentinel, so a raw "\r" reaches
		// the headless Editor, whose GLOBAL keybindings still bind tui.input.submit
		// to enter. Without disableSubmit, Editor.submitValue() would reset the
		// buffer and silently destroy the draft.
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("precious draft");
		session.dispatch("\r");
		expect(session.component.render(120).join("\n")).toContain("precious draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "precious draft" })],
			cancelled: false,
		});
	});

	it("keeps each question's latest draft isolated through real navigation and tab switches", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: multiParams });

		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch("-latest");
		session.dispatch(ENTER);

		focusCustomAnswer(session);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("first-latest");

		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("second");
	});
});

describe("QuestionnaireSession — collapsed row with collapseKey 'off'", () => {
	it("renders the cancel-only line, never a literal 'Off to expand' (#176)", () => {
		// The router and raw listener never collapse when off, but
		// toggleCollapsedExternal() is a public ungated entry — the collapsed row
		// must not advertise a disabled shortcut if a caller forces it.
		const { session } = makeSession();
		session.toggleCollapsedExternal();
		const collapsed = session.component.render(120);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("Esc to cancel");
		expect(collapsed[0]).not.toContain("to expand");
		expect(collapsed[0]).not.toContain("Off");
	});
});
