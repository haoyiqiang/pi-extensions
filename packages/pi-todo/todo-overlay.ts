import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getDefaultTodoStore, type TodoStore } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

export const WIDGET_KEY = "rpiv-todos";

export class TodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private readonly completedTaskIdsPendingHide = new Set<number>();
  private readonly hiddenCompletedTaskIds = new Set<number>();
  private lastNextId: number | undefined;
  private collapsed = false;

  constructor(private readonly store: TodoStore = getDefaultTodoStore()) {}

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = this.selectOverlayTasks(snapshot);
    if (visible.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, factoryTheme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
            invalidate: () => undefined,
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  resetCompletedDisplayState(): void {
    this.completedTaskIdsPendingHide.clear();
    this.hiddenCompletedTaskIds.clear();
    this.lastNextId = undefined;
  }

  hideCompletedTasksFromPreviousTurn(): void {
    if (this.completedTaskIdsPendingHide.size === 0) return;
    for (const taskId of this.completedTaskIdsPendingHide) this.hiddenCompletedTaskIds.add(taskId);
    this.completedTaskIdsPendingHide.clear();
    this.tui?.requestRender();
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.tui?.requestRender(true);
  }

  isRegistered(): boolean {
    return this.widgetRegistered;
  }

  private getSnapshot() {
    const state = this.store.getRenderState();
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) this.resetCompletedDisplayState();
    this.lastNextId = state.nextId;
    const completedTaskIds = new Set(
      state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    );
    for (const taskId of this.completedTaskIdsPendingHide) {
      if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
    }
    for (const taskId of this.hiddenCompletedTaskIds) {
      if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
    }
    return { tasks: [...state.tasks], nextId: state.nextId };
  }

  private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
    return snapshot.tasks.filter(
      (task) => task.status !== "deleted" && !(task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id)),
    );
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const snapshot = this.getSnapshot();
    const overlayTasks = this.selectOverlayTasks(snapshot);
    if (overlayTasks.length === 0) return [];

    const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
    const truncate = (line: string): string => truncateToWidth(line, width, "…");
    const counts = selectTodoCounts(overlayState);
    const hasActive = selectHasActive(overlayState);
    const showIds = selectShowTaskIds(overlayState);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const heading = truncate(
      `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `${t("overlay.heading")} (${counts.completed}/${counts.total})`)}`,
    );

    if (this.collapsed) {
      const key = resolveCollapseKey();
      const hint = key === COLLAPSE_KEY_OFF ? t("overlay.collapsed") : t("overlay.expandHint", { key });
      return this.withTrailingSpacer([heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)]);
    }

    const lines: string[] = [heading];
    const bodyBudget = this.uiCtx?.getToolsExpanded?.() === true ? overlayTasks.length : getMaxWidgetLines() - 1;
    const layout = selectOverlayLayout(overlayState, bodyBudget);
    for (const task of layout.visible) {
      lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
    }

    for (const task of overlayTasks) {
      if (
        task.status === "completed" &&
        !this.completedTaskIdsPendingHide.has(task.id) &&
        !this.hiddenCompletedTaskIds.has(task.id)
      ) {
        this.completedTaskIdsPendingHide.add(task.id);
      }
    }

    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      const last = lines.length - 1;
      lines[last] = lines[last].replace("├─", "└─");
      return this.withTrailingSpacer(lines);
    }

    const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
    const overflowParts: string[] = [];
    if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
    if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
    const summary = overflowParts.length > 0
      ? `+${totalHidden} ${t("overlay.more")} (${overflowParts.join(", ")})`
      : `+${totalHidden} ${t("overlay.more")}`;
    lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
    return this.withTrailingSpacer(lines);
  }

  private withTrailingSpacer(lines: string[]): string[] {
    if (lines.length > 0) lines.push("");
    return lines;
  }

  dispose(): void {
    if (this.uiCtx && this.widgetRegistered) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.collapsed = false;
    this.resetCompletedDisplayState();
  }
}
