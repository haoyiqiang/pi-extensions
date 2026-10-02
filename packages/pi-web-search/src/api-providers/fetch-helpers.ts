/**
 * Shared fetch helpers — HTTP client, content-type guards, and HTML-to-text
 * extraction used by providers that wrap the built-in pipeline (Brave, Serper,
 * SearXNG). `fetchViaGenericHtml` is the one-stop entry point those providers
 * delegate their `fetch()` method to.
 */

import { Agent } from "undici";
import { i18n } from "../i18n.ts";
import { lookupPublicAddress, parseAndAssertHttpUrl } from "../url_safety.ts";
import type { FetchResponse } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_AGENT = "Mozilla/5.0 (compatible; rpiv-pi/1.0)";
const FETCH_ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const BINARY_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/"];
const HTML_CONTENT_TYPE_TOKEN = "text/html";
const MAX_FETCH_RESPONSE_BYTES = 10 * 1024 * 1024;
const PUBLIC_FETCH_DISPATCHER = new Agent({ connect: { lookup: lookupPublicAddress } });

// ---------------------------------------------------------------------------
// HTML-to-text extraction
// ---------------------------------------------------------------------------

const SCRIPT_BLOCK_REGEX = /<script[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_REGEX = /<style[\s\S]*?<\/style>/gi;
const NOSCRIPT_BLOCK_REGEX = /<noscript[\s\S]*?<\/noscript>/gi;
const BLOCK_CLOSER_REGEX =
	/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi;
const SELF_CLOSING_BR_REGEX = /<br\s*\/?>/gi;
const ANY_REMAINING_TAG_REGEX = /<[^>]+>/g;
const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;
const NUMERIC_HTML_ENTITY_REGEX = /&#(\d+);/g;
const HORIZONTAL_WHITESPACE_RUN = /[ \t]+/g;
const BLANK_LINE_RUN = /\n{3,}/g;

function stripNonContentBlocks(html: string): string {
	return html.replace(SCRIPT_BLOCK_REGEX, "").replace(STYLE_BLOCK_REGEX, "").replace(NOSCRIPT_BLOCK_REGEX, "");
}

function convertBlockTagsToNewlines(text: string): string {
	return text.replace(BLOCK_CLOSER_REGEX, "\n").replace(SELF_CLOSING_BR_REGEX, "\n");
}

function stripRemainingTags(text: string): string {
	return text.replace(ANY_REMAINING_TAG_REGEX, " ");
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(NUMERIC_HTML_ENTITY_REGEX, (_, code) => String.fromCharCode(Number(code)));
}

function collapseWhitespace(text: string): string {
	return text.replace(HORIZONTAL_WHITESPACE_RUN, " ").replace(BLANK_LINE_RUN, "\n\n");
}

export function htmlToText(html: string): string {
	let text = stripNonContentBlocks(html);
	text = convertBlockTagsToNewlines(text);
	text = stripRemainingTags(text);
	text = decodeHtmlEntities(text);
	text = collapseWhitespace(text);
	return text.trim();
}

export function extractTitle(html: string): string | undefined {
	const match = html.match(TITLE_TAG_REGEX);
	if (!match) return undefined;
	return match[1].replace(ANY_REMAINING_TAG_REGEX, "").trim() || undefined;
}

// ---------------------------------------------------------------------------
// URL + content-type guards
// ---------------------------------------------------------------------------

export function isHtmlContentType(contentType: string): boolean {
	return contentType.includes(HTML_CONTENT_TYPE_TOKEN);
}

export function assertTextContentType(contentType: string): void {
	if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.includes(prefix))) {
		throw new Error(i18n.t("error.unsupportedContentType", { contentType }));
	}
}

// ---------------------------------------------------------------------------
// HTTP fetch
// ---------------------------------------------------------------------------

export function buildFetchRequestInit(signal: AbortSignal | undefined): RequestInit {
	return {
		signal,
		redirect: "manual",
		headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT_HEADER },
		// Node's fetch accepts Undici's dispatcher extension. The custom lookup
		// validates the same address the socket connector receives, avoiding a
		// DNS-check/fetch re-resolution race.
		dispatcher: PUBLIC_FETCH_DISPATCHER,
	} as RequestInit;
}

async function disposeResponseBody(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		// Preserve the redirect or validation error that caused disposal.
	}
}

export async function fetchUrlOrThrow(url: string, signal: AbortSignal | undefined): Promise<Response> {
	let current = parseAndAssertHttpUrl(url);
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		const res = await fetch(current, buildFetchRequestInit(signal));
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			await disposeResponseBody(res);
			if (!location) throw new Error(i18n.t("error.redirectWithoutLocation", { url: current.toString() }));
			if (redirects === 5) throw new Error(i18n.t("error.tooManyRedirects", { url }));
			current = parseAndAssertHttpUrl(new URL(location, current).toString());
			continue;
		}
		if (!res.ok) {
			await disposeResponseBody(res);
			throw new Error(i18n.t("error.httpStatus", {
				status: res.status,
				statusText: res.statusText,
				url: current.toString(),
			}));
		}
		return res;
	}
	throw new Error(i18n.t("error.tooManyRedirects", { url }));
}

async function readBoundedText(res: Response): Promise<string> {
	const declaredLength = Number(res.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_RESPONSE_BYTES) {
		await disposeResponseBody(res);
		throw new Error(i18n.t("error.responseTooLarge", { maxBytes: MAX_FETCH_RESPONSE_BYTES }));
	}
	if (!res.body) return "";

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_FETCH_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error(i18n.t("error.responseTooLarge", { maxBytes: MAX_FETCH_RESPONSE_BYTES }));
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		reader.releaseLock();
	}
}

export async function extractBodyAsText(
	res: Response,
	contentType: string,
	raw: boolean,
): Promise<{ text: string; title?: string }> {
	const body = await readBoundedText(res);
	if (!raw && isHtmlContentType(contentType)) {
		return { text: htmlToText(body), title: extractTitle(body) };
	}
	return { text: body };
}

// One-stop fetch helper for providers that have no hosted fetch endpoint
// (Brave/Serper/SearXNG). Bundles the quartet — fetchUrlOrThrow →
// content-type assertion → body extraction → FetchResponse envelope — so
// providers collapse to a single delegating call.
export async function fetchViaGenericHtml(url: string, raw: boolean, signal?: AbortSignal): Promise<FetchResponse> {
	const res = await fetchUrlOrThrow(url, signal);
	const contentType = res.headers.get("content-type") ?? "";
	try {
		assertTextContentType(contentType);
	} catch (error) {
		await disposeResponseBody(res);
		throw error;
	}
	const { text, title } = await extractBodyAsText(res, contentType, raw);
	const contentLengthHeader = res.headers.get("content-length");
	return {
		text,
		title,
		contentType: contentType || undefined,
		contentLength: contentLengthHeader ? Number(contentLengthHeader) : undefined,
	};
}
