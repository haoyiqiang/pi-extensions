/**
 * 通用模型发现插件
 *
 * 读取 models.json 中带 "discoverModels": true 的 provider，请求
 * GET {baseUrl}/models 自动发现模型并注册，无需手写 models 数组。
 *
 * 配置方式（二选一）：
 * 1. pi 终端内执行 /config:model-discovery，交互式添加/删除/重新发现 provider（推荐）；
 * 2. 直接编辑 ~/.pi/agent/models.json：
 * {
 *   "providers": {
 *     "llm-proxy": {
 *       "name": "LLM Proxy",
 *       "baseUrl": "http://127.0.0.1:9000/pi/v1",
 *       "apiKey": "sk-1234",
 *       "api": "openai-completions",
 *       "discoverModels": true
 *     }
 *   }
 * }
 *
 * 行为约定：
 * - 首次发现成功后，模型列表持久化到 ~/.pi/agent/extensions/pi-models-discovery/cache.json；
 *   之后每次启动直接读缓存注册，不请求网络。配置指纹
 *   （baseUrl+api+apiKey+headers+compat）变化时缓存自动失效，重新走网络发现。
 * - /config:model-discovery-refresh 强制重新拉取所有发现 provider 并更新缓存；
 *   /model 打开时触发的在线 refreshModels 同样走网络并同步更新缓存。
 * - baseUrl / api 由扩展显式转发（pi 的 extension 组合层要求），
 *   apiKey / name / headers / compat 不写回注册配置，由 pi 的 models.json 层回落生效。
 * - provider 级 compat 会被合并进每个发现的模型（pi 的 models.json provider 级 compat
 *   不作用于 extension 注册的模型，故在此转发）。
 * - 同一 baseUrl+apiKey+headers 的多个 provider 共享一次 /models 请求。
 * - 发现失败：该 provider 保留 models.json 手写 models（如有，作为离线回退），
 *   并通过 notify 显式警告，不静默降级；单个 provider 失败不影响其他 provider 注册。
 * - 注册 refreshModels：打开 /model 触发在线刷新时重新发现；
 *   离线初始化（allowNetwork=false）返回上次成功列表（含缓存），尚无成功记录时抛错，
 *   以免空列表清掉 models.json 手写 models。
 * - 发现模型默认声明 thinkingLevelMap { xhigh: "xhigh", max: "max" }，让 xhigh/max 出现在
 *   /thinking；标准档位缺省沿用 pi 的 provider 默认映射。这是对所有发现模型一刀切的默认值，
 *   上游不认这些值时用 models.json 的 provider.modelOverrides 按 model.id 覆盖。
 * - 发现请求的 apiKey 解析仅支持字面量与 $ENV_VAR/${ENV_VAR} 插值；
 *   "!command" 形式的 apiKey 跳过发现（显式警告），pi 发起聊天请求时仍由 pi 自身解析。
 * - /config:model-discovery 命令对 models.json 的修改立即生效（registerProvider 运行时可直接调用）；
 *   直接手编 models.json 后需 /reload 扩展生效。
 * - 本插件不使用 console.*：所有用户可见消息走 ctx.ui.notify；
 *   加载期（无 ctx）产生的消息收集到 pendingNotices，session_start 时统一 flush。
 */

import type { Api } from "@earendil-works/pi-ai";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const FETCH_TIMEOUT_MS = 5000;
const DISCOVERY_MARKER = "discoverModels";
const LOG_PREFIX = "[model-discovery]";
const API_CHOICES = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"] as const;

/** 用户可见消息（级别与 ctx.ui.notify 的 type 对齐）；供通知中继与无 ctx 的收集队列共用 */
interface Notice {
	level: "info" | "warning" | "error";
	message: string;
}

/** 用户可见消息的统一出口：带来源标签与颜色（有 UI 传入 ctx 时），否则交给外部回调转发 */
type NoticeSink = (notice: Notice, ctx?: CommandCtx) => void;

/** 自动发现后的模型默认值；只覆盖 /models 无法提供的公共能力元数据。 */
interface DiscoveryModelDefaults {
	reasoning?: boolean;
	thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"];
	input?: ProviderModelConfig["input"];
	contextWindow?: number;
	maxTokens?: number;
	compat?: ProviderModelConfig["compat"];
}

