/**
 * Blackhole settings — modal-based configuration via ConfigManager.
 *
 * The single config UI: pi-base's ConfigManager + openConfigFlow
 * (scope-selector → edit/display-all modal). `/blackhole configure` is a
 * hidden alias for `/blackhole settings` and opens this modal.
 *
 * Env-var overrides are applied by ConfigManager after load + validate,
 * so they take effect for both the runtime path (loadUnifiedConfig) and
 * the modal path (config.load / config.openSettings).
 *
 * Session-scoped config is enabled: blackhole-specific overrides are
 * persisted to the session JSONL and recovered on session_start.
 */

import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigManager } from "../pi-base/config-manager.js";
import { getPiAgentDir } from "../pi-base/paths.js";
import { DECLARATIVE_ENV_OVERRIDES } from "../core/config-env.js";
import {
  CACHE_RETENTION_VALUES,
  DEFAULTS,
  normalizeCacheRetention,
  normalizeThresholdKnobs,
  type UnifiedConfig,
} from "../core/unified-config.js";
import { effectivePresets } from "../om/model-budget.js";
import { openChangelogView } from "../changelog/changelog.js";
import { i18n } from "../i18n.js";

const CONFIG_FILENAME = "pi-blackhole-config.json";

export const GLOBAL_CONFIG_DIR = join(getPiAgentDir(), "pi-blackhole");

// ── ConfigManager instance ───────────────────────────────────────────────────

