/**
 * /blackhole-memory command — shows memory pipeline status and content.
 *
 * Created by pi-vcc-om. Replaces OM's standalone /om-status and /om-view.
 * Usage: /blackhole-memory [status|view|full]
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "../om/clipboard.js";
import {
  BUILTIN_PRESETS,
  autoCompactThreshold,
  effectivePresets,
  presetRatioForWindow,
  sessionContextWindow,
  type CompactThresholdConfig,
} from "../om/model-budget.js";
import type { Runtime } from "../om/runtime.js";
import {
  diffProjection,
  entryIndexForId,
  foldLedger,
  fullProjection,
  observationPoolTokens,
  observationToSummaryLine,
  rawTokensAfterIndex,
  rawTokensSinceDropCoverage,
  rawTokensSinceLastCompaction,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  reflectionToSummaryLine,
  visibleProjection,
  type Entry,
  type Projection,
} from "../om/ledger/index.js";
import { readPendingState } from "../om/pending.js";
import {
  isFixedTokenThreshold,
  isManualMode,
  isReserveTokens,
  isWindowRatio,
} from "../core/unified-config.js";
import { i18n, NOTICE_SOURCE } from "../i18n.js";
import { notifyWithSource } from "pi-extensions-i18n";

function firstArg(args: unknown): string | undefined {
  if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
  if (typeof args === "string") return args.trim().split(/\s+/)[0];
  if (args && typeof args === "object" && "mode" in args) {
    const mode = (args as { mode?: unknown }).mode;
    return typeof mode === "string" ? mode : undefined;
  }
  return undefined;
}

function pct(current: number, total: number): number {
  return total > 0 ? Math.round((current / total) * 100) : 0;
}

function pressureHint(config: {
  dropperPressureThreshold: number;
  dropperPoolFullnessThreshold: number;
}): string {
  if (config.dropperPressureThreshold >= 1) return i18n.t("memoryPressureOff");
  const threshold = Math.max(config.dropperPressureThreshold, config.dropperPoolFullnessThreshold);
  return i18n.t("memoryPressureAt", { percent: Math.round(threshold * 100) });
}

/**
 * Basis suffix for the auto-compaction threshold line. Empty for an explicit
 * fixed token threshold; describes the window-derived basis otherwise
 * (issue #60 + preset curves). The preset branch resolves the same ratio the
 * trigger uses, so display and trigger cannot disagree.
 */
function compactThresholdSuffix(cfg: CompactThresholdConfig, window: number): string {
  // Validity (not mere presence) decides the tier — mirrors compactThresholdTokens
  // so display and trigger cannot disagree, even for unnormalized configs.
  if (isFixedTokenThreshold(cfg.compactAfterTokens)) return "";
  if (isWindowRatio(cfg.compactAfterRatio)) {
    return i18n.t("memoryThresholdRatio", { percent: Math.round(cfg.compactAfterRatio * 100), window: window.toLocaleString() });
  }
  if (isReserveTokens(cfg.compactReserveTokens)) {
    return i18n.t("memoryThresholdReserve", { reserve: cfg.compactReserveTokens.toLocaleString(), window: window.toLocaleString() });
  }
  // Preset curve (incl. the out-of-box default preset): describe the effective
  // ratio at this window, resolved by the same pure functions as the trigger.
  const name = cfg.compactAfterPreset ?? "default";
  const anchors = effectivePresets(cfg)[name] ?? BUILTIN_PRESETS.default;
  const ratio = presetRatioForWindow(anchors, window);
  return i18n.t("memoryThresholdPreset", { percent: Math.round(ratio * 100), window: window.toLocaleString(), preset: name });
}

function tokenSum(items: { tokenCount: number }[]): number {
  return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
  return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
  return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
  const rendered = suffixes.filter((s): s is string => s !== undefined);
  return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
  return items.length > 0 ? items.map(render).join("\n") : empty;
}

function renderContentOnlyProjection(
  projection: Projection,
  emptyScope: "visible" | "recorded",
): string {
  const scope = i18n.t(emptyScope === "visible" ? "memoryScopeVisible" : "memoryScopeRecorded");
  return [
    i18n.t("memoryReflectionsTitle"),
    renderList(projection.reflections, reflectionToSummaryLine, i18n.t("memoryNoReflections", { scope })),
    "",
    i18n.t("memoryObservationsTitle"),
    renderList(projection.observations, observationToSummaryLine, i18n.t("memoryNoObservations", { scope })),
  ].join("\n");
}