/** provider 的自动发现过滤和默认元数据配置。 */
interface ModelDiscoveryOptions {
	include?: string[];
	exclude?: string[];
	defaults?: DiscoveryModelDefaults;
}
/** models.json 中 provider 条目的读取形态（含发现标记） */
interface DiscoveryProviderEntry {
	id: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	modelDiscovery?: ModelDiscoveryOptions;
}

interface ModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
		context_window?: number;
		contextWindow?: number;
		max_tokens?: number;
		maxTokens?: number;
	}>;
}

/** 持久化缓存中单个 provider 的条目 */
interface CachedProviderEntry {
	fingerprint: string;
	fetchedAt: string;
	models: ProviderModelConfig[];
}

interface CacheFile {
	version: 1;
	providers: Record<string, CachedProviderEntry>;
}

/** 与 pi dist/utils/json.js 的 stripJsonComments 一致：去 // 行注释与尾随逗号，保留字符串字面量 */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function modelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

function cachePath(): string {
	return join(getAgentDir(), "extensions", "pi-models-discovery", "cache.json");
}

/** 缓存失效指纹：provider 配置中影响发现结果的字段 */
function providerFingerprint(entry: DiscoveryProviderEntry): string {
	return JSON.stringify([
		entry.baseUrl ?? "",
		entry.api ?? "",
		entry.apiKey ?? "",
		entry.headers ?? {},
		entry.compat ?? {},
		entry.modelDiscovery ?? {},
	]);
}

/** 读取模型缓存；文件不存在视为空缓存，损坏则显式警告并视为空缓存（不静默降级） */
async function readCache(notices: Notice[]): Promise<CacheFile> {
	let raw: string;
	try {
		raw = await readFile(cachePath(), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			notices.push({
				level: "warning",
				message: `${LOG_PREFIX} ${`Failed to read the model cache (ignored; will rediscover): ${err instanceof Error ? err.message : String(err)}`}`,
			});
		}
		return { version: 1, providers: {} };
	}
	try {
		const parsed = JSON.parse(raw) as CacheFile;
		if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
			return { version: 1, providers: parsed.providers };
		}
		throw new Error("unexpected cache shape");
	} catch (err) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${`Failed to read the model cache (ignored; will rediscover): ${err instanceof Error ? err.message : String(err)}`}`,
		});
		return { version: 1, providers: {} };
	}
}

/** 发现成功后持久化模型列表；写失败仅警告（不影响本次注册） */
async function persistCachedModels(
	entry: DiscoveryProviderEntry,
	models: ProviderModelConfig[],
	notices: Notice[],
): Promise<void> {
	try {
		const cache = await readCache([]);
		cache.providers[entry.id] = {
			fingerprint: providerFingerprint(entry),
			fetchedAt: new Date().toISOString(),
			models,
		};
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
	} catch (err) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${entry.id}: ${`Failed to write the model cache: ${err instanceof Error ? err.message : String(err)}`}`,
		});
	}
}

