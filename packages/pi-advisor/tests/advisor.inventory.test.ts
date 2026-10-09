import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getInventoryMessage, stableStringify } from "./advisor-test-state.js";

const tool = (overrides: Partial<ToolInfo>): ToolInfo =>
	({
		name: "t",
		description: "desc",
		parameters: { type: "object", properties: {}, required: [] },
		sourceInfo: { path: "/some/path" },
		...overrides,
	}) as ToolInfo;

describe("stableStringify", () => {
	it("returns JSON.stringify for primitives + null", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(42)).toBe("42");
		expect(stableStringify("x")).toBe('"x"');
		expect(stableStringify(true)).toBe("true");
	});
	it("sorts object keys recursively", () => {
		expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
	});
	it("drops undefined properties in objects", () => {
		expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
	});
	it("emits null for undefined in arrays", () => {
		expect(stableStringify([1, undefined, 2])).toBe("[1,null,2]");
	});
	it("produces same string for differently-inserted same-key objects", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
	});
});

describe("getInventoryMessage", () => {
	it("returns undefined when tool list is empty", () => {
		expect(getInventoryMessage([])).toBeUndefined();
	});
	it("rebuilds across calls so same-name tools cannot reuse stale descriptions or schemas", () => {
		const first = getInventoryMessage([
			tool({ name: "shared", description: "root description", parameters: { type: "object", properties: { root: { type: "string" } } } as never }),
		]);
		const second = getInventoryMessage([
			tool({ name: "shared", description: "child description", parameters: { type: "object", properties: { child: { type: "number" } } } as never }),
		]);
		const firstText = (first!.content[0] as { type: "text"; text: string }).text;
		const secondText = (second!.content[0] as { type: "text"; text: string }).text;
		expect(second).not.toBe(first);
		expect(firstText).toContain("root description");
		expect(firstText).toContain('"root":{"type":"string"}');
		expect(secondText).toContain("child description");
		expect(secondText).toContain('"child":{"type":"number"}');
		expect(secondText).not.toContain("root description");
		expect(secondText).not.toContain('"root"');
	});
	it("renders inventory body with sorted stableStringified params", () => {
		const m = getInventoryMessage([tool({ name: "b", parameters: { b: 1, a: 2 } as never }), tool({ name: "a" })]);
		const text = (m!.content[0] as { type: "text"; text: string }).text;
		expect(text.indexOf("### a")).toBeLessThan(text.indexOf("### b"));
		expect(text).toContain('{"a":2,"b":1}');
	});
});
