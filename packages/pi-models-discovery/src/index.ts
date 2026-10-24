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
 * 实现形态：注册一个完整的 pi Provider（不是 legacy ProviderConfig），
 * 目录与持久化完全交给 pi：
 * - refreshModels 用 context.stored 恢复上次目录（只接受与当前 baseUrl/api/过滤规则
 *   兼容的模型），allowNetwork 时再拉 /models，结果经 context.publish({ persist })
 *   写入 pi 的 models-store.json。
 * - 刷新由 pi 自己驱动：交互启动、RPC 启动、打开 /model 都会触发，无需手工刷新命令。
 * - 发现请求用 context.credential 与 context.signal（可取消），不自行解析凭据。
 * - 首次运行且没有任何已存目录时，加载期做一次种子发现（PI_OFFLINE 时跳过），
 *   让 pi -p / subagent 这类不触发刷新的运行方式也有目录可用；已有目录时不再发请求。
 * - provider 级 compat 会被合并进每个发现的模型（不同 pi 版本对 extension 模型的
 *   provider 级 compat 处理不一致，显式转发以保证一致）。
 * - 发现模型默认声明 thinkingLevelMap { xhigh: "xhigh", max: "max" }，让 xhigh/max 出现在
 *   /thinking；标准档位缺省沿用 pi 的 provider 默认映射。这是对所有发现模型一刀切的默认值，
 *   上游不认这些值时用 models.json 的 modelOverrides 按 model.id 覆盖。
 * - apiKey 的 "!command" 由 pi 执行，解析结果经 context.credential 进入刷新路径；
 *   只有加载期的冷启动种子请求无法执行 "!command"（显式告警，等 pi 首次刷新补上）。
 * - headers 里的 "!command" 不进发现请求（告警提示），pi 发起模型请求时仍会解析它。
 * - /config:model-discovery 命令对 models.json 的修改立即生效（registerProvider 运行时可直接调用）；
 *   直接手编 models.json 后需 /reload 扩展生效。
 * - 本插件不使用 console.*：所有用户可见消息走 ctx.ui.notify；
 *   加载期（无 ctx）产生的消息收集到 pendingNotices，session_start 时统一 flush。
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	Api,
	Model,
	ModelsStoreEntry,
	Provider,
	ProviderAuth,
	ProviderHeaders,
	ProviderStreams,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FETCH_TIMEOUT_MS = 5000;
const DISCOVERY_MARKER = "discoverModels";
const LOG_PREFIX = "[model-discovery]";

/** 交互式配置里常用的 api（只是选择项，不限制 models.json 里已有条目的 api） */
const API_CHOICES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

/**
 * 流式实现全部委托 pi 的 api registry：本插件只做 /models 的 JSON 转换，
 * 任何 pi 支持的 api（含 azure-openai-responses、bedrock、mistral 等）都照常工作。
 * 未知 api 与 legacy 注册一致：注册成功，由 pi 在发起请求时报错。
 */
function apiStreams(): ProviderStreams {
	const require = (api: Api) => {
		const provider = getApiProvider(api);
		if (!provider) throw new Error(`No API provider registered for api: ${api}`);
		return provider;
	};
	return {
		stream: (model, context, options) => lazyStream(model, async () => require(model.api).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => require(model.api).streamSimple(model, context, options)),
	};
}

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
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	input?: Model<Api>["input"];
	contextWindow?: number;
	maxTokens?: number;
	compat?: Model<Api>["compat"];
}

/** provider 的自动发现过滤和默认元数据配置。 */
interface ModelDiscoveryOptions {
	include?: string[];
	exclude?: string[];
	defaults?: DiscoveryModelDefaults;
}

/** models.json 中 provider 条目的读取形态（含发现标记） */
export interface DiscoveryProviderEntry {
	id: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	modelDiscovery?: ModelDiscoveryOptions;
}

type ResolvedEntry = DiscoveryProviderEntry & { baseUrl: string; api: Api };