export function registerMemoryCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("blackhole-memory", {
    description: i18n.t("memoryCommandDescription"),
    handler: async (args, ctx) => {
      runtime.ensureConfig(ctx.cwd, (msg) => notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: msg }));
      const entries = ctx.sessionManager.getBranch() as Entry[];
      const sessionId = ctx.sessionManager.getSessionId();
      const mode = firstArg(args);

      // /blackhole-memory full — show full recorded memory + copy to clipboard
      if (mode === "full") {
        const projection = fullProjection(entries);
        const output = renderContentOnlyProjection(projection, "recorded");
        const copied = await copyTextToClipboard(output).catch(() => false);
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: copied ? i18n.t("memoryCopied", { output }) : i18n.t("memoryCopyFailed", { output }) });
        return;
      }

      // /blackhole-memory view — show visible memory + copy to clipboard
      if (mode === "view") {
        const projection = visibleProjection(entries);
        const output = renderContentOnlyProjection(projection, "visible");
        const copied = await copyTextToClipboard(output).catch(() => false);
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: copied ? i18n.t("memoryCopied", { output }) : i18n.t("memoryCopyFailed", { output }) });
        return;
      }

      // /blackhole-memory (no args) — show status
      if (mode && mode !== "status") {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("memoryUsage") });
        return;
      }

      const folded = foldLedger(entries);
      const visible = visibleProjection(entries);
      const full = fullProjection(entries);
      const drift = diffProjection(visible, full);

      // Manual mode keeps observations in pending.json rather than the branch;
      // include those batches so this line matches the dropper trigger's pool.
      const pending = isManualMode(runtime.config) ? readPendingState(sessionId) : undefined;
      const { tokens: poolTokens } = observationPoolTokens(entries, pending);
      // Manual mode keeps records out of the branch; surface the pending share
      // explicitly so a manual-only user can see where the pool number comes from.
      const branchPoolTokens = pending ? observationPoolTokens(entries).tokens : poolTokens;
      const pendingPoolTokens = poolTokens - branchPoolTokens;
      const poolScopeSuffix = pendingPoolTokens > 0
        ? i18n.t("memoryPoolScope", {
          branch: branchPoolTokens.toLocaleString(),
          pending: pendingPoolTokens.toLocaleString(),
        })
        : "";
      const visibleReflectionTokens = tokenSum(visible.reflections);
      const observationLine = appendSuffixes(
        i18n.t("memoryObservationsStatus", {
          recorded: folded.observations.length,
          dropped: folded.droppedObservationIds.size,
          visible: visible.observations.length,
        }),
        [
          addedSuffix(drift.observationsOnlyInFull.length),
          removedSuffix(drift.droppedOnlyInFull.length),
        ],
      );
      const reflectionLine = appendSuffixes(
        i18n.t("memoryReflectionsStatus", {
          recorded: folded.reflections.length,
          visible: visible.reflections.length,
        }),
        [addedSuffix(drift.reflectionsOnlyInFull.length)],
      );
      let obsProgress = rawTokensSinceObservationCoverage(entries);
      let reflectionProgress = rawTokensSinceReflectionCoverage(entries);
      let dropProgress = rawTokensSinceDropCoverage(entries);
      const compactionProgress = rawTokensSinceLastCompaction(entries);

      // In manual mode, pending coversUpToId entries act as virtual coverage markers
      // that aren't reflected in the branch. Adjust accumulated counts accordingly.
      if (pending) {
        if (pending.observation?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.observation.coversUpToId);
          if (idx >= 0) obsProgress = rawTokensAfterIndex(entries, idx);
        }
        if (pending.reflection?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
          if (idx >= 0) reflectionProgress = rawTokensAfterIndex(entries, idx);
        }
        if (pending.dropped?.coversUpToId) {
          const idx = entryIndexForId(entries, pending.dropped.coversUpToId);
          if (idx >= 0) dropProgress = rawTokensAfterIndex(entries, idx);
        }
      }

      const passiveLines = runtime.config.passive === true
        ? [i18n.t("memoryModeTitle"), i18n.t("memoryPassive"), ""]
        : [];
      const compactionSuffix = isManualMode(runtime.config)
        ? i18n.t("memoryManualSuffix")
        : i18n.t("memoryAutoSuffix", {
          threshold: autoCompactThreshold(runtime.config, ctx.model).toLocaleString(),
          basis: compactThresholdSuffix(runtime.config, sessionContextWindow(ctx.model, runtime.config)),
        });
      const lines = [
        ...passiveLines,
        i18n.t("memoryTitle"),
        observationLine,
        reflectionLine,
        "",
        i18n.t("memoryPipelineTitle"),
        i18n.t("memoryPipelineDescription"),
        i18n.t("memoryObserverProgress", { tokens: obsProgress.toLocaleString(), threshold: runtime.config.observeAfterTokens.toLocaleString() }),
        i18n.t("memoryReflectorProgress", { tokens: reflectionProgress.toLocaleString(), threshold: runtime.config.reflectAfterTokens.toLocaleString() }),
        i18n.t("memoryDropperProgress", {
          pool: pct(poolTokens, runtime.config.observationsPoolMaxTokens),
          eligible: Math.round(runtime.config.dropperPoolFullnessThreshold * 100),
          pressure: pressureHint(runtime.config),
          progress: dropProgress.toLocaleString(),
          threshold: runtime.config.reflectAfterTokens.toLocaleString(),
        }),
        i18n.t("memoryCompactionProgress", { tokens: compactionProgress.toLocaleString(), suffix: compactionSuffix }),
        i18n.t("memoryObservationPool", {
          current: poolTokens.toLocaleString(),
          max: runtime.config.observationsPoolMaxTokens.toLocaleString(),
          percent: pct(poolTokens, runtime.config.observationsPoolMaxTokens),
          scope: poolScopeSuffix,
        }),
        i18n.t("memoryReflectionPool", { tokens: visibleReflectionTokens.toLocaleString() }),
      ];

      // Show pending data when manual mode is active
      if (pending) {
        const hasObs = !!pending.observation;
        const hasRef = !!pending.reflection;
        const hasDrop = !!pending.dropped;
        if (hasObs || hasRef || hasDrop) {
          lines.push("", i18n.t("memoryPendingTitle"));
          if (hasObs) lines.push(i18n.t("memoryPendingObservation"));
          if (hasRef) lines.push(i18n.t("memoryPendingReflection"));
          if (hasDrop) lines.push(i18n.t("memoryPendingDropper"));
          const preambleCap = runtime.config.observerPreambleMaxTokens > 0
            ? runtime.config.observerPreambleMaxTokens
            : Math.round(runtime.config.observerChunkMaxTokens * 0.3);
          const pctNote = runtime.config.observerPreambleMaxTokens > 0
            ? ""
            : i18n.t("memoryPreambleDefaultNote", {
              percent: 30,
              chunk: runtime.config.observerChunkMaxTokens.toLocaleString(),
            });
          lines.push(i18n.t("memoryPreambleCap", { tokens: preambleCap.toLocaleString(), note: pctNote }));
          lines.push(i18n.t("memoryRunBlackhole"));
        }
      }

      if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
        lines.push("", i18n.t("memoryInFlightTitle"));
        if (runtime.consolidationInFlight) {
          const phase = runtime.consolidationPhase
            ? i18n.t("memoryPhaseSuffix", { phase: runtime.consolidationPhase })
            : "";
          lines.push(i18n.t("memoryConsolidationRunning", { phase }));
        }
        if (runtime.compactInFlight) lines.push(i18n.t("memoryAutoCompactionRunning"));
        if (runtime.compactHookInFlight) lines.push(i18n.t("memoryCompactionHookRunning"));
      }
      // Issue #92: scheduled auto-compactions skipped because the extension ctx
      // went stale before the deferred compaction ran (in-memory subagent/flow
      // sessions disposed right after agent_end). Process-wide counter.
      if ((runtime.staleCtxSkippedCompactions ?? 0) > 0) {
        lines.push("", i18n.t("memorySkippedCompactions", { count: runtime.staleCtxSkippedCompactions.toLocaleString() }));
      }
      if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
        lines.push("", i18n.t("memoryLastErrorTitle"));
        if (runtime.lastObserverError) lines.push(i18n.t("memoryObserverLabel", { message: runtime.lastObserverError }));
        if (runtime.lastReflectorError) lines.push(i18n.t("memoryReflectorLabel", { message: runtime.lastReflectorError }));
        if (runtime.lastDropperError) lines.push(i18n.t("memoryDropperLabel", { message: runtime.lastDropperError }));
      }

      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: lines.join("\n") });
    },
  });
}
