/**
 * System prompt protocol for rpiv-workflow documentation delivery.
 *
 * Prepends a documentation reference block to the system prompt every turn
 * via `before_agent_start`, following the same pattern as rpiv-args'
 * skill-invocation protocol (`packages/rpiv-args/args.ts:439`). The block
 * tells the agent where to find rpiv-workflow's authoring docs and when to
 * read them — the agent reads the docs on-demand via the `read` tool.
 *
 * The protocol is small (~200 bytes) and identical every turn, so it
 * benefits from Pi's prompt caching (same amortization as
 * `SKILL_INVOCATION_PROTOCOL` in rpiv-args).
 *
 * This module has zero Pi type imports — the host interface declares only
 * the `on("before_agent_start", ...)` shape needed for registration.
 * At runtime, Pi passes the full ExtensionAPI which structurally satisfies
 * this interface.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { i18n } from "./i18n.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Absolute path to the rpiv-workflow package root. Resolved from this
 * file's location via `import.meta.url` — works in both development
 * (monorepo source) and production (installed npm package).
 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS_DIR = join(PACKAGE_ROOT, "docs");

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * System prompt protocol prepended every turn. Cached after first build
 * so bytes are identical every turn → prompt-cache hit after turn 1
 * (same posture as rpiv-args' `SKILL_INVOCATION_PROTOCOL`).
 *
 * Mirrors Pi's own "When asked about:" routing table pattern — path
 * references + routing instructions, no inline content.
 */
const protocolCache = new Map<string, string>();

export function getDocsProtocol(): string {
	const locale = i18n.locale();
	const cached = protocolCache.get(locale);
	if (cached) return cached;

	const protocol = [
		"",
		i18n.t("docs.heading"),
		i18n.t("docs.basics", { path: join(DOCS_DIR, "workflow-basics.md") }),
		i18n.t("docs.authoring", { path: join(DOCS_DIR, "workflow-authoring.md") }),
		i18n.t("docs.readFirst"),
		i18n.t("docs.validate"),
		"",
	].join("\n");
	protocolCache.set(locale, protocol);
	return protocol;
}

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/**
 * Minimal host interface for docs-protocol registration. Declares only the
 * `on` shape needed for `before_agent_start`. At runtime, Pi passes the
 * full ExtensionAPI which structurally satisfies this.
 *
 * Not exported as part of rpiv-workflow's public type surface — internal
 * to the extension wiring in `index.ts`.
 */
export interface DocsProtocolHost {
	on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => { systemPrompt: string }): void;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * `before_agent_start` handler. Read-then-prepend — never replace,
 * replacement clobbers prior extensions (rpiv-args, rpiv-pi guidance, etc.).
 *
 * Exported for testing.
 */
export function handleBeforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } {
	return { systemPrompt: getDocsProtocol() + event.systemPrompt };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the docs-protocol `before_agent_start` hook with the host.
 * Called from the extension's default export alongside
 * `registerWorkflowCommand`.
 */
export function registerDocsProtocol(host: DocsProtocolHost): void {
	host.on("before_agent_start", handleBeforeAgentStart);
}