/** 单个 /models 条目；不同网关返回的元数据字段并不统一 */
interface ModelListItem {
	id?: string;
	name?: string;
	context_window?: number;
	contextWindow?: number;
	max_tokens?: number;
	maxTokens?: number;
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

/** 读取 pi 自己持久化的目录（与 models.json 同目录）；只读，写入永远由 pi 完成 */
async function readStoredCatalog(entry: ResolvedEntry): Promise<Model<Api>[]> {
	try {
		const raw = await readFile(join(dirname(modelsJsonPath()), "models-store.json"), "utf-8");
		const store = JSON.parse(raw) as Record<string, ModelsStoreEntry | undefined>;
		return compatibleModels(entry, store[entry.id]?.models ?? []);
	} catch {
		return [];
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
		? record.thinkingLevelMap as Model<Api>["thinkingLevelMap"]
		: undefined;
	const compat = record.compat && typeof record.compat === "object"
		? record.compat as Model<Api>["compat"]
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

/** 判断已存目录中的模型是否仍适配当前配置（端点、api、过滤规则）。 */
export function compatibleModels(entry: ResolvedEntry, models: readonly Model<Api>[]): Model<Api>[] {
	return models.filter(
		(model) =>
			model.provider === entry.id &&
			model.api === entry.api &&
			model.baseUrl === entry.baseUrl &&
			modelMatchesDiscovery(model.id, entry.modelDiscovery),
	);
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
 * 解析发现请求使用的配置值：字面量、$ENV_VAR / ${ENV_VAR} 插值、$$ 与 $! 转义。
 * 不执行 "!command"（由 pi 在请求时处理），遇到时返回 error。
 */
function resolveConfigValue(raw: string): { value: string | null; error: string | null } {
	if (raw.startsWith("!")) {
		return { value: null, error: "discovery requests do not support \"!command\" configuration values" };
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
		return { value: null, error: `environment variables not set: ${missing.join(", ")}` };
	}
	return { value, error: null };
}

/** 解析 provider.headers（跳过解析失败的值并给出警告） */
function resolveHeaders(entry: DiscoveryProviderEntry, notices: Notice[]): ProviderHeaders | undefined {
	const entries = Object.entries(entry.headers ?? {});
	if (entries.length === 0) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, rawValue] of entries) {
		const resolved = resolveConfigValue(rawValue);
		if (resolved.value === null) {
			notices.push({
				level: "warning",
				message: `${LOG_PREFIX} ${entry.id}: header "${key}" ${resolved.error}; it is not sent with the discovery request (Pi still resolves it for model requests)`,
			});
			continue;
		}
		headers[key] = resolved.value;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 冷启动用的 apiKey：加载期与 /config 手动发现时 pi 还没给出 credential，只能就地解析
 * models.json 的 apiKey，或复用 auth.json 里该 provider 的已存 key。刷新路径不使用它。
 */
async function resolveLocalApiKey(entry: DiscoveryProviderEntry): Promise<string | undefined> {
	if (entry.apiKey !== undefined) {
		const resolved = resolveConfigValue(entry.apiKey);
		if (resolved.error) throw new Error(`apiKey ${resolved.error}`);
		return resolved.value || undefined;
	}
	try {
		const stored = await readStoredCredential(entry.id);
		return stored?.type === "api_key" ? stored.key : undefined;
	} catch {
		return undefined;
	}
}

/** 发现模型的通用默认值；provider/model 返回的元数据优先。 */
export function buildModel(
	id: string,
	name: string | undefined,
	contextWindow: number | undefined,
	maxTokens: number | undefined,
	providerCompat: Record<string, unknown> | undefined,
	defaults?: DiscoveryModelDefaults,
): Model<Api> {
	return {
		id,
		name: name ?? id,
		provider: "",
		api: "openai-completions",
		baseUrl: "",
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
		} as Model<Api>["compat"],
	} as Model<Api>;
}

/** 请求 {baseUrl}/models 并解析为模型定义；失败抛错（pi 会保留上一份目录） */
async function fetchModels(
	entry: ResolvedEntry,
	notices: Notice[],
	options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<Model<Api>[]> {
	const headers: Record<string, string> = { ...resolveHeaders(entry, notices) };
	if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
	const url = `${entry.baseUrl.replace(/\/+$/, "")}/models`;
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(url, { headers, signal });
	} catch (err) {
		throw new Error(`Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		throw new Error(`Request to ${url} returned HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: ModelListItem[] } | ModelListItem[];
	const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
	const models = entries
		.filter((m): m is typeof m & { id: string } => typeof m?.id === "string" && m.id.length > 0)
		.filter((m) => modelMatchesDiscovery(m.id, entry.modelDiscovery))
		.map((m) => ({
			...buildModel(
				m.id,
				m.name,
				m.context_window ?? m.contextWindow,
				m.max_tokens ?? m.maxTokens,
				entry.compat,
				entry.modelDiscovery?.defaults,
			),
			provider: entry.id,
			api: entry.api,
			baseUrl: entry.baseUrl,
		}));
	if (models.length === 0) {
		throw new Error(`${url} returned an empty model list`);
	}
	return models;
}

/** 校验 baseUrl/api 齐备；缺失时推入警告并返回 false（api 是否可流式由 pi 在请求时判定） */
function validateEntry(entry: DiscoveryProviderEntry, notices: Notice[]): entry is ResolvedEntry {
	if (!entry.baseUrl || !entry.api) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${entry.id}: missing ${!entry.baseUrl ? "baseUrl" : "api"}; cannot register model discovery`,
		});
		return false;
	}
	return true;
}

/** 依据 models.json 条目构造完整 Provider：目录状态本地持有，持久化交给 pi */
export function createDiscoveryProvider(
	entry: ResolvedEntry,
	initial: Model<Api>[],
	notices: Notice[],
	freshSeed = false,
): Provider {
	let models: Model<Api>[] = initial;
	// 冷启动自己拉到的目录还没被 pi 持久化：除非 pi 接受了一次发布，否则下次启动还得再拉。
	let pendingSeed = freshSeed && initial.length > 0;
	const streams = apiStreams();
	const auth: ProviderAuth = {
		apiKey: {
			name: `${entry.name ?? entry.id} API key`,
			// pi 的模型注册表已把 models.json 的 apiKey 与 auth.json 的凭据组合好传进来，
			// 这里只消费它；没有凭据即视为无鉴权服务，让 pi 照常执行网络刷新。
			async resolve({ credential }) {
				if (credential?.type === "api_key" && credential.key) {
					return { auth: { apiKey: credential.key }, source: "stored credential" };
				}
				return { auth: {}, source: credential ? undefined : "unauthenticated" };
			},
		},
	};
	return {
		id: entry.id,
		name: entry.name ?? entry.id,
		baseUrl: entry.baseUrl,
		headers: resolveHeaders(entry, notices),
		auth,
		getModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			if (context.signal.aborted) return;
			if (pendingSeed) {
				const accepted = await context.publish({ persist: { models, checkedAt: Date.now() } });
				if (!accepted) return;
				pendingSeed = false;
			}
			// 只在本进程还没有目录时接受 pi 的已存目录：已有目录只可能更新或过时，
			// 让随后（或下一次）网络刷新来决定，避免新拉到的结果被旧快照覆盖。
			if (context.stored && models.length === 0) {
				const restored = compatibleModels(entry, context.stored.models);
				if (!(await context.publish({ update: () => (models = restored) }))) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const refreshed = await fetchModels(entry, notices, {
				apiKey: context.credential?.type === "api_key" ? context.credential.key : undefined,
				signal: context.signal,
			});
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => (models = refreshed),
			});
		},
		stream: (model, context, options) => streams.stream(model, context, options),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
	};
}

/**
 * 加载期的初始目录：pi 已持久化的目录优先（零网络）；没有时做一次冷启动发现，
 * 让 pi -p / subagent 这类不触发网络刷新的运行方式也有目录可用（PI_OFFLINE 时跳过）。
 */
async function startupModels(
	entry: ResolvedEntry,
	notices: Notice[],
): Promise<{ models: Model<Api>[]; freshSeed: boolean }> {
	const stored = await readStoredCatalog(entry);
	if (stored.length > 0 || process.env.PI_OFFLINE) return { models: stored, freshSeed: false };
	try {
		const models = await fetchModels(entry, notices, { apiKey: await resolveLocalApiKey(entry) });
		return { models, freshSeed: true };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${entry.id}: discovery failed (${reason}); models appear after the next successful refresh (open /model), handwritten models in models.json still apply`,
		});
		return { models: [], freshSeed: false };
	}
}

/**
 * 让 pi 对单个 provider 强制在线刷新：与打开 /model 走同一条 refreshModels 路径，
 * 拿到 context.credential 并写回 models-store.json，不在扩展里另开一套拉取逻辑。
 */
async function refreshProvider(ctx: CommandCtx, id: string): Promise<{ count: number; error: string | null }> {
	if (!ctx.modelRegistry.getProvider(id)) {
		return { count: 0, error: "provider is not registered in this session (run /reload after editing models.json)" };
	}
	const result = await ctx.modelRegistry.refresh({ providers: [id], allowNetwork: true, force: true });
	const count = ctx.modelRegistry.getProvider(id)?.getModels().length ?? 0;
	const error = result.errors.get(id)?.message ?? (count === 0 ? "the provider returned no models" : null);
	return { count, error };
}

/** /config:model-discovery 交互式配置命令；旧名称保留为兼容别名。 */
function registerDiscoveryCommand(pi: ExtensionAPI, sink: NoticeSink) {
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
					await addProviderFlow(pi, ctx, data, sink);
					continue;
				}
				const selected = providers[choices.indexOf(choice)];
				if (selected) {
					await manageProviderFlow(pi, ctx, data, selected, sink);
				}
			}
		},
	};
	for (const name of ["config:model-discovery", "model-discovery", "pi-model-discovery"] as const) {
		pi.registerCommand(name, command);
	}
}

