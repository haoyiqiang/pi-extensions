/**
 * pi-rewind — /rewind command and Ctrl+Shift+R shortcut
 *
 * Registers the user-facing rewind command which presents a checkpoint
 * browser and restore options.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { RewindState } from "./state.js";
import type { CheckpointData } from "./core.js";
import { restoreCheckpoint, createCheckpoint, diffCheckpoints, sanitizeForRef, git } from "./core.js";
import { i18n, NOTICE_SOURCE } from "./i18n.js";
import { notifyWithSource } from "pi-extensions-i18n";

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatCheckpointLabel(cp: CheckpointData, index: number, _state: RewindState, currentBranch?: string): string {
  const time = formatTimestamp(cp.timestamp);
  const branchTag = (cp.branch && currentBranch && cp.branch !== currentBranch)
    ? i18n.t("branchTagCross", { branch: cp.branch })
    : (cp.branch ? i18n.t("branchTagSame", { branch: cp.branch }) : "");
  const shared = { index: index + 1, time, branchTag };
  if (cp.description) {
    return i18n.t("checkpointLabel", { ...shared, description: cp.description });
  }
  // Fallback for old checkpoints without description
  if (cp.trigger === "resume") return i18n.t("checkpointLabel", { ...shared, description: i18n.t("sessionStart") });
  if (cp.trigger === "tool" && cp.toolName) return i18n.t("toolLabel", { ...shared, tool: cp.toolName });
  return i18n.t("checkpointLabel", { ...shared, description: i18n.t("turnFallback", { index: cp.turnIndex }) });
}

type RestoreMode = "all" | "files" | "conversation" | "cancel";

const RESTORE_OPTIONS: { labelKey: "restoreAll" | "restoreFilesOnly" | "restoreConversationOnly" | "cancel"; value: RestoreMode }[] = [
  { labelKey: "restoreAll", value: "all" },
  { labelKey: "restoreFilesOnly", value: "files" },
  { labelKey: "restoreConversationOnly", value: "conversation" },
  { labelKey: "cancel", value: "cancel" },
];

// ============================================================================
// Rewind flow
// ============================================================================

async function runRewindFlow(
  state: RewindState,
  ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("notAvailable") });
    return;
  }

  // Collect checkpoints sorted newest-first (limit to 25 most recent)
  const MAX_DISPLAY = 25;
  const checkpoints = [...state.checkpoints.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_DISPLAY);

  if (checkpoints.length === 0) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noCheckpoints") });
    return;
  }

  // Build picker items
  const items: string[] = [];
  const currentBranch = await git("rev-parse --abbrev-ref HEAD", state.repoRoot).catch(() => "unknown");
  const undoRef = state.redoStack.length > 0 ? state.redoStack[state.redoStack.length - 1] : null;
  if (undoRef) {
    items.push(i18n.t("undoLastRewind"));
  }
  for (let i = 0; i < checkpoints.length; i++) {
    items.push(formatCheckpointLabel(checkpoints[i], i, state, currentBranch));
  }

  const choice = await ctx.ui.select(i18n.t("selectCheckpointTitle"), items);
  if (!choice) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("cancelled") });
    return;
  }

  // Handle undo
  if (choice === i18n.t("undoLastRewind") && undoRef) {
    await performRestore(state, ctx, undoRef, "files");
    state.redoStack.pop();
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("undoSuccess") });
    return;
  }

  // Find selected checkpoint
  const idx = items.indexOf(choice) - (undoRef ? 1 : 0);
  if (idx < 0 || idx >= checkpoints.length) return;
  const target = checkpoints[idx];

  // Show diff preview
  let diffText = "";
  try {
    const diff = await diffCheckpoints(state.repoRoot, target.worktreeTreeSha, "HEAD");
    if (diff && diff !== "(diff unavailable)") {
      diffText = diff.slice(0, 2000);
    }
  } catch {
    // Continue without preview if diff fails
  }

  if (diffText) {
    const proceed = await ctx.ui.confirm(
      i18n.t("confirmDiffTitle", { index: idx + 1, diff: diffText }),
      i18n.t("confirmProceed"),
    );
    if (!proceed) {
      notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("cancelled") });
      return;
    }
  }

  // Ask restore mode
  const restoreLabels = RESTORE_OPTIONS.map((option) => i18n.t(option.labelKey));
  const modeChoice = await ctx.ui.select(i18n.t("restoreModeTitle"), restoreLabels);
  const mode = RESTORE_OPTIONS.find((option, index) => restoreLabels[index] === modeChoice)?.value ?? "cancel";
  if (mode === "cancel") {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("cancelled") });
    return;
  }

  if (mode === "files" || mode === "all") {
    await performRestore(state, ctx, target, "files");
  }

  if (mode === "conversation" || mode === "all") {
    // Navigate conversation tree to the checkpoint's point
    // Find the entry closest to the checkpoint timestamp
    const branch = ctx.sessionManager.getBranch();
    const targetEntry = branch.reduce((best: any, entry: any) => {
      if (!entry.timestamp) return best;
      const entryTs = new Date(entry.timestamp).getTime();
      if (!best) return entryTs <= target.timestamp ? entry : best;
      const bestTs = new Date(best.timestamp).getTime();
      if (entryTs <= target.timestamp && entryTs > bestTs) return entry;
      return best;
    }, null);

    if (targetEntry) {
      try {
        await ctx.navigateTree(targetEntry.id, { summarize: true });
      } catch {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("conversationPartialFailure") });
      }
    }
  }

  const what = mode === "all" ? i18n.t("whatAll")
    : mode === "files" ? i18n.t("whatFiles") : i18n.t("whatConversation");
  notifyWithSource({
    ctx,
    source: NOTICE_SOURCE,
    level: "info",
    message: i18n.t("rewound", { what, index: idx + 1 }),
  });
}

async function performRestore(
  state: RewindState,
  ctx: { mode?: string; ui: { notify: (msg: string, level: "info" | "warning" | "error") => void; theme?: { fg(color: string, text: string): string } } },
  target: CheckpointData,
  _mode: "files",
): Promise<void> {
  if (!state.repoRoot || !state.sessionId) return;

  // Create before-restore checkpoint (safety net)
  try {
    const beforeId = `before-restore-${state.sessionId}-${Date.now()}`;
    const beforeCp = await createCheckpoint({
      root: state.repoRoot,
      id: beforeId,
      sessionId: state.sessionId,
      trigger: "before-restore",
      turnIndex: 0,
    });
    state.redoStack.push(beforeCp);
  } catch {
    // Continue anyway — we tried
  }

  // Restore files
  try {
    await restoreCheckpoint(state.repoRoot, target);
  } catch (err) {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: "error",
      message: i18n.t("restoreFailed", { error: err instanceof Error ? err.message : String(err) }),
    });
  }
}

// ============================================================================
// Handle fork/tree restore prompts
// ============================================================================

export async function handleForkRestore(
  state: RewindState,
  event: { entryId: string },
  ctx: any,
): Promise<{ cancel: true } | { skipConversationRestore: true } | undefined> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) return undefined;
  if (!ctx.hasUI) return undefined;

  const entry = ctx.sessionManager.getEntry(event.entryId);
  const targetTs = entry?.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

  // Find best checkpoint
  const sorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  const target = sorted.find((cp) => cp.timestamp <= targetTs) ?? sorted[sorted.length - 1];

  if (!target && state.resumeCheckpoint) {
    // Use resume checkpoint as fallback
  }

  const cp = target || state.resumeCheckpoint;

  const optionRestoreAll = i18n.t("restoreAll");
  const optionCodeOnly = i18n.t("codeOnly");
  const optionConversationOnly = i18n.t("restoreConversationOnly");
  const optionUndo = i18n.t("undoLastRewind");
  const optionCancel = i18n.t("cancel");

  const options: string[] = [optionConversationOnly];
  if (cp) {
    options.push(optionRestoreAll);
    options.push(optionCodeOnly);
  }
  if (state.redoStack.length > 0) {
    options.push(optionUndo);
  }
  options.push(optionCancel);

  const choice = await ctx.ui.select(i18n.t("restoreOptionsTitle"), options);

  if (!choice || choice === optionCancel) return { cancel: true };
  if (choice === optionConversationOnly) return undefined;

  if (choice === optionUndo && state.redoStack.length > 0) {
    const undoCp = state.redoStack.pop()!;
    await performRestore(state, ctx, undoCp, "files");
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("restoredFromBeforeUndo") });
    return { cancel: true };
  }

  if (!cp) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noCheckpointAvailable") });
    return undefined;
  }

  await performRestore(state, ctx, cp, "files");
  notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("filesRestoredFromCheckpoint") });

  if (choice === optionCodeOnly) {
    return { skipConversationRestore: true };
  }

  return undefined;
}

export async function handleTreeRestore(
  state: RewindState,
  event: { preparation: { targetId: string } },
  ctx: any,
): Promise<{ cancel: true } | undefined> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) return undefined;
  if (!ctx.hasUI) return undefined;

  const entry = ctx.sessionManager.getEntry(event.preparation.targetId);
  const targetTs = entry?.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

  const sorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  const cp = sorted.find((c) => c.timestamp <= targetTs) ?? state.resumeCheckpoint;

  const optionKeepCurrent = i18n.t("keepCurrentFiles");
  const optionRestoreFiles = i18n.t("restoreFilesToThatPoint");
  const optionUndo = i18n.t("undoLastRewind");
  const optionCancelNavigation = i18n.t("cancelNavigation");

  const options: string[] = [optionKeepCurrent];
  if (cp) options.push(optionRestoreFiles);
  if (state.redoStack.length > 0) options.push(optionUndo);
  options.push(optionCancelNavigation);

  const choice = await ctx.ui.select(i18n.t("restoreOptionsTitle"), options);

  if (!choice || choice === optionCancelNavigation) return { cancel: true };
  if (choice === optionKeepCurrent) return undefined;

  if (choice === optionUndo && state.redoStack.length > 0) {
    const undoCp = state.redoStack.pop()!;
    await performRestore(state, ctx, undoCp, "files");
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("restoredFromBeforeUndo") });
    return { cancel: true };
  }
  if (cp) {
    await performRestore(state, ctx, cp, "files");
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: i18n.t("filesRestoredToCheckpoint") });
  }

  return undefined;
}

// ============================================================================
// Registration
// ============================================================================

export function registerCommands(pi: ExtensionAPI, state: RewindState): void {
  pi.registerCommand("rewind", {
    description: i18n.t("commandDescription"),
    handler: async (_args, ctx) => {
      await runRewindFlow(state, ctx);
    },
  });

  // Ctrl+Shift+R opens a files-only quick rewind.
  pi.registerShortcut(Key.ctrlShift("r"), {
    description: i18n.t("shortcutDescription"),
    handler: async (ctx) => {
      // Shortcut handler gets ExtensionContext, not CommandContext.
      // We can't call navigateTree from here, so do files-only quick rewind.
      if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("notAvailableShort") });
        return;
      }

      const checkpoints = [...state.checkpoints.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 25);

      if (checkpoints.length === 0) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("noCheckpoints") });
        return;
      }

      const currentBranch = await git("rev-parse --abbrev-ref HEAD", state.repoRoot).catch(() => "unknown");
      const items = checkpoints.map((cp, i) => formatCheckpointLabel(cp, i, state, currentBranch));
      const choice = await ctx.ui.select(i18n.t("quickRewindTitle"), items);
      if (!choice) return;

      const idx = items.indexOf(choice);
      if (idx < 0) return;

      await performRestore(state, ctx, checkpoints[idx], "files");
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: "info",
        message: i18n.t("filesRewoundToCheckpoint", { index: idx + 1 }),
      });
    },
  });
}
