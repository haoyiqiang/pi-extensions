import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Input, isKeyRelease, Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { i18n } from "../i18n.js";
import type { Theme } from "./agent-widget.js";

export interface ExtensionOption {
  value: string;
  description?: string;
  available: boolean;
  aliases?: string[];
  paths?: string[];
}

// Normalize only an explicit saved selector's identity. No directory traversal or
// new candidate discovery: these paths are matched against the native catalog.
function savedSelectorPaths(value: string, cwd: string): string[] {
  const path = resolve(cwd, value === "~" ? homedir() : value.startsWith("~/") ? `${homedir()}/${value.slice(2)}` : value);
  const identities = [path];
  try {
    identities.push(realpathSync(path));
    if (!statSync(path).isDirectory()) return identities;
    let entries: string[] = [];
    try {
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
      if (Array.isArray(manifest.pi?.extensions)) {
        entries = manifest.pi.extensions.filter((entry): entry is string => typeof entry === "string")
          .map(entry => resolve(path, entry)).filter(entry => existsSync(entry));
      }
    } catch { /* Index fallback mirrors native directory entrypoint identity. */ }
    if (entries.length === 0) {
      const index = [join(path, "index.ts"), join(path, "index.js")].find(entry => existsSync(entry));
      if (index) entries = [index];
    }
    for (const entry of entries) {
      identities.push(entry);
      try { identities.push(realpathSync(entry)); } catch { /* Preserve the declared identity. */ }
    }
  } catch { /* Unavailable selectors are still kept verbatim. */ }
  return identities;
}

/** Keep saved entries visible even when the current discovery cannot find them. */
export function extensionPickerOptions(options: readonly ExtensionOption[], selected: readonly string[], cwd = process.cwd()): ExtensionOption[] {
  const entries = new Map(options.map(option => [option.value, { ...option }]));
  for (const value of selected) {
    if (entries.has(value)) continue;
    const isPath = /[/\\\\]/u.test(value) || value.startsWith("~");
    const paths = isPath ? savedSelectorPaths(value, cwd) : [];
    const matches = options.filter(option => isPath
      ? option.paths?.some(path => paths.includes(path))
      : [option.value, ...(option.aliases ?? [])].some(alias => alias.toLowerCase() === value.toLowerCase()));
    // Preserve the saved selector verbatim; do not offer its canonical alias as a
    // second, newly selected resource (including Ctrl+A). Unknowns remain visible.
    for (const option of matches) if (!selected.includes(option.value)) entries.delete(option.value);
    entries.set(value, matches.length ? {
      value, available: matches.some(option => option.available),
      description: matches.map(option => option.description).filter(Boolean).join(" · "),
    } : { value, available: false });
  }
  return [...entries.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/** Draft-only selection. Enter commits; Escape discards without any persistence. */
export class ExtensionsPicker implements Component, Focusable {
  private readonly input = new Input({ prompt: "" });
  private readonly options: ExtensionOption[];
  private readonly selected: Set<string>;
  private list: SelectList;

  constructor(
    options: readonly ExtensionOption[],
    selected: readonly string[],
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: string[] | undefined) => void,
    cwd = process.cwd(),
  ) {
    this.options = extensionPickerOptions(options, selected, cwd);
    this.selected = new Set(selected);
    this.list = this.buildList();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private filteredOptions(): ExtensionOption[] {
    const query = this.input.getValue().toLowerCase();
    return this.options.filter(option => `${option.value} ${option.description ?? ""}`.toLowerCase().includes(query));
  }

  private buildList(keepValue?: string): SelectList {
    const options = this.filteredOptions();
    const list = new SelectList(options.map(option => ({
      value: option.value,
      label: `${this.selected.has(option.value) ? "[x]" : "[ ]"} ${option.value}`,
      description: option.available
        ? option.description
        : i18n.t("extensionDefaults.unavailable"),
    })), 10, {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("muted", text),
      noMatch: () => this.theme.fg("muted", i18n.t("extensionDefaults.noMatches")),
    });
    const index = options.findIndex(option => option.value === keepValue);
    if (index >= 0) list.setSelectedIndex(index);
    return list;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) { this.done(undefined); return; }
    if (matchesKey(data, Key.enter)) { this.done([...this.selected].sort()); return; }
    if (matchesKey(data, "space")) {
      const item = this.list.getSelectedItem();
      if (item) {
        if (this.selected.has(item.value)) this.selected.delete(item.value);
        else this.selected.add(item.value);
      }
      this.list = this.buildList(item?.value);
    } else if (matchesKey(data, "ctrl+a")) {
      for (const option of this.options) if (option.available) this.selected.add(option.value);
      this.list = this.buildList(this.list.getSelectedItem()?.value);
    } else if (matchesKey(data, "ctrl+r")) {
      this.selected.clear();
      this.list = this.buildList(this.list.getSelectedItem()?.value);
    } else if ((["up", "down", "pageUp", "pageDown", "home", "end"] as const).some(key => matchesKey(data, key))) {
      this.list.handleInput(data);
    } else {
      this.input.handleInput(data);
      this.list = this.buildList();
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const title = this.theme.fg("accent", this.theme.bold(i18n.t("extensionDefaults.pickerTitle")));
    const search = i18n.t("extensionDefaults.search");
    return [
      truncateToWidth(title, width),
      truncateToWidth(search, width),
      ...this.input.render(width),
      ...this.list.render(width),
      "",
      ...wrapTextWithAnsi(this.theme.fg("muted", i18n.t("extensionDefaults.pickerKeys", { count: this.selected.size })), width),
    ].map(line => truncateToWidth(line, width));
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}
