import * as z from "zod";
import {
  ACTIVITY_ROWS_RANGE,
  DEFAULT_CLEAN_MODE_CONFIG,
  type CleanModeConfig,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toRowCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return rounded >= ACTIVITY_ROWS_RANGE.min && rounded <= ACTIVITY_ROWS_RANGE.max
    ? rounded
    : fallback;
}

/** Normalizes partial and retired clean-mode config without making one bad field fatal. */
export function normalizeConfig(raw: unknown): CleanModeConfig {
  const record = isRecord(raw) ? raw : {};
  return {
    enabled: toBoolean(record.enabled, DEFAULT_CLEAN_MODE_CONFIG.enabled),
    autoExpandWhileRunning: toBoolean(record.autoExpandWhileRunning, DEFAULT_CLEAN_MODE_CONFIG.autoExpandWhileRunning),
    showRunHeader: toBoolean(record.showRunHeader, DEFAULT_CLEAN_MODE_CONFIG.showRunHeader),
    enableActionGroups: toBoolean(record.enableActionGroups, DEFAULT_CLEAN_MODE_CONFIG.enableActionGroups),
    showActivityArea: toBoolean(record.showActivityArea, DEFAULT_CLEAN_MODE_CONFIG.showActivityArea),
    activityRows: toRowCount(record.activityRows, DEFAULT_CLEAN_MODE_CONFIG.activityRows),
    animateActivity: toBoolean(record.animateActivity, DEFAULT_CLEAN_MODE_CONFIG.animateActivity),
    hideThinking: toBoolean(record.hideThinking, DEFAULT_CLEAN_MODE_CONFIG.hideThinking),
    hideExtensionEntries: toBoolean(record.hideExtensionEntries, DEFAULT_CLEAN_MODE_CONFIG.hideExtensionEntries),
  };
}

/** Spark validates by normalization so legacy partial files keep their per-field fallback behavior. */
export const cleanModeConfigSchema = z.unknown().transform(normalizeConfig);
