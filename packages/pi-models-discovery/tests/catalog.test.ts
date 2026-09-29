import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { buildModel, modelMatchesDiscovery } from "../src/index.ts";

test("locales catalog provides zh-CN and en-US for every key", () => {
	const catalog = JSON.parse(
		readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
	) as Record<string, Record<string, string>>;
	for (const [key, entry] of Object.entries(catalog)) {
		assert.ok(typeof entry["zh-CN"] === "string" && entry["zh-CN"].length > 0, `${key} missing zh-CN`);
		assert.ok(typeof entry["en-US"] === "string" && entry["en-US"].length > 0, `${key} missing en-US`);
	}
});

test("default export is an extension factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});

test("discovered models expose xhigh and max thinking levels", () => {
	const model = buildModel("some-model", undefined, undefined, undefined, undefined) as unknown as Model<Api>;
	assert.deepEqual(getSupportedThinkingLevels(model), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});

test("model discovery include/exclude 使用整串 glob 匹配", () => {
	const options = {
		include: ["gpt-5.6-*", "gpt-6-*"],
		exclude: ["*-image-*"],
	};
	assert.equal(modelMatchesDiscovery("gpt-5.6-sol", options), true);
	assert.equal(modelMatchesDiscovery("gpt-6-astra", options), true);
	assert.equal(modelMatchesDiscovery("gpt-image-2.5", options), false);
	assert.equal(modelMatchesDiscovery("gpt-5.5", options), false);
});

test("discovery defaults 可统一修正思考映射和模型元数据", () => {
	const model = buildModel(
		"gpt-5.6-sol",
		undefined,
		undefined,
		undefined,
		{ supportsStrictMode: false },
		{
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			contextWindow: 1_050_000,
			maxTokens: 128_000,
			compat: { supportsDeveloperRole: false },
		},
	) as unknown as Model<Api>;

	assert.equal(model.contextWindow, 1_050_000);
	assert.equal(model.maxTokens, 128_000);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(getSupportedThinkingLevels(model), [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	assert.equal(model.compat?.supportsStrictMode, false);
});
