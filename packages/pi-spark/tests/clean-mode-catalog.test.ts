// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readLocale(locale: "zh-CN" | "en-US"): Record<string, string> {
	return JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), "utf8"));
}

test("per-locale catalog keys match and every message is non-empty", () => {
	const chinese = readLocale("zh-CN");
	const english = readLocale("en-US");
	const keys = Object.keys(english).sort();
	assert.ok(keys.length > 0, "catalog 不应为空");
	assert.deepEqual(Object.keys(chinese).sort(), keys);
	for (const key of keys) {
		assert.ok(english[key].trim().length > 0, `${key} 的 en-US 文案为空`);
		assert.ok(chinese[key].trim().length > 0, `${key} 的 zh-CN 文案为空`);
	}
});
