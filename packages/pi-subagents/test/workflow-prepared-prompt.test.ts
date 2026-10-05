import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { i18n } from "../src/i18n.js";
import { MAX_PREPARED_PROMPT_BYTES, MAX_PROMPT_RESOURCES, snapshotPreparedPrompt, type PreparedWorkflowPrompt, type WorkflowPromptResource } from "../src/workflow/prompt-preparation.js";

const resource = (): WorkflowPromptResource => ({
  kind: "skill", name: "review", filePath: resolve("skills/review/SKILL.md"),
  baseDir: resolve("skills/review"), sha256: "a".repeat(64), format: "pi",
});

describe("workflow prepared-prompt boundary", () => {
  it("snapshots and deeply freezes the declared fields without retaining extra caller data", () => {
    const source = { text: "prepared text", requiredTools: ["read", "bash", "read"],
      resources: [{ ...resource(), credential: "must not retain extra data" }], extra: { mutable: true } };
    const result = snapshotPreparedPrompt(source);
    source.text = "changed";
    source.requiredTools.push("write");
    source.resources[0].sha256 = "b".repeat(64);
    expect(result).toEqual({ text: "prepared text", requiredTools: ["read", "bash"], resources: [resource()] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requiredTools)).toBe(true);
    expect(Object.isFrozen(result.resources)).toBe(true);
    expect(Object.isFrozen(result.resources![0])).toBe(true);
    expect(result.resources![0]).not.toBe(source.resources[0]);
  });

  it("reads returned accessor values exactly once before validating and snapshotting them", () => {
    let reads = 0;
    const result = snapshotPreparedPrompt({ get text() { return ++reads === 1 ? "prepared" : "/unexpected"; } });
    expect(result.text).toBe("prepared");
    expect(reads).toBe(1);
  });

  it("copies bounded array indices without consulting a custom iterator", () => {
    const resources = [resource()];
    let iterated = false;
    resources[Symbol.iterator] = function* () {
      iterated = true;
      for (let index = 0; index <= MAX_PROMPT_RESOURCES; index++) yield resource();
      return undefined;
    };
    const result = snapshotPreparedPrompt({ text: "prepared", resources });
    expect(result.resources).toEqual([resource()]);
    expect(iterated).toBe(false);
  });

  it("does not require or invent provenance for plain prepared text", () => {
    expect(snapshotPreparedPrompt({ text: "plain" })).toEqual({ text: "plain" });
  });

  it.each([undefined, null, [], "text", { text: "" }, { text: " \t\n" }, { text: 2 },
    { text: "plain", resources: {} }, { text: "plain", resources: [null] }, { text: "plain", resources: new Array(1) },
    { text: "plain", resources: Array.from({ length: MAX_PROMPT_RESOURCES + 1 }, resource) },
  ])("rejects invalid prepared data %#", value => {
    expect(() => snapshotPreparedPrompt(value as PreparedWorkflowPrompt)).toThrow(i18n.t("workflowResources.invalidPreparation"));
  });

  it.each(["/skill:review input", " \t/unknown", "\n/review"])("refuses an unresolved command %j", text => {
    expect(() => snapshotPreparedPrompt({ text })).toThrow(i18n.t("workflowResources.unexpandedCommand"));
  });

  it.each([
    { kind: "prompt" }, { name: "../review" }, { name: "Review" }, { name: "x".repeat(65) },
    { name: "review\n" }, { name: "review\u2028" }, { name: "review\u2029" },
    { filePath: "relative/SKILL.md" }, { baseDir: "relative" }, { filePath: resolve("bad\nfile") },
    { sha256: "not-a-digest" }, { sha256: "A".repeat(64) }, { sha256: "a".repeat(64) + "\n" }, { format: "automatic" },
  ])("rejects unsupported or ambiguous provenance %j", patch => {
    const value = { text: "prepared", resources: [{ ...resource(), ...patch }] };
    expect(() => snapshotPreparedPrompt(value as PreparedWorkflowPrompt)).toThrow(i18n.t("workflowResources.invalidPreparation"));
  });

  it("uses UTF-8 byte limits rather than UTF-16 string length", () => {
    expect(snapshotPreparedPrompt({ text: "x".repeat(MAX_PREPARED_PROMPT_BYTES) }).text.length).toBe(MAX_PREPARED_PROMPT_BYTES);
    expect(() => snapshotPreparedPrompt({ text: "x".repeat(MAX_PREPARED_PROMPT_BYTES + 1) })).toThrow();
    expect(() => snapshotPreparedPrompt({ text: "中".repeat(Math.ceil(MAX_PREPARED_PROMPT_BYTES / 3)) })).toThrow();
  });

  it.each(["read", ["read", "*"], ["read bash"], [""]])("never treats malformed requirements as permission to continue %#", requiredTools => {
    expect(() => snapshotPreparedPrompt({ text: "prepared", requiredTools } as PreparedWorkflowPrompt)).toThrow();
  });
});