/** 删除 provider 时同步移除其缓存条目 */
async function removeCachedModels(id: string, notices: Notice[]): Promise<void> {
	try {
		const cache = await readCache([]);
		if (!(id in cache.providers)) return;
		delete cache.providers[id];
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
	} catch (err) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${id}: ${`Failed to write the model cache: ${err instanceof Error ? err.message : String(err)}`}`,
		});
	}
}

/** 读取 models.json 完整内容（保留所有顶层字段与其他 provider 原样） */
async function readModelsFile(): Promise<{ data: Record<string, unknown>; error: string | null }> {
	let raw: string;
	try {
		raw = await readFile(modelsJsonPath(), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { data: {}, error: null };
		}
		return { data: {}, error: `Failed to read models.json: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
		return { data: parsed, error: null };
	} catch (err) {
		return { data: {}, error: `Failed to parse models.json: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** 写回 models.json；写前备份到 models.json.discovery-bak。注意：注释与键序格式不被保留 */
async function writeModelsFile(data: Record<string, unknown>): Promise<{ backup: string }> {
	const path = modelsJsonPath();
	const backup = `${path}.discovery-bak`;
	try {
		await writeFile(backup, await readFile(path, "utf-8"), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Failed to back up models.json: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	await writeFile(path, `${JSON.stringify(data, null, 4)}\n`, "utf-8");
	return { backup };
}
/** 只接受非空字符串数组；无效值按未配置处理。 */
function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return result.length > 0 ? result : undefined;
}

/** 读取发现模型的默认能力元数据。 */
function readDiscoveryDefaults(value: unknown): DiscoveryModelDefaults | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const input = Array.isArray(record.input)
		? record.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
		: undefined;
	const thinkingLevelMap = record.thinkingLevelMap && typeof record.thinkingLevelMap === "object"
		? record.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"]
		: undefined;
	const compat = record.compat && typeof record.compat === "object"
		? record.compat as ProviderModelConfig["compat"]
		: undefined;
	return {
		...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(input && input.length > 0 ? { input } : {}),
		...(typeof record.contextWindow === "number" && record.contextWindow > 0
			? { contextWindow: record.contextWindow }
			: {}),
		...(typeof record.maxTokens === "number" && record.maxTokens > 0
			? { maxTokens: record.maxTokens }
			: {}),
		...(compat ? { compat } : {}),
	};
}

/** 读取 provider.modelDiscovery；这是 discoverModels 的可选过滤/默认值扩展。 */
function readModelDiscoveryOptions(value: unknown): ModelDiscoveryOptions | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const include = readStringArray(record.include);
	const exclude = readStringArray(record.exclude);
	const defaults = readDiscoveryDefaults(record.defaults);
	return include || exclude || defaults ? { include, exclude, defaults } : undefined;
}

/** 把简单 glob（* / ?）转为整串匹配正则。 */
function modelPatternRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`);
}

/** 判断模型 ID 是否通过 provider.modelDiscovery 的 include/exclude。 */
export function modelMatchesDiscovery(id: string, options: ModelDiscoveryOptions | undefined): boolean {
	const included = !options?.include || options.include.some((pattern) => modelPatternRegex(pattern).test(id));
	if (!included) return false;
	return !options?.exclude?.some((pattern) => modelPatternRegex(pattern).test(id));
}

/** 从完整 models.json 数据中筛出带发现标记的 provider */
function pickDiscoveryProviders(data: Record<string, unknown>): DiscoveryProviderEntry[] {
	const rawProviders = (data.providers ?? {}) as Record<string, Record<string, unknown>>;
	const providers: DiscoveryProviderEntry[] = [];
	for (const [id, value] of Object.entries(rawProviders)) {
		if (value?.[DISCOVERY_MARKER] !== true) continue;
		providers.push({
			id,
			name: typeof value.name === "string" ? value.name : undefined,
			baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : undefined,
			apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
			api: typeof value.api === "string" ? value.api : undefined,
			headers:
				value.headers && typeof value.headers === "object"
					? (value.headers as Record<string, string>)
					: undefined,
			compat:
				value.compat && typeof value.compat === "object"
					? (value.compat as Record<string, unknown>)
					: undefined,
			modelDiscovery: readModelDiscoveryOptions(value.modelDiscovery),
		});
	}
	return providers;
}

/**
 * 解析发现请求用的配置值：字面量、$ENV_VAR / ${ENV_VAR} 插值、$$ 与 $! 转义。
 * 不执行 "!command"（由 pi 请求时自行处理），遇到时返回 error。
 */
function resolveEnvValue(raw: string): { value: string | null; error: string | null } {
	if (raw.startsWith("!")) {
		return { value: null, error: "Discovery requests do not support \"!command\" configuration values" };
	}
	const missing: string[] = [];
	const value = raw
		.replace(/\$\$|\$!|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braceName, plainName) => {
			if (match === "$$") return "\0DOLLAR\0";
			if (match === "$!") return "\0BANG\0";
			const name = (braceName ?? plainName) as string;
			const envValue = process.env[name];
			if (envValue === undefined) {
				missing.push(name);
				return "";
			}
			return envValue;
		})
		.replaceAll("\0DOLLAR\0", "$")
		.replaceAll("\0BANG\0", "!");
	if (missing.length > 0) {
		return { value: null, error: `Environment variables not set: ${missing.join(", ")}` };
	}
	return { value, error: null };
}
/** 发现请求优先使用 models.json 的 apiKey；未配置时复用该 provider 的已存 API key。 */
async function resolveDiscoveryApiKey(entry: DiscoveryProviderEntry): Promise<string | undefined> {
	if (entry.apiKey !== undefined) {
		const resolved = resolveEnvValue(entry.apiKey);
		if (resolved.error) throw new Error(`apiKey ${resolved.error}`);
		return resolved.value || undefined;
	}
	try {
		const credential = await readStoredCredential(entry.id);
		return credential?.type === "api_key" ? credential.key : undefined;
	} catch {
		return undefined;
	}
}

