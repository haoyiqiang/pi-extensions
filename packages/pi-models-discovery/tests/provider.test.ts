import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, ModelsPublication } from "@earendil-works/pi-ai";
import { createDiscoveryProvider, type DiscoveryProviderEntry } from "../src/index.ts";

const ENTRY = {
	id: "proxy",
	baseUrl: "https://proxy.example/v1",
	api: "openai-responses",
} satisfies DiscoveryProviderEntry;

/** 契约形状的 refreshModels 上下文：记录 publish 调用，便于断言持久化与状态更新 */
function refreshContext(options: { allowNetwork: boolean; stored?: readonly Model<Api>[] }) {
	const published: ModelsPublication[] = [];
	return {
		published,
		context: {
			allowNetwork: options.allowNetwork,
			signal: new AbortController().signal,
			stored: options.stored ? { models: options.stored } : undefined,
			publish: async (publication: ModelsPublication) => {
				published.push(publication);
				publication.update?.();
				return true;
			},
		},
	};
}

function remoteModels(ids: string[]): Model<Api>[] {
	return ids.map((id) => ({
		id,
		name: id,
		provider: ENTRY.id,
		api: ENTRY.api as Api,
		baseUrl: ENTRY.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	}));
}

test("refreshModels 在线刷新后持久化并更新目录", async () => {
	const provider = createDiscoveryProvider(ENTRY, [], []);
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), { status: 200 })) as typeof fetch;
	try {
		const { context, published } = refreshContext({ allowNetwork: true });
		await provider.refreshModels!(context);
		assert.deepEqual(provider.getModels().map((model) => model.id), ["a", "b"]);
		assert.deepEqual(published.map((entry) => "persist" in entry), [true]);
		assert.equal(published[0]?.persist?.models.length, 2);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("拉取失败保留上一份目录并抛错", async () => {
	const provider = createDiscoveryProvider(ENTRY, remoteModels(["a"]), []);
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
	try {
		await assert.rejects(provider.refreshModels!(refreshContext({ allowNetwork: true }).context));
		assert.deepEqual(provider.getModels().map((model) => model.id), ["a"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("离线恢复只接受与当前端点、api、过滤规则兼容的模型", async () => {
	const provider = createDiscoveryProvider({ ...ENTRY, modelDiscovery: { exclude: ["*-image"] } }, [], []);
	const stored = [
		...remoteModels(["keep"]),
		...remoteModels(["drop-image"]),
		{ ...remoteModels(["other-api"])[0]!, api: "anthropic-messages" as Api },
		{ ...remoteModels(["other-host"])[0]!, baseUrl: "https://elsewhere.example/v1" },
	];
	const { context } = refreshContext({ allowNetwork: false, stored });
	await provider.refreshModels!(context);
	assert.deepEqual(provider.getModels().map((model) => model.id), ["keep"]);
});

test("runtime：凭据由 pi 解析后在线刷新写回 models store，离线可恢复", async () => {
	const { createModels, InMemoryCredentialStore, InMemoryModelsStore } = await import("@earendil-works/pi-ai");
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(ENTRY.id, async () => ({ type: "api_key", key: "sk-test" }));
	const store = new InMemoryModelsStore();
	const models = createModels({ credentials, modelsStore: store });
	models.setProvider(createDiscoveryProvider(ENTRY, [], []));

	const realFetch = globalThis.fetch;
	const seenAuth: (string | undefined)[] = [];
	globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
		seenAuth.push(init?.headers?.Authorization);
		return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), { status: 200 });
	}) as typeof fetch;
	try {
		const result = await models.refresh({ providers: [ENTRY.id], allowNetwork: true });
		assert.equal(result.errors.size, 0);
		assert.deepEqual(seenAuth, ["Bearer sk-test"]);
		assert.deepEqual((await store.read(ENTRY.id))?.models.map((model) => model.id), ["a", "b"]);

		// 新 runtime 共用同一 store：不联网也能从已存目录恢复
		const offline = createModels({ credentials, modelsStore: store });
		offline.setProvider(createDiscoveryProvider(ENTRY, [], []));
		await offline.refresh({ providers: [ENTRY.id], allowNetwork: false });
		assert.deepEqual(offline.getModels(ENTRY.id).map((model) => model.id), ["a", "b"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("runtime：完全没有 apiKey 配置的 provider 按无鉴权服务处理并照常刷新", async () => {
	const { createModels } = await import("@earendil-works/pi-ai");
	const models = createModels();
	models.setProvider(createDiscoveryProvider(ENTRY, [], []));
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return new Response(JSON.stringify({ data: [{ id: "a" }] }), { status: 200 });
	}) as typeof fetch;
	try {
		const result = await models.refresh({ providers: [ENTRY.id], allowNetwork: true });
		assert.equal(result.errors.size, 0);
		assert.equal(calls, 1);
		assert.deepEqual(models.getModels(ENTRY.id).map((model) => model.id), ["a"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("冷启动种子在第一次刷新时持久化，下一次启动直接读已存目录", async () => {
	const seeded = createDiscoveryProvider(ENTRY, remoteModels(["a"]), [], true);
	const first = refreshContext({ allowNetwork: false });
	await seeded.refreshModels!(first.context);
	assert.deepEqual(first.published.map((entry) => entry.persist?.models.map((model) => model.id)), [["a"]]);

	const restored = createDiscoveryProvider(ENTRY, [], []);
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		throw new Error("should not fetch");
	}) as typeof fetch;
	try {
		await restored.refreshModels!(
			refreshContext({ allowNetwork: false, stored: first.published[0]!.persist!.models }).context,
		);
		assert.deepEqual(restored.getModels().map((model) => model.id), ["a"]);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("已存目录不覆盖冷启动种子", async () => {
	const provider = createDiscoveryProvider(ENTRY, remoteModels(["new"]), [], true);
	const { context, published } = refreshContext({ allowNetwork: false, stored: remoteModels(["old"]) });
	await provider.refreshModels!(context);
	assert.deepEqual(provider.getModels().map((model) => model.id), ["new"]);
	assert.deepEqual(published.map((entry) => entry.persist?.models.map((model) => model.id)), [["new"]]);
});

test("已中止的刷新不发布也不发请求", async () => {
	const provider = createDiscoveryProvider(ENTRY, remoteModels(["a"]), [], true);
	const controller = new AbortController();
	controller.abort();
	const published: ModelsPublication[] = [];
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		await provider.refreshModels!({
			allowNetwork: true,
			signal: controller.signal,
			publish: async (publication) => {
				published.push(publication);
				return true;
			},
		});
		assert.equal(calls, 0);
		assert.equal(published.length, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("流式分发：pi 未实现的 api 在流内报错而不是同步抛出", async () => {
	const provider = createDiscoveryProvider({ ...ENTRY, api: "not-a-real-api" as Api }, [], []);
	const model = { ...remoteModels(["a"])[0]!, api: "not-a-real-api" as Api };
	const stream = provider.stream(model, { messages: [] } as never);
	const events = [];
	for await (const event of stream) events.push(event);
	const error = events.find((event) => event.type === "error");
	assert.ok(error, "expected an in-stream error event");
});

test("publish 被拒绝时既不清除待发布种子也不继续拉取", async () => {
	const provider = createDiscoveryProvider(ENTRY, remoteModels(["a"]), [], true);
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return new Response(JSON.stringify({ data: [{ id: "b" }] }), { status: 200 });
	}) as typeof fetch;
	try {
		await provider.refreshModels!({
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => false,
		});
		assert.equal(calls, 0);
		assert.deepEqual(provider.getModels().map((model) => model.id), ["a"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});
