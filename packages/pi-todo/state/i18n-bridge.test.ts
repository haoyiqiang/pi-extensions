import { applyLocale, clearLocaleOverride } from "pi-extensions-i18n";
import { afterEach, describe, expect, it } from "vitest";
import { formatStatusLabel, t } from "./i18n-bridge.js";

afterEach(() => clearLocaleOverride());

describe("i18n catalog", () => {
  it("renders English status labels", () => {
    applyLocale("en-US");
    expect(formatStatusLabel("in_progress")).toBe("in progress");
    expect(formatStatusLabel("completed")).toBe("completed");
  });

  it("renders Chinese status labels from the active repository catalog", () => {
    applyLocale("zh-CN");
    expect(formatStatusLabel("in_progress")).toBe("进行中");
    expect(formatStatusLabel("completed")).toBe("已完成");
    expect(t("overlay.heading")).toBe("任务清单");
  });

  it("fails loudly for unknown keys instead of silently falling back", () => {
    expect(() => t("nonexistent.key")).toThrow("Unknown i18n message key");
  });
});