export function buildModel(
	id: string,
	name: string | undefined,
	contextWindow: number | undefined,
	maxTokens: number | undefined,
	providerCompat: Record<string, unknown> | undefined,
	defaults?: DiscoveryModelDefaults,
): ProviderModelConfig {
	return {
		id,
		name: name ?? id,
		reasoning: defaults?.reasoning ?? true,
		// xhigh/max 必须给非 null 值才会出现在 /thinking（缺省键等同不支持）；
		// modelDiscovery.defaults 可为同一网关声明更准确的统一映射。
		thinkingLevelMap: {
			xhigh: "xhigh",
			max: "max",
			...defaults?.thinkingLevelMap,
		},
		input: defaults?.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindow ?? defaults?.contextWindow ?? 1_000_000,
		maxTokens: maxTokens ?? defaults?.maxTokens ?? 65_536,
		compat: {
			supportsDeveloperRole: false,
			...defaults?.compat,
			...providerCompat,
		},
	};
}

/** 请求 {baseUrl}/models 并解析为模型配置；失败抛错（错误信息带原因） */
async function fetchModels(
	entry: DiscoveryProviderEntry,
	notices: Notice[],
): Promise<ProviderModelConfig[]> {
	if (!entry.baseUrl) {
		throw new Error("Missing baseUrl");
	}
	const headers: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(entry.headers ?? {})) {
		const resolved = resolveEnvValue(rawValue);
		if (resolved.error) {
			notices.push({
				level: "warning",
				message: `${LOG_PREFIX} ${`${entry.id}: header "${key}" ${resolved.error}; this header was not sent with the discovery request`}`,
			});
			continue;
		}
		if (resolved.value !== null) headers[key] = resolved.value;
	}
	const discoveryApiKey = await resolveDiscoveryApiKey(entry);
	if (discoveryApiKey) headers.Authorization = `Bearer ${discoveryApiKey}`;
	const url = `${entry.baseUrl.replace(/\/+$/, "")}/models`;
	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (err) {
		throw new Error(`Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		throw new Error(`Request to ${url} returned HTTP ${response.status}`);
	}
	const payload = (await response.json()) as ModelsResponse | Array<ModelsResponse["data"] extends (infer T)[] ? T : never>;
	const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
	const models = entries
		.filter((m): m is typeof m & { id: string } => typeof m?.id === "string" && m.id.length > 0)
		.filter((m) => modelMatchesDiscovery(m.id, entry.modelDiscovery))
		.map((m) =>
			buildModel(
				m.id,
				m.name,
				m.context_window ?? m.contextWindow,
				m.max_tokens ?? m.maxTokens,
				entry.compat,
				entry.modelDiscovery?.defaults,
			),
		);
	if (models.length === 0) {
		throw new Error(`${url} returned an empty model list`);
	}
	return models;
}

/** 共享 /models 请求的缓存：同一 baseUrl+apiKey+headers 只拉一次 */
type FetchCache = Map<string, Promise<ProviderModelConfig[]>>;

function fetchWithCache(cache: FetchCache, entry: DiscoveryProviderEntry, notices: Notice[]): Promise<ProviderModelConfig[]> {
	const cacheKey = `${entry.baseUrl}\n${entry.apiKey ?? `<stored:${entry.id}>`}\n${JSON.stringify(entry.headers ?? {})}\n${JSON.stringify(entry.modelDiscovery ?? {})}\n${JSON.stringify(entry.compat ?? {})}`;
	let pending = cache.get(cacheKey);
	if (!pending) {
		pending = fetchModels(entry, notices);
		cache.set(cacheKey, pending);
	}
	return pending;
}

/** refreshModels 闭包共享的最近成功列表（缓存命中时即为缓存内容） */
interface LastModelsState {
	lastModels: ProviderModelConfig[];
}

/**
 * 构造 refreshModels：离线初始化返回最近成功列表（无记录则抛错，避免清空手写 models）；
 * 在线刷新强制重拉、更新最近列表并持久化缓存。
 */
function createRefreshModels(entry: DiscoveryProviderEntry, notices: Notice[], state: LastModelsState) {
	return async (context: { allowNetwork: boolean }) => {
		if (!context.allowNetwork) {
			if (state.lastModels.length === 0) {
				throw new Error("No discovered models yet (last discovery failed); skipping offline initialization");
			}
			return state.lastModels;
		}
		const refreshed = await fetchModels(entry, notices);
		state.lastModels = refreshed;
		await persistCachedModels(entry, refreshed, notices);
		return refreshed;
	};
}

/** 校验 baseUrl/api 齐备；缺失时推入警告并返回 false */
function validateEntry(entry: DiscoveryProviderEntry, notices: Notice[]): entry is DiscoveryProviderEntry & { baseUrl: string; api: string } {
	if (!entry.baseUrl || !entry.api) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${entry.id}: ${`Missing ${!entry.baseUrl ? "baseUrl" : "api"}; cannot register model discovery`}`,
		});
		return false;
	}
	return true;
}

