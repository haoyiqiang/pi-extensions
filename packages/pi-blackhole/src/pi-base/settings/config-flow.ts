/* eslint-disable @typescript-eslint/no-misused-promises */
/**
 * Config flow — pre-selector → edit mode | display-all.
 *
 * The flow owns all config-knowledge: selector routing, scope-locked
 * buffered edit mode, read-only display-all with provenance notes,
 * and all yes/no confirms. The generic toolkit (body/frame/confirm)
 * knows nothing about config scopes.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createConfirm } from "./confirm.ts";
import { createScopeSelector, type ScopeSelectorResult } from "./scope-selector.ts";
import { createSettingsModalBody } from "./body.ts";
import type { SettingsModalBodyComponent } from "./types.ts";
import { frame, frameContentWidth, responsiveInnerRows, DEFAULT_PADDING_X } from "./frame.ts";
import { i18n, NOTICE_SOURCE } from "../../i18n.js";
import { notifyWithSource } from "pi-utils";

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigFlowParams {
  label: string;
  ctx: ExtensionContext;
  cwd: string;
  scopes: { global: boolean; project: boolean; session: boolean };
  sessionInitialized: boolean;
  sessionNote: string;
  defaults: Record<string, unknown>;
  env?: Record<string, string | EnvParser>;
  buildFields: (values: Record<string, unknown>) => Field[];
  layerValues: (scope: "global" | "project" | "env" | "session") => Record<string, unknown>;
  inspect: () => ConfigInspection<Record<string, unknown>>;
  scopeSources: () => ScopeSource[];
  save: (
    values: Record<string, unknown>,
    scope: "global" | "project" | "session",
  ) =>
    | { path: string; created: boolean; changed: boolean }
    | Promise<{ path: string; created: boolean; changed: boolean }>;
  resetScope: (scope: "global" | "project" | "session") => void | Promise<void>;
  deleteScope: (scope: "global" | "project" | "session") => void | Promise<void>;
  onSaved: (values: Record<string, unknown>) => void;
  onChange?: (key: string, value: unknown) => void;
}

// Re-export engine types the flow references directly.
export type { ConfigInspection, ScopeSource } from "../config-manager.js";
import type { ConfigInspection } from "../config-manager.js";
import type { ScopeSource } from "../config-manager.js";
import type { Field } from "../settings/types.js";
import type { EnvParser } from "../config-manager.js";

// ── Constants ──────────────────────────────────────────────────────────

const SCOPE_IDS = ["global", "project", "session"] as const;

function scopeLabel(id: string): string {
  switch (id) {
    case "global":
      return i18n.t("scopeGlobal");
    case "project":
      return i18n.t("scopeProject");
    case "env":
      return i18n.t("scopeEnv");
    case "session":
      return i18n.t("scopeSession");
    case "defaults":
      return i18n.t("scopeDefaults");
    default:
      return id;
  }
}

function winnerLabel(winner: string): string {
  switch (winner) {
    case "global":
      return i18n.t("scopeGlobal");
    case "project":
      return i18n.t("scopeProject");
    case "env":
      return i18n.t("scopeWinnerEnv");
    case "session":
      return i18n.t("scopeSession");
    case "defaults":
    case "default":
      return i18n.t("scopeWinnerDefault");
    default:
      return winner;
  }
}

function editModeTitle(scope: string): string {
  switch (scope) {
    case "global":
      return i18n.t("scopeGlobal");
    case "project":
      return i18n.t("scopeProject");
    case "session":
      return i18n.t("scopeSession");
    default:
      return scope;
  }
}

function selectorEntryLabel(id: string): string {
  switch (id) {
    case "global":
      return i18n.t("selectorConfigureGlobal");
    case "project":
      return i18n.t("selectorConfigureProject");
    case "session":
      return i18n.t("selectorConfigureSession");
    default:
      return id;
  }
}

// ── Extra selector entries (generic extension point for consumers) ─────

export interface ExtraSelectorEntry {
  id: string;
  label: string;
  available: boolean;
  note?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildSelectorEntries(
  params: ConfigFlowParams,
  includeDisplayAll = true,
  extraEntries: ExtraSelectorEntry[] = [],
): Array<{ id: string; label: string; available: boolean; note?: string }> {
  const available: Record<string, boolean> = {
    global: params.scopes.global,
    project: params.scopes.project,
    session: params.scopes.session && params.sessionInitialized,
  };

  const entries: Array<{ id: string; label: string; available: boolean; note?: string }> = [];

  if (includeDisplayAll) {
    entries.push({ id: "display-all", label: i18n.t("selectorDisplayAll"), available: true });
  }

  for (const id of SCOPE_IDS) {
    const ok = available[id];
    const entry: { id: string; label: string; available: boolean; note?: string } = {
      id: id as string,
      label: selectorEntryLabel(id),
      available: ok,
      note: !ok
        ? id === "session"
          ? params.scopes.session
            ? i18n.t("selectorSessionNotInitialized")
            : i18n.t("selectorDisabledByExtension")
          : i18n.t("selectorDisabledByExtension")
        : undefined,
    };
    entries.push(entry);
  }

  if (extraEntries.length > 0) {
    entries.push(...extraEntries);
  }

  return entries;
}

// ── Entry point ────────────────────────────────────────────────────────

export async function openConfigFlow(
  params: ConfigFlowParams,
  extraEntries: ExtraSelectorEntry[] = [],
  onExtraSelect?: (id: string) => Promise<void> | void,
): Promise<void> {
  const result = await openSelector(params, true, extraEntries);
  if (result.kind === "cancel") return;

  if (result.id === "display-all") {
    await openDisplayAll(params);
  } else if (extraEntries.some((e) => e.id === result.id)) {
    if (onExtraSelect) await onExtraSelect(result.id);
  } else {
    await openEditMode(params, result.id);
  }
}

// ── Selector ───────────────────────────────────────────────────────────

function openSelector(
  params: ConfigFlowParams,
  includeDisplayAll = true,
  extraEntries: ExtraSelectorEntry[] = [],
): Promise<ScopeSelectorResult> {
  const entries = buildSelectorEntries(params, includeDisplayAll, extraEntries);
  const { ctx } = params;

  return new Promise<ScopeSelectorResult>((resolve) => {
    // Wrap in a factory matching ctx.ui.custom<T>'s expected signature.
    const factory = (
      tui: TUI,
      theme: Theme,
      _keybindings: unknown,
      done: (result: void) => void,
    ): Component => {
      const component = createScopeSelector({
        title: params.label,
        subtitle: `Configure settings for ${params.label}`,
        entries,
        tui,
        theme,
        done(result: ScopeSelectorResult) {
          done(undefined); // signal overlay teardown to pi
          resolve(result);
        },
      });
      return component;
    };
    void ctx.ui.custom<void>(factory, {
      overlay: true,
      overlayOptions: modalOverlay(),
    });
  });
}

// ── Edit mode ──────────────────────────────────────────────────────────

interface EditHandlers {
  onChange: (key: string, value: unknown) => void;
  onSave: (tui: TUI, theme: Theme, done: (result: void) => void) => Promise<void> | void;
  onRequestExit: (tui: TUI, theme: Theme, done: (result: void) => void) => Promise<void> | void;
  onAction: (id: string, tui: TUI, theme: Theme, done: (result: void) => void) => void;
}

async function openEditMode(params: ConfigFlowParams, scope: string): Promise<void> {
  const values = params.layerValues(scope as "global" | "project" | "env" | "session");
  let inspection = params.inspect();
  const fields = params.buildFields(values);

  // Shared mutable state so onChange and onSave agree on latest values.
  const currentValues: Record<string, unknown> = { ...values };
  const dirtyKeys = new Set<string>();

  function valueNote(field: Field): string | undefined {
    const key = String(field.key);
    const winner = inspection.winners[key];
    if (!winner || winner === scope) return undefined;
    if (!dirtyKeys.has(key)) return i18n.t("valueFromScope", { scope: winnerLabel(winner) });
    return undefined;
  }

  const currentScope = editModeTitle(scope);
  const sources = params.scopeSources();
  const sourceEntry = sources.find((s) => s.scope === scope);
  const subtitle = scope === "session" ? params.sessionNote : (sourceEntry?.note ?? "");
  // Path note for edit mode: static label for env/defaults, resolved
  // path (or pending note) for file-based scopes.
  const editPathNote =
    scope === "env"
      ? i18n.t("envReadOnly")
      : scope === "defaults"
        ? i18n.t("builtInDefaults")
        : scope === "session"
          ? (sourceEntry?.path ?? sourceEntry?.note ?? "")
          : sourceEntry?.exists && sourceEntry.path
            ? sourceEntry.path
            : (sourceEntry?.note ?? "");

  const wrappedFields = fields.map((f) => ({
    ...f,
    valueNote: () => valueNote(f),
  }));

  // Per-flow body ref so nested async confirm handlers can mount overlays.
  let activeEditBody: SettingsModalBodyComponent | undefined;

  async function saveEdit(tui: TUI, theme: Theme, done: (result: void) => void): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [i18n.t("confirmSaveTo", { scope: currentScope })],
          confirmLabel: i18n.t("confirmSave"),
          danger: false,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(
        c,
        i18n.t("confirmSaveToTitle", { scope: currentScope }),
      );
    });

    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }

    try {
      const res = await params.save(
        { ...currentValues },
        scope as "global" | "project" | "session",
      );
      if (res.created && scope === "project") {
        notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("projectConfigWritten", { path: res.path }) });
      }
      params.onSaved(currentValues);
      dirtyKeys.clear();
      done(undefined);
    } catch (err) {
      notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function discardEdit(tui: TUI, theme: Theme, done: (result: void) => void): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [i18n.t("confirmDiscardChanges")],
          confirmLabel: i18n.t("confirmDiscard"),
          danger: true,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(c);
    });

    if (confirmed) {
      done(undefined);
    } else {
      activeEditBody?.dismissOverlay();
    }
  }

  async function resetEdit(tui: TUI, theme: Theme): Promise<void> {
    const currentScope = editModeTitle(scope);
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [i18n.t("confirmResetToDefaults", { scope: currentScope })],
          confirmLabel: i18n.t("confirmReset"),
          danger: true,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(c);
    });

    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }

    try {
      await params.resetScope(scope as "global" | "project" | "session");
      const fresh = params.layerValues(scope as "global" | "project" | "env" | "session");
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function deleteEdit(tui: TUI, theme: Theme): Promise<void> {
    const currentScope = editModeTitle(scope);
    const confirmed = await new Promise<boolean>((resolve) => {
      const c = createConfirm(
        {
          message: [i18n.t("confirmDeleteConfig", { scope: currentScope })],
          confirmLabel: i18n.t("confirmDelete"),
          danger: true,
        },
        resolve,
        { tui, theme },
      );
      (activeEditBody ?? ({} as SettingsModalBodyComponent)).mountOverlay(c);
    });

    if (!confirmed) {
      activeEditBody?.dismissOverlay();
      return;
    }

    try {
      await params.deleteScope(scope as "global" | "project" | "session");
      const fresh = params.layerValues(scope as "global" | "project" | "env" | "session");
      activeEditBody?.setValues(fresh);
      dirtyKeys.clear();
      inspection = params.inspect();
      activeEditBody?.dismissOverlay();
    } catch (err) {
      notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const handlers: EditHandlers = {
    onChange(key, value) {
      currentValues[key] = value;
      dirtyKeys.add(key);
      params.onChange?.(key, value);
    },
    onSave(tui, theme, done) {
      return saveEdit(tui, theme, done);
    },
    onRequestExit(tui, theme, done) {
      return discardEdit(tui, theme, done);
    },
    onAction(id: string, tui: TUI, theme: Theme, done: (result: void) => void) {
      switch (id) {
        case "save":
          void saveEdit(tui, theme, done).catch((err) =>
            notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) }),
          );
          break;
        case "discard":
          void discardEdit(tui, theme, done).catch((err) =>
            notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) }),
          );
          break;
        case "reset":
          void resetEdit(tui, theme).catch((err) =>
            notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) }),
          );
          break;
        case "delete":
          void deleteEdit(tui, theme).catch((err) =>
            notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) }),
          );
          break;
      }
    },
  };

  // Use a factory wrapper so tui/theme are available to nested confirm
  // handlers and the body's close callback.
  await params.ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const body = createSettingsModalBody(
        {
          title: `${params.label} — ${currentScope}`,
          fields: wrappedFields,
          mode: "buffered",
          closeOnSave: false,
          enableSearch: true,
          pathNote: editPathNote,
          actions:
            scope === "session"
              ? [
                  { id: "save", label: i18n.t("confirmSave") },
                  { id: "discard", label: i18n.t("confirmDiscard") },
                  { id: "reset", label: i18n.t("confirmReset"), danger: true },
                ]
              : [
                  { id: "save", label: i18n.t("confirmSave") },
                  { id: "discard", label: i18n.t("confirmDiscard") },
                  { id: "reset", label: i18n.t("confirmReset"), danger: true },
                  { id: "delete", label: i18n.t("confirmDelete"), danger: true },
                ],
          onSave: () => handlers.onSave(tui, theme, done),
          onChange: handlers.onChange,
          onRequestExit: () => handlers.onRequestExit(tui, theme, done),
          onAction: (id) => handlers.onAction(id, tui, theme, done),
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(undefined),
        },
      ) as SettingsModalBodyComponent;

      activeEditBody = body;
      return body;
    },
    { overlay: true, overlayOptions: modalOverlay() },
  );
}

async function openDisplayAll(params: ConfigFlowParams): Promise<void> {
  const inspection = params.inspect();
  const sources = params.scopeSources();

  // Tab scopes in precedence order.
  const tabDefs: Array<{ id: string; scope: string; label: string }> = [];
  if (params.scopes.global !== false) {
    tabDefs.push({ id: "global", scope: "global", label: scopeLabel("global") });
  }
  if (params.scopes.project !== false) {
    tabDefs.push({ id: "project", scope: "project", label: scopeLabel("project") });
  }

  if (params.env && Object.keys(params.env).length > 0) {
    tabDefs.push({ id: "env", scope: "env", label: scopeLabel("env") });
  }
  if (params.scopes.session && params.sessionInitialized) {
    tabDefs.push({ id: "session", scope: "session", label: scopeLabel("session") });
  }
  tabDefs.push({ id: "defaults", scope: "defaults", label: scopeLabel("defaults") });

  const subtitle = sources.map((s) => `${s.label}: ${s.note}`).join("\n");

  // Per-tab path/location notes rendered under the subtitle.
  const tabPathNotes: Record<string, string> = {};
  for (const source of sources) {
    if (source.scope === "session") {
      tabPathNotes["session"] = source.path ?? source.note;
    } else {
      // global / project: use the resolved path when it exists, otherwise the note text
      tabPathNotes[source.scope] = source.exists && source.path ? source.path : source.note;
    }
  }
  // Static labels for scopes not covered by scopeSources().
  tabPathNotes["env"] = i18n.t("envReadOnly");
  tabPathNotes["defaults"] = i18n.t("builtInDefaults");

  // Pre-build field arrays per tab (same field keys, different values + notes).
  const tabFields: Record<string, Field[]> = {};
  for (const tab of tabDefs) {
    let layerVals: Record<string, unknown>;
    if (tab.scope === "defaults") {
      layerVals = { ...params.defaults };
    } else {
      layerVals = params.layerValues(tab.scope as "global" | "project" | "env" | "session");
    }
    const raw = params.buildFields(layerVals);
    tabFields[tab.id] = raw.map((f) => ({
      ...f,
      tab: tab.id,
      valueNote: displayValueNote(f, tab.id, inspection, params.env),
    }));
  }

  let currentTabId = tabDefs[0]!.id;

  // Flatten all tab fields so the body can filter by tab id on render.
  const allFields = tabDefs.flatMap((tab) => tabFields[tab.id] ?? []);

  // Use a factory wrapper so tui/theme flow through to the body's close
  // callback and nested edit-mode open calls.
  await params.ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      // Mutable path note so onActiveTabChange can update it after mount.
      const pathNoteRef: { current: string } = { current: tabPathNotes[currentTabId] };
      const body = createSettingsModalBody(
        {
          title: params.label,
          tabs: tabDefs.map((t) => ({ id: t.id, label: t.label })),
          initialTab: currentTabId,
          fields: allFields,
          readOnly: true,
          pathNote: pathNoteRef.current,
          actions: [
            { id: "edit", label: i18n.t("confirmEdit") },
            { id: "cancel", label: i18n.t("confirmCancel") },
          ],
          onAction(id: string) {
            switch (id) {
              case "cancel":
                queueMicrotask(() => done(undefined));
                break;
              case "edit":
                queueMicrotask(() => done(undefined));
                const isEditableScope =
                  (currentTabId === "global" && params.scopes.global) ||
                  (currentTabId === "project" && params.scopes.project) ||
                  (currentTabId === "session" && params.scopes.session);
                if (isEditableScope) {
                  void openEditMode(params, currentTabId).catch((err) =>
                    notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) }),
                  );
                } else {
                  void openSelector(params, false)
                    .then((result) => {
                      if (result.kind === "cancel") {
                        return openDisplayAll(params);
                      }
                      if (result.id !== "display-all") {
                        return openEditMode(params, result.id);
                      }
                      return undefined;
                    })
                    .catch((err) =>
                      notifyWithSource({ ctx: params.ctx, source: NOTICE_SOURCE, level: "error", message: err instanceof Error ? err.message : String(err) }),
                    );
                }
                break;
            }
          },
          onActiveTabChange(tabId: string) {
            currentTabId = tabId;
            // Values are pre-computed per tab on each field; no setValues needed.
            // Update the path note to reflect the newly active tab.
            pathNoteRef.current = tabPathNotes[tabId] ?? "";
          },
        },
        {
          tui,
          theme,
          ctx: params.ctx,
          close: () => done(undefined),
        },
      ) as SettingsModalBodyComponent;

      return body;
    },
    {
      overlay: true,
      overlayOptions: modalOverlay(),
    },
  );
}

function displayValueNote(
  field: Field,
  tabId: string,
  inspection: ConfigInspection<Record<string, unknown>>,
  env?: Record<string, string | EnvParser>,
): string | undefined {
  const key = String(field.key);
  const winner = inspection.winners[key];

  if (tabId === "env" && env?.[key]) {
    const def = env[key];
    const envWins = winner === "env";
    if (typeof def === "string") {
      const isSet = !!process.env[def]?.trim();
      if (!isSet) return `(${def}: unset)`;
      return envWins ? `(${def}) ▸ effective` : `(${def})`;
    }
    const isSet = !!process.env[def.var]?.trim();
    if (!isSet) return `(${def.var}: unset)`;
    return envWins ? `(${def.var}) ▸ effective` : `(${def.var})`;
  }

  if (winner === tabId) return "▸ effective";

  if (winner) return i18n.t("valueFromScope", { scope: winnerLabel(winner) });
  return undefined;
}

// ── Overlay defaults ───────────────────────────────────────────────────

function modalOverlay(): OverlayOptions {
  return { anchor: "center", width: "92%", maxHeight: "95%" };
}
