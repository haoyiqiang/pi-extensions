import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AGENT_PROMPT_KEYS = [
  "webSearch.description",
  "webSearch.query",
  "webSearch.mode",
  "webSearch.provider",
  "webSearch.maxResults",
  "webSearch.urls",
  "urlContext.description",
  "urlContext.query",
  "urlContext.urls",
  "webFetch.description",
  "webFetch.url",
  "webFetch.raw",
  "llm.additionalUrlsPrompt",
  "llm.urlsHeading",
  "llm.codexInstruction",
  "llm.claudeCodeSystem",
] as const;

async function loadLocale(locale: "en-US" | "zh-CN"): Promise<Record<string, string>> {
  const path = new URL(`../locales/${locale}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
}

test("per-locale catalogs contain the same non-empty keys", async () => {
  const [english, chinese] = await Promise.all([loadLocale("en-US"), loadLocale("zh-CN")]);
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const key of Object.keys(english)) {
    assert.ok(english[key].length > 0, `${key} missing en-US`);
    assert.ok(chinese[key].length > 0, `${key} missing zh-CN`);
  }
});

test("agent-facing tool descriptions and prompts stay fixed in English", async () => {
  const [english, chinese] = await Promise.all([loadLocale("en-US"), loadLocale("zh-CN")]);
  for (const key of AGENT_PROMPT_KEYS) {
    assert.equal(chinese[key], english[key], `${key} must not vary by UI locale`);
    assert.match(english[key], /[A-Za-z]/, `${key} must be English`);
  }
});
