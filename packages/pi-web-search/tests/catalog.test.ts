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

async function loadCatalog() {
  const path = new URL("../locales/index.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, string>>;
}

test("catalog entries contain zh-CN and en-US", async () => {
  const catalog = await loadCatalog();
  for (const [key, value] of Object.entries(catalog)) {
    assert.equal(typeof value["zh-CN"], "string", `${key} missing zh-CN`);
    assert.equal(typeof value["en-US"], "string", `${key} missing en-US`);
  }
});

test("agent-facing tool descriptions and prompts stay fixed in English", async () => {
  const catalog = await loadCatalog();
  for (const key of AGENT_PROMPT_KEYS) {
    assert.equal(catalog[key]["zh-CN"], catalog[key]["en-US"], `${key} must not vary by UI locale`);
    assert.match(catalog[key]["en-US"], /[A-Za-z]/, `${key} must be English`);
  }
});
