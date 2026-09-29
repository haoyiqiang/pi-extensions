/**
 * Pi's prompt builders, loaded through a portable deep-module lookup.
 *
 * The installed host does not re-export `buildSystemPrompt` or
 * `normalizeBuildSystemPromptOptions` from its package barrel, so these tests need
 * the module that owns them. A hard-coded `node_modules` relative path only works
 * in a standalone checkout; resolve the package entry through Node and load its
 * sibling module, which keeps the fixture valid from any install layout.
 */
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/** The builders these tests need, in the shape the installed host declares. */
interface PiSystemPromptModule {
	readonly buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
	readonly normalizeBuildSystemPromptOptions: (
		input: BuildSystemPromptOptions,
	) => NormalizedBuildSystemPromptOptions;
}

const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const loaded = (await import(new URL("core/system-prompt.js", entryUrl).href)) as Partial<PiSystemPromptModule>;

if (loaded.buildSystemPrompt === undefined || loaded.normalizeBuildSystemPromptOptions === undefined) {
	throw new Error(`Installed @earendil-works/pi-coding-agent exposes no core/system-prompt.js builders (${entryUrl})`);
}

export const buildSystemPrompt = loaded.buildSystemPrompt;
export const normalizeBuildSystemPromptOptions = loaded.normalizeBuildSystemPromptOptions;
