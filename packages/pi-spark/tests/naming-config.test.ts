import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TITLE_CONFIG,
  TITLE_EFFORT_LEVELS,
  isTitleEffort,
  namingConfigSchema,
  parseConfig,
} from "../src/features/naming/config.ts";

const DEFAULTS = {
  automaticNaming: true,
  manualNaming: true,
  targets: { session: true, workspace: true, tab: true },
  title: DEFAULT_TITLE_CONFIG,
};

test("naming defaults enable both entrypoints and all targets without shared mutable state", () => {
  assert.deepEqual(parseConfig({}), DEFAULTS);
  assert.deepEqual(namingConfigSchema.parse({}), DEFAULTS);
  const changed = parseConfig({});
  changed.title.maxTokens = 123;
  changed.targets.tab = false;
  assert.deepEqual(parseConfig({}), DEFAULTS);
  assert.ok(Object.isFrozen(DEFAULT_TITLE_CONFIG));
});

test("naming switches and targets can be disabled independently", () => {
  for (const key of ["automaticNaming", "manualNaming"] as const) {
    assert.deepEqual(parseConfig({ [key]: false }), { ...DEFAULTS, [key]: false });
  }
  for (const target of ["session", "workspace", "tab"] as const) {
    assert.deepEqual(parseConfig({ targets: { [target]: false } }), {
      ...DEFAULTS, targets: { ...DEFAULTS.targets, [target]: false },
    });
  }
});

test("title settings preserve independent budgets and normalize text", () => {
  const title = {
    maxLength: 60, preferredLength: 40, language: "English", instructions: "Use sentence case",
    timeoutMs: 20_000, maxTokens: 4096, effort: "high",
  };
  assert.deepEqual(parseConfig({ title }).title, title);
  assert.deepEqual(parseConfig({ title: { ...title, language: " English ", instructions: " Use sentence case " } }).title, title);
  assert.equal(parseConfig({ title: { maxTokens: 1 } }).title.maxLength, 15);
  assert.equal(parseConfig({ title: { maxLength: 100 } }).title.maxTokens, 2048);
  assert.equal(parseConfig({ title: { timeoutMs: 2_147_483_647 } }).title.timeoutMs, 2_147_483_647);
  for (const effort of TITLE_EFFORT_LEVELS) {
    assert.equal(isTitleEffort(effort), true);
    assert.equal(parseConfig({ title: { effort } }).title.effort, effort);
  }
  for (const effort of ["off", "none", "LOW", "", 1, null, undefined]) assert.equal(isTitleEffort(effort), false);
});

test("invalid shapes, unknown fields and mistyped values fail rather than enable defaults", () => {
  const invalid = [
    null, undefined, [], true, false, "naming", 1,
    { unknown: true }, { allowWorkspaceRename: false },
    { automaticNaming: "false" }, { manualNaming: null },
    { targets: null }, { targets: [] }, { targets: { unknown: true } }, { targets: { session: "false" } },
    { title: null }, { title: [] }, { title: { typo: 1 } },
    { title: { language: " " } }, { title: { language: 1 } },
    { title: { instructions: false } }, { title: { effort: "none" } }, { title: { effort: "LOW" } },
    { title: { effort: 1 } }, { title: { preferredLength: 16 } },
    { title: { maxLength: 9 } }, { title: { timeoutMs: 2_147_483_648 } },
  ];
  for (const value of invalid) {
    assert.throws(() => parseConfig(value), /field|字段/);
    const parsed = namingConfigSchema.safeParse(value);
    assert.equal(parsed.success, false, JSON.stringify(value));
    if (!parsed.success) assert.match(parsed.error.issues[0].message, /field|字段/);
  }
});

test("all numeric naming settings require positive safe integers without coercion", () => {
  for (const key of ["maxLength", "preferredLength", "timeoutMs", "maxTokens"]) {
    for (const value of [0, -1, 1.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2048", null, true]) {
      const config = { title: { [key]: value } };
      assert.throws(() => parseConfig(config), /field|字段/, `${key}=${String(value)}`);
      assert.equal(namingConfigSchema.safeParse(config).success, false);
    }
  }
});
