import { applyLocale } from "pi-utils";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../state/i18n-bridge.js";
import { QuestionParamsSchema } from "../tool/types.js";

const schemaText = () => JSON.stringify(QuestionParamsSchema);

afterEach(() => applyLocale("en-US"));

describe("bilingual catalog", () => {
	it("contains English and Simplified Chinese for UI, agent guidance, schema, and failures", () => {
		applyLocale("en-US");
		expect(i18n.t("sentinel.other")).toBe("Type something.");
		expect(i18n.t("tool.label")).toBe("Ask User Question");
		expect(i18n.t("error.no_ui")).toContain("UI not available");
		expect(schemaText()).toContain("Concise display label");

		applyLocale("zh-CN");
		expect(i18n.t("sentinel.other")).toBe("输入内容");
		expect(i18n.t("tool.label")).toBe("向用户提问");
		expect(i18n.t("error.no_ui")).toContain("没有可用 UI");
	});

	it("resolves render-time strings from the live locale", () => {
		applyLocale("en-US");
		expect(i18n.t("preview.notes_affordance")).toContain("Notes");
		applyLocale("zh-CN");
		expect(i18n.t("preview.notes_affordance")).toContain("备注");
	});
});
