/**
 * /pi-vcc command — triggers pi-vcc compaction.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/commands/pi-vcc.ts)
 * Modified by pi-vcc-om:
 * - Flushes pending OM state (observations/reflections/dropped) when manual mode is active
 *   before triggering compaction, so the compaction summary includes all accumulated memory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../om/runtime.js";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  notifyMigrationReminder,
  formatCompactionStats,
} from "../hooks/before-compact";
import { readPendingState, clearPendingState, hasPendingData } from "../om/pending.js";
import {
  getCompactionIneligibility,
  type CompactionIneligibility,
} from "../om/inline-compaction.js";
import {
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
} from "../om/ledger/index.js";
import { i18n, NOTICE_SOURCE } from "../i18n.js";
import { notifyWithSource } from "pi-extensions-i18n";

/**
 * One message per host refusal, shared by the pre-check and the onError
 * backstop. "info", not "error": nothing failed — the session simply has
 * nothing above the host's keep-recent budget, which is the same state the
 * auto-compaction trigger treats silently.
 */
const manualRefusalMessage = (reason: CompactionIneligibility): string =>
  reason === "already_compacted"
    ? i18n.t("manualAlreadyCompacted")
    : i18n.t("manualNothingToCompact");

export const registerPiVccCommand = (pi: ExtensionAPI, runtime: Runtime) => {
  const prefixMatch = (value: string, prefix: string): boolean => {
    return value.toLowerCase().startsWith(prefix.toLowerCase());
  };

  pi.registerCommand("blackhole", {
    description: i18n.t("blackholeCommandDescription"),
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        {
          value: "settings",
          label: i18n.t("blackholeSubSettings"),
        },
        {
          value: "changelog",
          label: i18n.t("blackholeSubChangelog"),
        },
        {
          value: "cleanup",
          label: i18n.t("blackholeSubCleanup"),
        },
        { value: "om-off", label: i18n.t("blackholeSubOmOff") },
        { value: "om-on", label: i18n.t("blackholeSubOmOn") },
      ];
      if (!prefix) return subcommands;
      // "configure" is an accepted alias for "settings" (routed by the
      // handler); surface the settings entry when the user types either.
      return subcommands.filter(
        (s) =>
          prefixMatch(s.value, prefix) ||
          (s.value === "settings" && prefixMatch("configure", prefix)),
      );
    },
    handler: async (args, ctx) => {
      // The manual path reads runtime.config below (and the flush depends on it),
      // but a command can be the first thing that runs in a session — load the
      // config before the first read so a configured `compaction: "manual"`
      // session does not fall back to DEFAULTS.
      runtime.ensureConfig(ctx.cwd ?? process.cwd(), (msg) => notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: msg }));
      const sessionId = ctx.sessionManager.getSessionId();

      // Handle subcommands
      const trimmed = (typeof args === "string" ? args : "").trim();
      if (trimmed === "configure" || trimmed === "settings") {
        // Open the config overlay ("configure" kept as a hidden alias)
        const { openBlackholeSettings, config, GLOBAL_CONFIG_DIR } =
          await import("../pi-base/blackhole-settings.js");
        await openBlackholeSettings(ctx);
        runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
        runtime.configLoaded = true;
        return;
      }
      if (trimmed === "changelog") {
        const { openChangelogView } = await import("../changelog/changelog.js");
        await openChangelogView(ctx);
        return;
      }
      if (trimmed === "cleanup") {
        const { handleCleanup } = await import("./cleanup.js");
        await handleCleanup(ctx);
        return;
      }
      if (trimmed === "om-off") {
        const { config, GLOBAL_CONFIG_DIR } = await import("../pi-base/blackhole-settings.js");
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: false },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR,
          );
          runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("omDisabled") });
        } catch {
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("configSaveFailed") });
        }
        return;
      }
      if (trimmed === "om-on") {
        const { config, GLOBAL_CONFIG_DIR } = await import("../pi-base/blackhole-settings.js");
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: true },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR,
          );
          runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("omEnabled") });
        } catch {
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("configSaveFailed") });
        }
        return;
      } // Warn if input starts with a known subcommand but isn't an exact match.
      // Prevents "/blackhole configure foo" from silently becoming a follow-up.
      const SUBCOMMAND_NAMES = ["configure", "settings", "changelog", "cleanup", "om-off", "om-on"];
      const nearMiss = SUBCOMMAND_NAMES.find(
        (name) =>
          trimmed.toLowerCase().startsWith(name.toLowerCase()) && trimmed.length > name.length,
      );
      if (nearMiss) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("subcommandNoArgs", { name: nearMiss }) });
        return;
      }

      // Extract follow-up prompt: everything after the subcommand check
      // that isn't a known subcommand is treated as follow-up text.
      const followUpPrompt = trimmed ? trimmed : null;

      // Pi's compact() runs prepareCompaction() *before* it emits
      // session_before_compact, so a branch it considers ineligible is refused
      // by the host before any blackhole hook runs — nothing downstream can
      // soften it. Ask the host's own question first, and report the refusal as
      // information. Checked before the pending flush below: the flush appends
      // entries, clears the pending buffer and announces it, and a refusal
      // after it would leave a half-applied manual compaction. Custom entries
      // carry no projected messages, so the flush cannot change the verdict.
      const ineligibility = getCompactionIneligibility(
        ctx.sessionManager,
        ctx.sessionManager.getBranch(),
        undefined,
        ctx.model,
      );
      if (ineligibility) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: manualRefusalMessage(ineligibility) });
        return;
      }

      // If compaction is manual (or legacy noAutoCompact): flush pending OM entries
      // into the branch before compacting so the summary includes accumulated memory.
      if (runtime.config.compaction === "manual" && hasPendingData(sessionId)) {
        const pending = readPendingState(sessionId);
        // Write all accumulated observation batches (or latest single batch
        // as fallback for legacy pending.json without batch arrays).
        const obsBatches = pending.observationBatches?.length
          ? pending.observationBatches
          : pending.observation
            ? [pending.observation]
            : [];
        for (const batch of obsBatches) {
          pi.appendEntry(OM_OBSERVATIONS_RECORDED, batch.data);
        }
        // Write all accumulated reflection batches (or latest single batch
        // as fallback for legacy pending.json without batch arrays).
        const reflBatches = pending.reflectionBatches?.length
          ? pending.reflectionBatches
          : pending.reflection
            ? [pending.reflection]
            : [];
        for (const batch of reflBatches) {
          pi.appendEntry(OM_REFLECTIONS_RECORDED, batch.data);
        }
        // Write all accumulated dropper batches (or latest single batch
        // as fallback for legacy pending.json without batch arrays).
        const dropBatches = pending.droppedBatches?.length
          ? pending.droppedBatches
          : pending.dropped
            ? [pending.dropped]
            : [];
        for (const batch of dropBatches) {
          pi.appendEntry(OM_OBSERVATIONS_DROPPED, batch.data);
        }
        clearPendingState(sessionId);
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("pendingFlushed") });
      }

      ctx.compact({
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        onComplete: () => {
          const stats = runtime.compactionStats;
          if (stats) {
            notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: formatCompactionStats(stats) });
          } else {
            notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("compacted") });
          }
          notifyMigrationReminder(sessionId, (msg, level) => notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message: msg }));

          // Fire follow-up prompt after compaction completes
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {});
            } catch {}
          }
        },
        onError: (err) => {
          const message = String(err?.message ?? err);
          // A refusal that slipped past the pre-check (our probe and the host's
          // can disagree — Pi resolves per-model keepRecentTokens overrides) is
          // still a refusal, not a failure.
          if (message.startsWith("Nothing to compact")) {
            notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: manualRefusalMessage("too_small") });
          } else if (message === "Already compacted") {
            notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: manualRefusalMessage("already_compacted") });
          } else if (message === "Compaction cancelled") {
            // Our own-cut guard already named the specific reason before
            // returning { cancel: true }, and Pi renders "Compaction cancelled"
            // itself for manual aborts. A second toast adds nothing.
          } else {
            notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("compactionFailed", { message }) });
          }
        },
      });
    },
  });
};
