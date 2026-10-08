import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import { extensionPickerOptions, ExtensionsPicker } from "../src/ui/extensions-picker.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const options = [
  { value: "alpha", description: "global source", available: true },
  { value: "beta", description: "project source", available: true },
];
function mount(selected: string[] = []) {
  const done = vi.fn();
  const render = vi.fn();
  const picker = new ExtensionsPicker(options, selected, theme, render, done);
  return { picker, done, render };
}

describe("default extension multi-select draft", () => {
  it("toggles independently and only commits on Enter", () => {
    const { picker, done } = mount();
    picker.handleInput(" ");
    expect(picker.render(120).join("\n")).toContain("[x] alpha");
    expect(done).not.toHaveBeenCalled();
    picker.handleInput("\u001b[B");
    picker.handleInput(" ");
    expect(picker.render(120).join("\n")).toContain("[x] beta");
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("Escape discards the draft without mutating the original selection", () => {
    const selected = ["beta"];
    const { picker, done } = mount(selected);
    picker.handleInput(" ");
    picker.handleInput("\u001b");
    expect(done).toHaveBeenCalledWith(undefined);
    expect(selected).toEqual(["beta"]);
  });

  it("searches names and sources without losing hidden selections", () => {
    const { picker, done } = mount(["alpha"]);
    picker.handleInput("project");
    const rendered = picker.render(120).join("\n");
    expect(rendered).toContain("beta");
    expect(rendered).not.toContain("[x] alpha");
    picker.handleInput(" ");
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("preserves unknown saved entries until explicitly removed", () => {
    const { picker, done } = mount(["missing"]);
    expect(picker.render(120).join("\n")).toContain(i18n.t("extensionDefaults.unavailable"));
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith(["missing"]);
    expect(extensionPickerOptions(options, ["missing"])).toContainEqual({ value: "missing", available: false });
  });

  it("selects all available entries, and can explicitly clear to an empty list", () => {
    const { picker, done } = mount(["missing"]);
    picker.handleInput("\u0001");
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith(["alpha", "beta", "missing"]);
    const cleared = mount(["alpha", "missing"]);
    cleared.picker.handleInput("\u0012");
    cleared.picker.handleInput("\r");
    expect(cleared.done).toHaveBeenCalledWith([]);
  });

  it("forwards focus to the search input and keeps narrow rendering bounded", () => {
    const { picker } = mount();
    picker.focused = true;
    expect(picker.focused).toBe(true);
    picker.handleInput("nomatch");
    for (const line of picker.render(16)) expect(visibleWidth(line)).toBeLessThanOrEqual(16);
  });

  it("keeps save and cancel instructions visible at a normal terminal width", () => {
    const { picker } = mount();
    const lines = picker.render(80);
    const rendered = lines.join("\n");
    for (const key of ["Enter", "Esc", "Ctrl+A", "Ctrl+R"]) expect(rendered).toContain(key);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it("preserves case aliases and saved paths without offering duplicate canonical resources", () => {
    const catalog = [{ value: "alpha", available: true, aliases: ["src", "alpha"], paths: ["/project/alpha/index.ts"] }];
    const entries = extensionPickerOptions(catalog, ["ALPHA", "./alpha/index.ts", "unknown"], "/project");
    expect(entries.map(entry => entry.value)).toEqual(["./alpha/index.ts", "ALPHA", "unknown"]);
    expect(entries.filter(entry => entry.available).map(entry => entry.value)).toEqual(["./alpha/index.ts", "ALPHA"]);
    const done = vi.fn();
    const picker = new ExtensionsPicker(catalog, ["ALPHA", "./alpha/index.ts", "unknown"], theme, vi.fn(), done, "/project");
    picker.handleInput("\u0001");
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith(["./alpha/index.ts", "ALPHA", "unknown"]);
  });

  it("recognizes saved directory and symlink identities without matching unrelated ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "picker-identity-"));
    try {
      const pkg = join(root, "alpha-dir");
      mkdirSync(join(pkg, "src"), { recursive: true });
      const entry = join(pkg, "src/index.ts");
      writeFileSync(entry, "throw new Error('must not execute');");
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
      const link = join(root, "alpha-link");
      symlinkSync(pkg, link, "junction");
      const fallback = join(root, "beta-dir");
      mkdirSync(fallback);
      writeFileSync(join(fallback, "index.ts"), "throw new Error('must not execute');");
      const catalog = [
        // Native catalog carries both the discovered spelling and its realpath.
        { value: "alpha", available: true, paths: [entry, realpathSync(entry)] },
        { value: "beta", available: true, paths: [join(fallback, "index.ts"), realpathSync(join(fallback, "index.ts"))] },
      ];
      const saved = ["./alpha-dir", "./alpha-link", "./beta-dir", root];
      const entries = extensionPickerOptions(catalog, saved, root);
      expect(entries.map(entry => entry.value).sort()).toEqual([...saved].sort());
      expect(entries.find(entry => entry.value === root)?.available).toBe(false);
      expect(entries.filter(entry => entry.available).map(entry => entry.value)).toEqual(["./alpha-dir", "./alpha-link", "./beta-dir"]);
      const done = vi.fn();
      const picker = new ExtensionsPicker(catalog, saved, theme, vi.fn(), done, root);
      picker.handleInput("\u0001");
      picker.handleInput("\r");
      expect(done).toHaveBeenCalledWith([...saved].sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores Kitty key-release events", () => {
    const { picker, done } = mount();
    picker.handleInput("\u001b[32;1:3u");
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith([]);
  });
});