export const config = new ConfigManager<UnifiedConfig>({
  id: "pi-blackhole",
  label: "pi-blackhole",
  filename: CONFIG_FILENAME,
  configDir: GLOBAL_CONFIG_DIR,
  defaults: DEFAULTS,
  scopes: { global: true, project: true, session: true },
  sessionConfig: { entryType: "session-config-pi-blackhole" },

  fields: (cfg) => [
    // ── Compaction ──
    {
      key: "compaction",
      type: "enum",
      label: i18n.t("fieldCompactionLabel"),
      description: i18n.t("fieldCompactionDescription"),
      value: cfg.compaction,
      options: ["auto", "manual", "off"],
      optionLabels: {
        auto: i18n.t("fieldCompactionOptionAuto"),
        manual: i18n.t("fieldCompactionOptionManual"),
        off: i18n.t("fieldCompactionOptionOff"),
      },
    },
    {
      key: "compactionEngine",
      type: "enum",
      label: i18n.t("fieldCompactionEngineLabel"),
      description: i18n.t("fieldCompactionEngineDescription"),
      value: cfg.compactionEngine,
      options: ["blackhole", "pi-default"],
      optionLabels: {
        blackhole: i18n.t("fieldCompactionEngineOptionBlackhole"),
        "pi-default": i18n.t("fieldCompactionEngineOptionPiDefault"),
      },
    },
    {
      key: "compactionSummaryMode",
      type: "enum",
      label: i18n.t("fieldCompactionSummaryModeLabel"),
      description: i18n.t("fieldCompactionSummaryModeDescription"),
      value: cfg.compactionSummaryMode,
      options: ["default", "append"],
      optionLabels: {
        default: i18n.t("fieldCompactionSummaryModeOptionDefault"),
        append: i18n.t("fieldCompactionSummaryModeOptionAppend"),
      },
    },
    {
      key: "tailBehavior",
      type: "enum",
      label: i18n.t("fieldTailBehaviorLabel"),
      description: i18n.t("fieldTailBehaviorDescription"),
      value: cfg.tailBehavior,
      options: ["minimal", "pi-default"],
      optionLabels: {
        minimal: i18n.t("fieldTailBehaviorOptionMinimal"),
        "pi-default": i18n.t("fieldTailBehaviorOptionPiDefault"),
      },
    },
    {
      key: "midRunCompaction",
      type: "enum",
      label: i18n.t("fieldMidRunCompactionLabel"),
      description: i18n.t("fieldMidRunCompactionDescription"),
      value: cfg.midRunCompaction,
      options: ["resume", "pause", "off"],
      optionLabels: {
        resume: i18n.t("fieldMidRunCompactionOptionResume"),
        pause: i18n.t("fieldMidRunCompactionOptionPause"),
        off: i18n.t("fieldMidRunCompactionOptionOff"),
      },
    },
    {
      key: "showPreCompactionMessage",
      type: "boolean",
      label: i18n.t("fieldShowPreCompactionMessageLabel"),
      description: i18n.t("fieldShowPreCompactionMessageDescription"),
      value: cfg.showPreCompactionMessage,
      valueDescriptions: {
        on: i18n.t("fieldShowPreCompactionMessageOn"),
        off: i18n.t("fieldShowPreCompactionMessageOff"),
      },
    },
    {
      key: "compactAfterTokens",
      type: "number",
      label: i18n.t("fieldCompactAfterTokensLabel"),
      description: i18n.t("fieldCompactAfterTokensDescription"),
      value: cfg.compactAfterTokens ?? 0,
      min: 0,
      max: 500_000,
      step: 1_000,
    },
    {
      key: "retainedToolOutputMaxTokens",
      type: "number",
      label: i18n.t("fieldRetainedToolOutputMaxTokensLabel"),
      description: i18n.t("fieldRetainedToolOutputMaxTokensDescription"),
      value: cfg.retainedToolOutputMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    // Context-window-derived knobs (issue #60) + preset curve (spec §4). Always
    // visible: 0 means "not set" (the loader treats 0 as unset, so the selected
    // preset curve governs). Type a value to engage the knob; set it back to 0
    // to turn it off. The tokens field above wins whenever it holds an explicit
    // non-zero value; ratio wins over reserve when both are set; the preset
    // select (below) picks the curve that applies when no numeric knob is set.
    {
      key: "compactAfterRatio",
      type: "number",
      label: i18n.t("fieldCompactAfterRatioLabel"),
      description: i18n.t("fieldCompactAfterRatioDescription"),
      value: cfg.compactAfterRatio ?? 0,
      min: 0,
      max: 1,
    },
    {
      key: "compactReserveTokens",
      type: "number",
      label: i18n.t("fieldCompactReserveTokensLabel"),
      description: i18n.t("fieldCompactReserveTokensDescription"),
      value: cfg.compactReserveTokens ?? 0,
      integer: true,
      min: 0,
      max: 2_000_000,
    },
    {
      key: "compactAfterPreset",
      type: "enum",
      label: i18n.t("fieldCompactAfterPresetLabel"),
      description: i18n.t("fieldCompactAfterPresetDescription"),
      value: cfg.compactAfterPreset ?? "default",
      // Options = built-in preset names + any user-added names from the file
      // (same effective-presets merge the resolver uses, so the modal list and
      // runtime resolution cannot disagree).
      options: Object.keys(effectivePresets(cfg)),
      optionLabels: Object.fromEntries(
        Object.keys(effectivePresets(cfg)).map((name) => [
          name,
          name === "default"
            ? i18n.t("fieldCompactAfterPresetOptionDefault")
            : i18n.t("fieldCompactAfterPresetOptionCustom", { name }),
        ]),
      ),
    },

    // ── Observational Memory ──
    {
      key: "memory",
      type: "boolean",
      label: i18n.t("fieldMemoryLabel"),
      description: i18n.t("fieldMemoryDescription"),
      value: cfg.memory,
      valueDescriptions: {
        on: i18n.t("fieldMemoryOn"),
        off: i18n.t("fieldMemoryOff"),
      },
    },
    {
      key: "sessionFallback",
      type: "boolean",
      label: i18n.t("fieldSessionFallbackLabel"),
      description: i18n.t("fieldSessionFallbackDescription"),
      value: cfg.sessionFallback ?? true,
    },
    {
      key: "observeAfterTokens",
      type: "number",
      label: i18n.t("fieldObserveAfterTokensLabel"),
      description: i18n.t("fieldObserveAfterTokensDescription"),
      value: cfg.observeAfterTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "reflectAfterTokens",
      type: "number",
      label: i18n.t("fieldReflectAfterTokensLabel"),
      description: i18n.t("fieldReflectAfterTokensDescription"),
      value: cfg.reflectAfterTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "observationsPoolMaxTokens",
      type: "number",
      label: i18n.t("fieldObservationsPoolMaxTokensLabel"),
      description: i18n.t("fieldObservationsPoolMaxTokensDescription"),
      value: cfg.observationsPoolMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "reflectionsPoolMaxTokens",
      type: "number",
      label: i18n.t("fieldReflectionsPoolMaxTokensLabel"),
      description: i18n.t("fieldReflectionsPoolMaxTokensDescription"),
      value: cfg.reflectionsPoolMaxTokens,
      min: 0,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "observationsPoolTargetTokens",
      type: "number",
      label: i18n.t("fieldObservationsPoolTargetTokensLabel"),
      description: i18n.t("fieldObservationsPoolTargetTokensDescription"),
      value: cfg.observationsPoolTargetTokens,
      min: 500,
      max: 200_000,
      step: 500,
    },
    {
      key: "reflectorInputMaxTokens",
      type: "number",
      label: i18n.t("fieldReflectorInputMaxTokensLabel"),
      description: i18n.t("fieldReflectorInputMaxTokensDescription"),
      value: cfg.reflectorInputMaxTokens,
      min: 1_000,
      max: 500_000,
      step: 1_000,
    },
    {
      key: "dropperInputMaxTokens",
      type: "number",
      label: i18n.t("fieldDropperInputMaxTokensLabel"),
      description: i18n.t("fieldDropperInputMaxTokensDescription"),
      value: cfg.dropperInputMaxTokens,
      min: 1_000,
      max: 500_000,
      step: 1_000,
    },
    {
      key: "observerChunkMaxTokens",
      type: "number",
      label: i18n.t("fieldObserverChunkMaxTokensLabel"),
      description: i18n.t("fieldObserverChunkMaxTokensDescription"),
      value: cfg.observerChunkMaxTokens,
      min: 1_000,
      max: 200_000,
      step: 1_000,
    },
    {
      key: "observerPreambleMaxTokens",
      type: "number",
      label: i18n.t("fieldObserverPreambleMaxTokensLabel"),
      description: i18n.t("fieldObserverPreambleMaxTokensDescription"),
      value: cfg.observerPreambleMaxTokens,
      min: 0,
      max: 100_000,
      step: 500,
    },
    {
      key: "dropperPressureThreshold",
      type: "number",
      label: i18n.t("fieldDropperPressureThresholdLabel"),
      description: i18n.t("fieldDropperPressureThresholdDescription"),
      value: cfg.dropperPressureThreshold,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
    {
      key: "dropperPoolFullnessThreshold",
      type: "number",
      label: i18n.t("fieldDropperPoolFullnessThresholdLabel"),
      description: i18n.t("fieldDropperPoolFullnessThresholdDescription"),
      value: cfg.dropperPoolFullnessThreshold,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
    {
      key: "agentMaxTurns",
      type: "number",
      label: i18n.t("fieldAgentMaxTurnsLabel"),
      description: i18n.t("fieldAgentMaxTurnsDescription"),
      value: cfg.agentMaxTurns,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      key: "providerIdleTimeoutMs",
      type: "number",
      label: i18n.t("fieldProviderIdleTimeoutMsLabel"),
      description: i18n.t("fieldProviderIdleTimeoutMsDescription"),
      value: cfg.providerIdleTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
    },
    {
      key: "cacheRetention",
      type: "enum",
      label: i18n.t("fieldCacheRetentionLabel"),
      description: i18n.t("fieldCacheRetentionDescription"),
      // "unset" is a modal-only sentinel: validate() drops it before the config
      // is persisted, so an untouched field never pins a value in the file.
      value: cfg.cacheRetention ?? "unset",
      options: ["unset", ...CACHE_RETENTION_VALUES],
      optionLabels: {
        unset: i18n.t("fieldCacheRetentionOptionUnset"),
        none: i18n.t("fieldCacheRetentionOptionNone"),
        short: i18n.t("fieldCacheRetentionOptionShort"),
        long: i18n.t("fieldCacheRetentionOptionLong"),
      },
    },
    {
      key: "workerAttemptTimeoutMs",
      type: "number",
      label: i18n.t("fieldWorkerAttemptTimeoutMsLabel"),
      description: i18n.t("fieldWorkerAttemptTimeoutMsDescription"),
      value: cfg.workerAttemptTimeoutMs ?? 0,
      min: 0,
      max: 3_600_000,
      step: 1000,
    },
    {
      key: "fullFoldAlways",
      type: "boolean",
      label: i18n.t("fieldFullFoldAlwaysLabel"),
      description: i18n.t("fieldFullFoldAlwaysDescription"),
      value: cfg.fullFoldAlways,
    },

    // ── UI ──
    {
      key: "statusBar",
      type: "boolean",
      label: i18n.t("fieldStatusBarLabel"),
      description: i18n.t("fieldStatusBarDescription"),
      value: cfg.statusBar,
    },
    {
      key: "showWorkerNotifications",
      type: "boolean",
      label: i18n.t("fieldShowWorkerNotificationsLabel"),
      description: i18n.t("fieldShowWorkerNotificationsDescription"),
      value: cfg.showWorkerNotifications,
      valueDescriptions: {
        on: i18n.t("fieldShowWorkerNotificationsOn"),
        off: i18n.t("fieldShowWorkerNotificationsOff"),
      },
    },

    // ── Debug ──
    {
      key: "debug",
      type: "boolean",
      label: i18n.t("fieldDebugLabel"),
      description: i18n.t("fieldDebugDescription"),
      value: cfg.debug,
    },
    {
      key: "debugLog",
      type: "boolean",
      label: i18n.t("fieldDebugLogLabel"),
      description: i18n.t("fieldDebugLogDescription"),
      value: cfg.debugLog,
    },
  ],

  /**
   * Validate raw loaded data, apply legacy migration, clamp numeric fields,
   * and apply all env-var overrides (both declarative env-map and legacy
   * passive/compaction env vars).
   */
  validate: (raw) => {
    const parsed = { ...raw } as Partial<UnifiedConfig>;

    // ── Migration: legacy keys → new surface ──
    if (parsed.compaction === undefined && parsed.compactionEngine === undefined) {
      if (parsed.passive === true) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (parsed.noAutoCompact === true) {
        parsed.compaction = "manual";
      }
      if (parsed.overrideDefaultCompaction === true) {
        parsed.compactionEngine = "blackhole";
        if (parsed.tailBehavior === undefined) {
          parsed.tailBehavior = "minimal";
        }
      } else if (parsed.overrideDefaultCompaction === false) {
        parsed.compactionEngine = "pi-default";
      }
      delete (parsed as Record<string, unknown>).passive;
      delete (parsed as Record<string, unknown>).noAutoCompact;
      delete (parsed as Record<string, unknown>).overrideDefaultCompaction;
    }

    // ── Legacy passive env vars (Layer 4, highest priority) ──
    const envPassive =
      process.env.PI_BLACKHOLE_PASSIVE ??
      process.env.PI_VCC_OM_PASSIVE ??
      process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE;
    if (envPassive !== undefined) {
      const v = envPassive.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) {
        parsed.compaction = "off";
        parsed.memory = false;
      } else if (["0", "false", "no", "off"].includes(v)) {
        if (raw.passive === true) {
          delete parsed.compaction;
          delete (parsed as Record<string, unknown>).memory;
        }
      }
    }

    // ── Warn on invalid enum env vars (application handled by applyEnvOverrides) ──
    const envCompaction = process.env.PI_BLACKHOLE_COMPACTION;
    if (envCompaction !== undefined) {
      const trimmed = envCompaction.trim().toLowerCase();
      if (!["auto", "manual", "off"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION value "${envCompaction}"; ignoring`,
        );
      }
    }

    const envCompactionEngine = process.env.PI_BLACKHOLE_COMPACTION_ENGINE;
    if (envCompactionEngine !== undefined) {
      const trimmed = envCompactionEngine.trim().toLowerCase();
      if (!["blackhole", "pi-default"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION_ENGINE value "${envCompactionEngine}"; ignoring`,
        );
      }
    }

    const envCompactionSummaryMode = process.env.PI_BLACKHOLE_COMPACTION_SUMMARY_MODE;
    if (envCompactionSummaryMode !== undefined) {
      const trimmed = envCompactionSummaryMode.trim().toLowerCase();
      if (!["default", "append"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_COMPACTION_SUMMARY_MODE value "${envCompactionSummaryMode}"; ignoring`,
        );
      }
    }
    const envMidRunCompaction = process.env.PI_BLACKHOLE_MID_RUN_COMPACTION;
    if (envMidRunCompaction !== undefined) {
      const trimmed = envMidRunCompaction.trim().toLowerCase();
      if (!["resume", "pause", "off"].includes(trimmed)) {
        console.warn(
          `blackhole: invalid PI_BLACKHOLE_MID_RUN_COMPACTION value "${envMidRunCompaction}"; ignoring`,
        );
      }
    }

    // ── Threshold knobs: same scrubber the file loader uses ──
    // 0 means "not set", out-of-range values are dropped, legacy 81000
    // residue is dropped, and preset definitions are validated + sorted —
    // so the modal path agrees with loadUnifiedConfig on every key.
    // (Runs before the merge so an emptied preset name falls back to the
    // DEFAULTS "default", and dropped knobs stay absent. Env overrides
    // re-apply afterwards, so env-set values stay explicit.)
    // SAFETY: parsed is a plain config record; the normalizer only validates or deletes named properties.
    normalizeThresholdKnobs(parsed as unknown as Record<string, unknown>);

    // ── cacheRetention: drop the modal "unset" sentinel and any unsupported value ──
    // Keeps the modal path in lockstep with loadUnifiedConfig's parseConfig,
    // which only accepts none|short|long (case-insensitively, via the same
    // normalizer). Deleting here is also how the modal clears a stored value:
    // the save diff carries the key as undefined, so the key leaves the file.
    const cacheRetention = normalizeCacheRetention(parsed.cacheRetention);
    if (cacheRetention) {
      parsed.cacheRetention = cacheRetention;
    } else {
      delete parsed.cacheRetention;
    }

    // ── Merge with defaults ──
    const merged = { ...DEFAULTS, ...parsed } as UnifiedConfig;

    // ── Numeric field validation ──
    const REQUIRED_NUMERIC_KEYS: readonly (keyof UnifiedConfig)[] = [
      "observeAfterTokens",
      "reflectAfterTokens",
      "retainedToolOutputMaxTokens",
      "observationsPoolMaxTokens",
      "reflectionsPoolMaxTokens",
      "observationsPoolTargetTokens",
      "reflectorInputMaxTokens",
      "dropperInputMaxTokens",
      "observerChunkMaxTokens",
      "observerPreambleMaxTokens",
      "agentMaxTurns",
    ];
    for (const k of REQUIRED_NUMERIC_KEYS) {
      // SAFETY: merged is a plain config object; indexing by dynamic key needs
      // the Record view to read/write numeric fields uniformly.
      const v = (merged as unknown as Record<string, unknown>)[k];
      const minVal = k === "observerPreambleMaxTokens" || k === "reflectionsPoolMaxTokens" ? 0 : 1;
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        ((k === "retainedToolOutputMaxTokens" || k === "reflectionsPoolMaxTokens") &&
          !Number.isInteger(v)) ||
        v < minVal
      ) {
        // SAFETY: dynamic-key write as above; DEFAULTS[k] is always a number
        // for keys in REQUIRED_NUMERIC_KEYS.
        (merged as unknown as Record<string, unknown>)[k] = DEFAULTS[k];
      }
    }

    // dropperPressureThreshold — must be in (0, 1]
    const dpt = merged.dropperPressureThreshold;
    if (typeof dpt !== "number" || !Number.isFinite(dpt) || dpt <= 0 || dpt > 1) {
      merged.dropperPressureThreshold = DEFAULTS.dropperPressureThreshold;
    }

    // dropperPoolFullnessThreshold — must be in (0, 1]
    const dpf = merged.dropperPoolFullnessThreshold;
    if (typeof dpf !== "number" || !Number.isFinite(dpf) || dpf <= 0 || dpf > 1) {
      merged.dropperPoolFullnessThreshold = DEFAULTS.dropperPoolFullnessThreshold;
    }

    // observationsPoolTargetTokens — must be < max
    if (
      merged.observationsPoolTargetTokens === undefined ||
      merged.observationsPoolTargetTokens >= merged.observationsPoolMaxTokens
    ) {
      merged.observationsPoolTargetTokens = Math.floor(merged.observationsPoolMaxTokens / 2);
    }

    return merged;
  },

  env: DECLARATIVE_ENV_OVERRIDES,
});

// ── Public entry point ───────────────────────────────────────────────────────

export async function openBlackholeSettings(ctx: ExtensionContext): Promise<void> {
  await config.openSettings(
    ctx,
    ctx.cwd,
    (_updated) => {
      // Caller (pi-vcc.ts) reloads runtime.config after save.
    },
    GLOBAL_CONFIG_DIR,
    undefined,
    [
      {
        id: "changelog",
        label: i18n.t("settingsActionChangelog"),
        available: true,
      },
    ],
    async (id: string) => {
      if (id === "changelog") await openChangelogView(ctx);
    },
  );
}
