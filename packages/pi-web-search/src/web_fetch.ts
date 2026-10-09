import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, type AgentToolUpdateCallback, type ExtensionContext, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createSearchProvider } from "./api-providers/factory.ts";
import { fetchViaGenericHtml } from "./api-providers/fetch-helpers.ts";
import { getInterceptors } from "./api-providers/interceptors/index.ts";
import type { FetchResponse, FullProvider } from "./api-providers/types.ts";
import { resolveProviderCredentials } from "./api_search.ts";
import { loadWebSearchConfig, resolveApiProviderName } from "./config.ts";
import { assertPublicDns, parseAndAssertHttpUrl } from "./url_safety.ts";

const FETCH_TEMP_DIR_PREFIX = "pi-web-search-fetch-";
const FETCH_TEMP_FILE_NAME = "content.txt";

export const WebFetchSchema = Type.Object({
  url: Type.String({ description: "The HTTP(S) URL to fetch" }),
  raw: Type.Optional(Type.Boolean({ description: "Return the raw response body when using built-in HTTP fetch" })),
});
export type WebFetchInput = Static<typeof WebFetchSchema>;

export interface WebFetchDetails {
  url: string;
  backend?: string;
  title?: string;
  contentType?: string;
  contentLength?: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  error?: string;
}

export { parseAndAssertHttpUrl } from "./url_safety.ts";

async function spillFullContent(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), FETCH_TEMP_DIR_PREFIX));
  const path = join(dir, FETCH_TEMP_FILE_NAME);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

function formatHeader(url: string, title?: string, contentType?: string): string {
  const lines = [`**${`Fetched: ${url}`}**`];
  if (title) lines.push(`**${`Title: ${title}`}**`);
  if (contentType) lines.push(`**${`Content-Type: ${contentType}`}**`);
  return `${lines.join("\n")}\n\n`;
}

function formatTruncation(truncation: TruncationResult, path: string): string {
  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  return `\n\n[${`Content was truncated; full content saved to: ${path}`} ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}, ${omittedLines} lines and ${formatSize(omittedBytes)} omitted.]`;
}

export async function webFetch(
  _id: string,
  params: WebFetchInput,
  signal: AbortSignal,
  onUpdate: AgentToolUpdateCallback | undefined,
  _ctx: ExtensionContext,
) {
  let url: URL;
  try {
    url = parseAndAssertHttpUrl(params.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Web fetch failed: ${message}` }],
      details: { url: params.url, error: message } satisfies WebFetchDetails,
    };
  }

  onUpdate?.({
    content: [{ type: "text", text: `Fetching ${url.toString()}…` }],
    details: { url: url.toString() },
  });

  try {
    // Validate hostnames before sending them to either a direct connection or
    // a hosted fetch provider. The direct HTTP path additionally pins this
    // validation into the socket lookup itself.
    await assertPublicDns(url);
    const { config } = loadWebSearchConfig();
    const providerName = resolveApiProviderName(config);
    const provider = createSearchProvider(providerName, resolveProviderCredentials(config, providerName));
    let response: FetchResponse | undefined;
    let backend: string | undefined;

    const interceptors = getInterceptors(config.interceptors?.github, () => {
      onUpdate?.({
        content: [{ type: "text", text: "[pi-web-search] Install the `gh` CLI for better GitHub repository access, including private repositories." }],
        details: { url: url.toString(), backend: "github" },
      });
    });
    for (const interceptor of interceptors) {
      const intercepted = await interceptor.intercept(url.toString(), { raw: params.raw ?? false, signal });
      if (intercepted) {
        response = intercepted;
        backend = interceptor.name;
        break;
      }
    }
    if (!response && "fetch" in provider) {
      response = await (provider as FullProvider).fetch(url.toString(), params.raw ?? false, signal);
      backend = providerName;
    }
    if (!response) {
      response = await fetchViaGenericHtml(url.toString(), params.raw ?? false, signal);
      backend = "http";
    }

    const truncation = truncateHead(response.text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    let text = formatHeader(url.toString(), response.title, response.contentType) + truncation.content;
    let fullOutputPath: string | undefined;
    if (truncation.truncated) {
      fullOutputPath = await spillFullContent(response.text);
      text += formatTruncation(truncation, fullOutputPath);
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {
        url: url.toString(),
        backend,
        title: response.title,
        contentType: response.contentType,
        contentLength: response.contentLength,
        ...(truncation.truncated ? { truncation, fullOutputPath } : {}),
      } satisfies WebFetchDetails,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Web fetch failed: ${message}` }],
      details: { url: url.toString(), error: message } satisfies WebFetchDetails,
    };
  }
}
