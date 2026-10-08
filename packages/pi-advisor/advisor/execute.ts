import { cleanupSessionResources, uuidv7, type AssistantMessage, type Context, type Message, type StopReason, type TextContent, type ThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.ts";
import { getInventoryMessage } from "./inventory.ts";
import { messages } from "./messages.ts";
import { getAdvisorSystemPrompt } from "./prompt.ts";
import { getAdvisorEffort, getAdvisorModel, type AdvisorState } from "./state.ts";

export interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

function responseText(response: AssistantMessage): string {
	return response.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function aggregateUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first) return second;
	if (!second) return first;
	const optionalSum = (left: number | undefined, right: number | undefined): number | undefined =>
		left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		cacheWrite1h: optionalSum(first.cacheWrite1h, second.cacheWrite1h),
		reasoning: optionalSum(first.reasoning, second.reasoning),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function result(options: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: options.effort };
	if (options.advisorLabel !== undefined) details.advisorModel = options.advisorLabel;
	if (options.usage !== undefined) details.usage = options.usage;
	if (options.stopReason !== undefined) details.stopReason = options.stopReason;
	if (options.errorMessage !== undefined) details.errorMessage = options.errorMessage;
	return {
		content: [{ type: "text", text: options.text }],
		details,
		...(options.usage === undefined ? {} : { usage: options.usage }),
	};
}

async function completeBackground(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	model: NonNullable<ReturnType<typeof getAdvisorModel>>,
	context: Context,
	options: Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2],
): Promise<AssistantMessage> {
	if (model.api !== "openai-codex-responses") {
		return ctx.modelRegistry.streamSimple(model, context, options).result();
	}
	const sessionId = uuidv7();
	try {
		return await ctx.modelRegistry.streamSimple(model, context, { ...options, sessionId }).result();
	} finally {
		cleanupSessionResources(sessionId);
	}
}

export async function executeAdvisor(
	state: AdvisorState,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	const effort = getAdvisorEffort(state);
	const advisor = getAdvisorModel(state);
	if (!advisor) {
		return result({ text: messages.noModel(), effort, errorMessage: messages.noModelSelected() });
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	try {
		const { messages: sessionMessages } = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		);
		const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
		const inventory = getInventoryMessage(pi.getAllTools());
		const snapshotMessages: Message[] = inventory ? [inventory, ...branchMessages] : branchMessages;
		const snapshotContext: Context = {
			systemPrompt: getAdvisorSystemPrompt(),
			messages: snapshotMessages,
			tools: [],
		};
		const snapshotOptions: Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2] = {
			signal,
			reasoning: effort,
			toolChoice: "none",
		};

		onUpdate?.({
			content: [{ type: "text", text: messages.consulting(advisorLabel, effort) }],
			details: { advisorModel: advisorLabel, effort },
		});

		const callAdvisor = () => completeBackground(ctx, advisor, snapshotContext, snapshotOptions);
		const terminalResult = (
			response: AssistantMessage,
			usage: Usage | undefined = response.usage,
		): AgentToolResult<AdvisorDetails> | undefined => {
			if (response.stopReason === "aborted") {
				return result({
					text: messages.callAborted(),
					effort,
					advisorLabel,
					usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage ?? messages.abortedDetail(),
				});
			}
			if (response.stopReason === "error") {
				return result({
					text: messages.callFailed(response.errorMessage),
					effort,
					advisorLabel,
					usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				});
			}
			return undefined;
		};

		let response = await callAdvisor();
		const firstTerminal = terminalResult(response);
		if (firstTerminal) return firstTerminal;

		let text = responseText(response);
		let finalUsage: Usage | undefined = response.usage;
		if (!text) {
			const firstUsage = response.usage;
			response = await callAdvisor();
			finalUsage = aggregateUsage(firstUsage, response.usage);
			const retryTerminal = terminalResult(response, finalUsage);
			if (retryTerminal) return retryTerminal;
			text = responseText(response);
			if (!text) {
				return result({
					text: messages.emptyResponse(),
					effort,
					advisorLabel,
					usage: finalUsage,
					stopReason: response.stopReason,
					errorMessage: messages.emptyResponseDetail(),
				});
			}
		}

		return result({
			text,
			effort,
			advisorLabel,
			usage: finalUsage,
			stopReason: response.stopReason,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result({ text: messages.callThrew(message), effort, advisorLabel, errorMessage: message });
	}
}