/**
 * 对单个 provider 执行模型发现并注册（成功带 models，失败保留手写回退）。
 * 启动期缓存未命中时与 /config:model-discovery、/config:model-discovery-refresh 命令共用；
 * 运行期调用立即生效，无需 /reload。
 * 成功时持久化模型缓存；返回发现的模型列表（失败为 null），消息写入 notices。
 * 注意：本函数不再主动输出“发现成功”信息；调用方按需自行 notify，
 * 避免启动期自动打印模型列表占用会话空间。
 */
async function discoverAndRegister(
	pi: ExtensionAPI,
	entry: DiscoveryProviderEntry,
	fetchCache: FetchCache,
	notices: Notice[],
): Promise<{ count: number; models: ProviderModelConfig[] } | null> {
	if (!validateEntry(entry, notices)) return null;
	const state: LastModelsState = { lastModels: [] };
	const refreshModels = createRefreshModels(entry, notices, state);
	try {
		const models = await fetchWithCache(fetchCache, entry, notices);
		state.lastModels = models;
		pi.registerProvider(entry.id, {
			baseUrl: entry.baseUrl,
			api: entry.api as Api,
			models,
			refreshModels,
		});
		await persistCachedModels(entry, models, notices);
		return { count: models.length, models };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${`${entry.id}: model discovery failed (${reason}); falling back to handwritten models in models.json, or no models available`}`,
		});
		pi.registerProvider(entry.id, {
			baseUrl: entry.baseUrl,
			api: entry.api as Api,
			refreshModels,
		});
		return null;
	}
}

/** 缓存命中路径：直接用持久化的模型列表注册，不请求网络 */
function registerFromCache(
	pi: ExtensionAPI,
	entry: DiscoveryProviderEntry,
	models: ProviderModelConfig[],
	notices: Notice[],
): void {
	if (!validateEntry(entry, notices)) return;
	const state: LastModelsState = { lastModels: models };
	const refreshModels = createRefreshModels(entry, notices, state);
	pi.registerProvider(entry.id, {
		baseUrl: entry.baseUrl,
		api: entry.api as Api,
		models,
		refreshModels,
	});
}

/** /config:model-discovery 交互式配置命令；旧名称保留为兼容别名。 */
function registerDiscoveryCommand(pi: ExtensionAPI, fetchCache: FetchCache, sink: NoticeSink) {
	const command = {
		description: "Interactively manage model-discovery providers (add/remove/rediscover); changes are written to models.json and take effect immediately",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			while (true) {
				const { data, error } = await readModelsFile();
				if (error) {
					sink({ level: "error", message: `${LOG_PREFIX} ${error}` }, ctx);
					return;
				}
				const providers = pickDiscoveryProviders(data);
				const ADD = "➕ Add provider";
				const EXIT = "Exit";
				const choices = [
					...providers.map((p) => `${p.id} — ${p.baseUrl ?? "?"}（${p.api ?? "?"}）`),
					ADD,
					EXIT,
				];
				const choice = await ctx.ui.select(
					providers.length > 0 ? `Model-discovery providers (${providers.length})` : "Model-discovery providers (none)",
					choices,
				);
				if (choice === undefined || choice === EXIT) return;

				if (choice === ADD) {
					await addProviderFlow(pi, ctx, data, fetchCache, sink);
					continue;
				}
				const selected = providers[choices.indexOf(choice)];
				if (selected) {
					await manageProviderFlow(pi, ctx, data, selected, fetchCache, sink);
				}
			}
		},
	};
	for (const name of ["config:model-discovery", "model-discovery", "pi-model-discovery"] as const) {
		pi.registerCommand(name, command);
	}
}

/** /config:model-discovery-refresh 强制刷新命令；旧名称保留为兼容别名。 */
function registerRefreshCommand(pi: ExtensionAPI, sink: NoticeSink) {
	const command = {
		description: "Force rediscovery of all model-discovery providers and update the local cache (startup uses the cache and performs no network requests by default)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const { data, error } = await readModelsFile();
			if (error) {
				sink({ level: "error", message: `${LOG_PREFIX} ${error}` }, ctx);
				return;
			}
			const providers = pickDiscoveryProviders(data);
			if (providers.length === 0) {
				sink({ level: "info", message: "No provider in models.json is marked with discoverModels; add one with /config:model-discovery" }, ctx);
				return;
			}
			// 每次刷新用新的请求级缓存：同 baseUrl 的 provider 仍共享一次请求，但不复用启动期结果
			const fetchCache: FetchCache = new Map();
			let ok = 0;
			for (const entry of providers) {
				const notices: Notice[] = [];
				const result = await discoverAndRegister(pi, entry, fetchCache, notices);
				for (const notice of notices) sink(notice, ctx);
				if (result) {
					sink(
						{
							level: "info",
							message: `${LOG_PREFIX} ${`${entry.id}: discovered ${result.count} models (${result.models.map((m) => m.id).join(", ")})`}`,
						},
						ctx,
					);
					ok++;
				}
			}
			sink(
				{
					level: ok === providers.length ? "info" : "warning",
					message: `Model refresh finished: ${ok}/${providers.length} providers succeeded`,
				},
				ctx,
			);
		},
	};
	for (const name of ["config:model-discovery-refresh", "model-discovery-refresh", "pi-model-discovery-refresh"] as const) {
		pi.registerCommand(name, command);
	}
}

type CommandCtx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

/** 将收集到的 Notice 逐条经来源包装后 flush 到 UI */
function flushNotices(ctx: CommandCtx, notices: Notice[]): void {
	for (const notice of notices) ctx.ui.notify(notice.message, notice.level);
}

/** /config:model-discovery 添加 provider 交互流程 */
async function addProviderFlow(pi: ExtensionAPI, ctx: CommandCtx, data: Record<string, unknown>, fetchCache: FetchCache, sink: NoticeSink) {
	const existingIds = new Set(Object.keys((data.providers ?? {}) as Record<string, unknown>));
	const id = (await ctx.ui.input("Provider id (letters, numbers, hyphens; e.g. my-proxy)"))?.trim();
	if (!id) return;
	if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
		sink({ level: "error", message: "The id may contain only letters, numbers, and hyphens, and cannot start with a hyphen" }, ctx);
		return;
	}
	if (existingIds.has(id)) {
		sink({ level: "error", message: `Provider "${id}" already exists in models.json` }, ctx);
		return;
	}
	const baseUrl = (await ctx.ui.input("baseUrl (e.g. http://127.0.0.1:9000/pi/v1)"))?.trim();
	if (!baseUrl) return;
	if (!/^https?:\/\//.test(baseUrl)) {
		sink({ level: "error", message: "baseUrl must start with http:// or https://" }, ctx);
		return;
	}
	const api = await ctx.ui.select("API type", [...API_CHOICES]);
	if (!api) return;
	const apiKey = (await ctx.ui.input("apiKey (optional; supports $ENV_VAR)"))?.trim();
	const name = (await ctx.ui.input(`Display name (optional; defaults to ${id})`))?.trim();

	const entry: Record<string, unknown> = { baseUrl, api, [DISCOVERY_MARKER]: true };
	if (name) entry.name = name;
	if (apiKey) entry.apiKey = apiKey;
	const summary = `id: ${id}
baseUrl: ${baseUrl}
api: ${api}
apiKey: ${apiKey || "(none)"}
name: ${name || id}`;
	if (!(await ctx.ui.confirm("Add this provider and write it to models.json?", summary))) return;

	const providers = (data.providers ?? {}) as Record<string, unknown>;
	providers[id] = entry;
	data.providers = providers;
	try {
		const { backup } = await writeModelsFile(data);
		sink({ level: "info", message: `Wrote models.json (backup: ${backup})` }, ctx);
	} catch (err) {
		sink({ level: "error", message: `${LOG_PREFIX} ${err instanceof Error ? err.message : err}` }, ctx);
		return;
	}

	const notices: Notice[] = [];
	const result = await discoverAndRegister(
		pi,
		{ id, name: name || undefined, baseUrl, apiKey: apiKey || undefined, api },
		fetchCache,
		notices,
	);
	flushNotices(ctx, notices);
	if (result) {
		sink({ level: "info", message: `${id}: discovered and registered ${result.count} models; they are available in /model` }, ctx);
	} else {
		sink({ level: "warning", message: `${id}: configuration saved, but initial discovery failed; rediscover with /config:model-discovery after the service recovers` }, ctx);
	}
}

/** /config:model-discovery 管理 provider（重新发现/删除）交互流程 */
async function manageProviderFlow(
	pi: ExtensionAPI,
	ctx: CommandCtx,
	data: Record<string, unknown>,
	entry: DiscoveryProviderEntry,
	fetchCache: FetchCache,
	sink: NoticeSink,
) {
	const REDISCOVER = "🔄 Rediscover models";
	const REMOVE = "🗑 Remove provider";
	const BACK = "Back";
	const action = await ctx.ui.select(
		`${entry.id}
baseUrl: ${entry.baseUrl ?? "?"}
api: ${entry.api ?? "?"}`,
		[REDISCOVER, REMOVE, BACK],
	);
	if (action === undefined || action === BACK) return;

	if (action === REDISCOVER) {
		const notices: Notice[] = [];
		const result = await discoverAndRegister(pi, entry, fetchCache, notices);
		flushNotices(ctx, notices);
		if (result) {
			sink({ level: "info", message: `${entry.id}: rediscovered ${result.count} models` }, ctx);
		}
		return;
	}

	// REMOVE
	if (!(await ctx.ui.confirm(`Remove provider "${entry.id}"?`, "This removes the provider and unregisters its models from models.json. It can be added again later."))) return;
	const providers = (data.providers ?? {}) as Record<string, unknown>;
	delete providers[entry.id];
	data.providers = providers;
	try {
		const { backup } = await writeModelsFile(data);
		pi.unregisterProvider(entry.id);
		const notices: Notice[] = [];
		await removeCachedModels(entry.id, notices);
		flushNotices(ctx, notices);
		sink({ level: "info", message: `Removed ${entry.id} (backup: ${backup})` }, ctx);
	} catch (err) {
		sink({ level: "error", message: `${LOG_PREFIX} ${err instanceof Error ? err.message : err}` }, ctx);
	}
}

export default async function (pi: ExtensionAPI) {
	// 加载期没有 ctx，消息统一收集，session_start 时 flush（运行期后续追加的也会在下个 session 补发）
	const pendingNotices: Notice[] = [];
	// 有 UI 时走 ctx.ui.notify；无 UI 时先收集，session_start 再补发。
	const sink: NoticeSink = (notice, ctx) => {
		if (ctx) ctx.ui.notify(notice.message, notice.level);
		else pendingNotices.push(notice);
	};
	const { data, error } = await readModelsFile();
	if (error) {
		pendingNotices.push({ level: "warning", message: `${LOG_PREFIX} ${error}` });
	}
	const providers = pickDiscoveryProviders(data);
	const fetchCache: FetchCache = new Map();

	if (providers.length > 0) {
		const cache = await readCache(pendingNotices);
		for (const entry of providers) {
			const cached = cache.providers[entry.id];
			if (
				cached &&
				cached.fingerprint === providerFingerprint(entry) &&
				Array.isArray(cached.models) &&
				cached.models.length > 0
			) {
				registerFromCache(pi, entry, cached.models, pendingNotices);
			} else {
				await discoverAndRegister(pi, entry, fetchCache, pendingNotices);
				// 启动期缓存未命中时保持静默，不打印模型列表
			}
		}
	}

	registerDiscoveryCommand(pi, fetchCache, sink);
	registerRefreshCommand(pi, sink);

	pi.on("session_start", (_event, ctx) => {
		for (const notice of pendingNotices.splice(0)) {
			ctx.ui.notify(notice.message, notice.level);
		}
	});
}