type CommandCtx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

/** 将收集到的 Notice 逐条经来源包装后 flush 到 UI */
function flushNotices(ctx: CommandCtx, notices: Notice[]): void {
	for (const notice of notices) ctx.ui.notify(notice.message, notice.level);
}

/** /config:model-discovery 添加 provider 交互流程 */
async function addProviderFlow(pi: ExtensionAPI, ctx: CommandCtx, data: Record<string, unknown>, sink: NoticeSink) {
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
	const api = await ctx.ui.select("API type", API_CHOICES);
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
	const created = { id, name: name || undefined, baseUrl, apiKey: apiKey || undefined, api };
	if (!validateEntry(created, notices)) {
		flushNotices(ctx, notices);
		return;
	}
	pi.registerProvider(createDiscoveryProvider(created, [], notices));
	const { count, error } = await refreshProvider(ctx, id);
	flushNotices(ctx, notices);
	if (error === null) {
		sink({ level: "info", message: `${id}: discovered and registered ${count} models; they are available in /model` }, ctx);
	} else {
		sink({ level: "warning", message: `${id}: configuration saved, but discovery failed (${error}); open /model after the service recovers` }, ctx);
	}
}

/** /config:model-discovery 管理 provider（重新发现/删除）交互流程 */
async function manageProviderFlow(
	pi: ExtensionAPI,
	ctx: CommandCtx,
	data: Record<string, unknown>,
	entry: DiscoveryProviderEntry,
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
		const { count, error } = await refreshProvider(ctx, entry.id);
		if (error === null) {
			sink({ level: "info", message: `${entry.id}: rediscovered ${count} models` }, ctx);
		} else {
			sink({ level: "warning", message: `${entry.id}: refresh failed (${error})` }, ctx);
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

	for (const entry of pickDiscoveryProviders(data)) {
		if (!validateEntry(entry, pendingNotices)) continue;
		const { models, freshSeed } = await startupModels(entry, pendingNotices);
		pi.registerProvider(createDiscoveryProvider(entry, models, pendingNotices, freshSeed));
	}

	registerDiscoveryCommand(pi, sink);

	// 加载期与刷新期的告警统一在下一个可提示时机（会话开始 / 轮次开始）flush，
	// 因为 refreshModels 内部拿不到 ctx。
	const flushPending = (ctx: { ui: { notify: (message: string, level: Notice["level"]) => void } }) => {
		for (const notice of pendingNotices.splice(0)) {
			ctx.ui.notify(notice.message, notice.level);
		}
	};
	pi.on("session_start", (_event, ctx) => flushPending(ctx));
	pi.on("turn_start", (_event, ctx) => flushPending(ctx));
}
