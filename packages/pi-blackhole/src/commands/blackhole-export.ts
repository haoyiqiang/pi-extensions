/**
 * /blackhole-export command — distill the project's observational memory
 * (observations, reflections across past session files + pending buffers)
 * into an import-ready markdown artifact. plan-07 Appendix A.
 */
import { writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { i18n, NOTICE_SOURCE } from "../i18n.js";
import { notifyWithSource } from "pi-utils";

function defaultOutPath(cwd: string, now: Date): string {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 13).replace(/[-T]/g, "") + iso.slice(14, 16);
  return join(cwd, `memory-export-${stamp}.md`);
}

export const registerBlackholeExportCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("blackhole-export", {
    description: i18n.t("exportCommandDescription"),
    handler: async (args: string, ctx) => {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("exportStarting") });
      // Yield so the TUI can paint the warning before the heavy scan blocks.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const outMatch = args.match(/\bout:(\S+)/);
      const now = new Date();
      const outPath = outMatch
        ? isAbsolute(outMatch[1])
          ? outMatch[1]
          : join(ctx.cwd, outMatch[1])
        : defaultOutPath(ctx.cwd, now);

      if (outMatch && !outPath.toLowerCase().endsWith(".md")) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("exportPathNotMarkdown", { path: outPath }) });
        return;
      }

      const resolvedOut = resolve(outPath);
      const userOut = outMatch?.[1];
      if (userOut && !isAbsolute(userOut)) {
        const rel = relative(resolve(ctx.cwd), resolvedOut);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("exportPathEscapes", { path: outPath }) });
          return;
        }
      }

      const { findGitRoot } = await import("../project-recall/session-dir.js");
      const { root: gitRoot, warning: gitWarning } = await findGitRoot(ctx.cwd);
      if (gitWarning) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: gitWarning });
      }
      const activeSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

      // Throttled progress: Scanning N files… keeps the TUI alive during the
      // ~35s (98 files) to ~2min (644 files) corpus walk.
      let lastProgressAt = 0;
      const onProgress = ({
        scanned,
        total,
      }: {
        scanned: number;
        total: number;
        phase: string;
      }) => {
        const t = Date.now();
        if (t - lastProgressAt < 800 && scanned !== 0 && scanned !== total) return;
        lastProgressAt = t;
        if (scanned === 0 && total > 0) {
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("exportScanningMarkers", { total }) });
        } else if (total > 0) {
          notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("exportScanningProgress", { scanned, total }) });
        }
      };

      const { buildProjectMemoryCorpusAsync } = await import("../project-recall/corpus.js");
      const corpus = await buildProjectMemoryCorpusAsync(
        {
          cwd: ctx.cwd,
          gitRoot,
          activeSessionFile,
          agentDir: getAgentDir(),
        },
        onProgress,
      );

      if (
        corpus.observations.length === 0 &&
        corpus.reflections.length === 0 &&
        corpus.droppedIds.size === 0
      ) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("exportNoneFound", { project: basename(corpus.projectRoot), sessions: corpus.sessionsConsidered }) });
        return;
      }

      if (corpus.observations.length > 0 || corpus.reflections.length > 0) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("exportRanking", { observations: corpus.observations.length, reflections: corpus.reflections.length }) });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const { buildExportMarkdownAsync } = await import("../project-recall/format-export.js");
      const { markdown, stats } = await buildExportMarkdownAsync(corpus, {
        now: now.getTime(),
        title: basename(corpus.projectRoot),
      });

      try {
        writeFileSync(outPath, markdown, "utf-8");
      } catch (error) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "error", message: i18n.t("exportWriteFailed", { path: outPath, error: String(error) }) });
        return;
      }

      const covered = stats.suppressedByReflections > 0 ? i18n.t("exportCoveredSuffix", { count: stats.suppressedByReflections }) : "";
      const lines = [
        i18n.t("exportDone", { path: outPath }),
        "",
        i18n.t("exportSessionsLine", { considered: stats.sessionsConsidered, withMarkers: stats.filesWithMarkers }),
        i18n.t("exportObservationsLine", { total: stats.observationsTotal, rendered: stats.observationsRendered, duplicates: stats.duplicatesCollapsed, filtered: stats.observationsFiltered, covered }),
        stats.topicGroups > 0 ? i18n.t("exportTopicGroups", { count: stats.topicGroups }) : null,
        i18n.t("exportReflectionsLine", { count: stats.reflectionsTotal }),
      ];
      if (stats.orphanedObservations > 0 || stats.orphanedReflections > 0) {
        lines.push(i18n.t("exportUnattributed", { observations: stats.orphanedObservations, reflections: stats.orphanedReflections, sessions: stats.orphanedSessions }));
      }
      if (stats.droppedExcluded > 0) {
        lines.push(i18n.t("exportDroppedExcluded", { count: stats.droppedExcluded }));
      }
      lines.push("", i18n.t("exportFooter"));

      pi.sendMessage({
        customType: "blackhole-export",
        content: lines.join("\n"),
        display: true,
      });
    },
  });
};
