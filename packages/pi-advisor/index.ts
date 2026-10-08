import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLocale, LOCALE_CHANGED_EVENT } from "pi-extensions-i18n";
import {
	createAdvisorState,
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerAdvisorSessionStart,
	registerAdvisorTool,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
	resetAdvisorState,
} from "./advisor/index.ts";

export default function advisorExtension(pi: ExtensionAPI): void {
	const state = createAdvisorState();
	let metadataLocale: string | undefined;
	const refreshMetadata = () => {
		const locale = getLocale();
		if (metadataLocale === locale) return;
		registerAdvisorTool(pi, state);
		registerAdvisorCommand(pi, state);
		metadataLocale = locale;
	};
	refreshMetadata();
	const releaseLocale = pi.events.on(LOCALE_CHANGED_EVENT, refreshMetadata);
	pi.on("session_start", refreshMetadata);
	pi.on("input", refreshMetadata);
	pi.on("before_agent_start", refreshMetadata);
	registerAdvisorBeforeAgentStart(pi, state);
	registerModelSelectHandler(pi, state);
	registerThinkingLevelSelectHandler(pi, state);
	registerAdvisorSessionStart(pi, state);
	pi.on("session_shutdown", async () => {
		releaseLocale();
		resetAdvisorState(state);
	});
}

export * from "./advisor/index.ts";
