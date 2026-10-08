import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { getLocale, LOCALE_CHANGED_EVENT, notifyWithSource } from "pi-extensions-i18n";
import { COLLAPSE_KEY_OFF, loadConfigResult, resolveCollapseKey } from "./config.js";
import { NOTICE_SOURCE, t } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { sid, TodoStore } from "./state/store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import type { TodoOverlay } from "./todo-overlay.js";

export const PREWARM_DELAY_MS = 2000;
const STALE_OVERLAY_CODE = "PI_TODO_STALE_OVERLAY";

type TodoOverlayModule = typeof import("./todo-overlay.js");
type TodoOverlayImporter = () => Promise<TodoOverlayModule>;

export function isStaleOverlayModuleError(error: unknown): boolean {
  return String(error).includes(STALE_OVERLAY_CODE);
}

export function makeTodoOverlayLoader(
  importOverlay: TodoOverlayImporter = () => import("./todo-overlay.js"),
): TodoOverlayImporter {
  let memo: Promise<TodoOverlayModule> | undefined;
  return async () => {
    memo ??= importOverlay();
    const current = memo;
    let module: TodoOverlayModule;
    try {
      module = await current;
    } catch (error) {
      if (memo === current) memo = undefined;
      throw error;
    }
    if (typeof module.TodoOverlay !== "function") {
      throw new Error(`${STALE_OVERLAY_CODE}: ${t("overlay.staleModule")} (${JSON.stringify(Object.keys(module))})`);
    }
    return module;
  };
}

function isStaleCtxError(error: unknown): boolean {
  return /stale after session replacement/.test(String(error));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function registerTodo(
  pi: ExtensionAPI,
  importOverlay: TodoOverlayImporter = () => import("./todo-overlay.js"),
  store: TodoStore = new TodoStore(),
): void {
  const configResult = loadConfigResult();
  const loadTodoOverlay = makeTodoOverlayLoader(importOverlay);
  let todoOverlay: TodoOverlay | undefined;
  let uiCtx: ExtensionUIContext | undefined;
  let renderCtx: ExtensionContext | undefined;
  let lifecycleGeneration = 0;
  let prewarmTimer: ReturnType<typeof setTimeout> | undefined;
  const diagnosedSessions = new Set<string>();

  let metadataLocale: string | undefined;
  const refreshMetadata = (): void => {
    const locale = getLocale();
    if (metadataLocale === locale) return;
    registerTodoTool(pi, store, configResult.config);
    registerTodosCommand(pi, store);
    metadataLocale = locale;
  };
  refreshMetadata();
  const releaseLocale = pi.events.on(LOCALE_CHANGED_EVENT, refreshMetadata);
  pi.on("input", refreshMetadata);
  pi.on("before_agent_start", refreshMetadata);

  const collapseKey = resolveCollapseKey(configResult.config);
  if (collapseKey !== COLLAPSE_KEY_OFF) {
    pi.registerShortcut(collapseKey as KeyId, {
      description: t("shortcut.description"),
      handler: (ctx) => {
        if (ctx.mode !== "tui" || !ctx.hasUI || !todoOverlay?.isRegistered()) return;
        todoOverlay.toggleCollapse();
      },
    });
  }

  const clearPrewarm = (): void => {
    if (prewarmTimer !== undefined) clearTimeout(prewarmTimer);
    prewarmTimer = undefined;
  };

  const schedulePrewarm = (generation: number): void => {
    clearPrewarm();
    prewarmTimer = setTimeout(() => {
      prewarmTimer = undefined;
      if (generation !== lifecycleGeneration || !uiCtx) return;
      void loadTodoOverlay().catch(() => undefined);
    }, PREWARM_DELAY_MS);
    prewarmTimer.unref?.();
  };

  const updateTodoOverlay = async (
    resetCompletedDisplayState = false,
    generation = lifecycleGeneration,
  ): Promise<void> => {
    const hasVisibleTasks = store.getRenderState().tasks.some((task) => task.status !== "deleted");
    if (!uiCtx || (!todoOverlay && !hasVisibleTasks)) return;
    const { TodoOverlay } = await loadTodoOverlay();
    if (generation !== lifecycleGeneration || !uiCtx) return;
    todoOverlay ??= new TodoOverlay(store);
    todoOverlay.setUICtx(uiCtx);
    if (resetCompletedDisplayState) todoOverlay.resetCompletedDisplayState();
    todoOverlay.update();
  };

  const teardownRenderOwner = (): void => {
    lifecycleGeneration++;
    clearPrewarm();
    uiCtx = undefined;
    renderCtx = undefined;
    try {
      todoOverlay?.dispose();
    } finally {
      todoOverlay = undefined;
      store.clearActiveRenderSession();
    }
  };

  const replayAndRefresh = async (
    ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
  ): Promise<void> => {
    let isForeground = false;
    try {
      const sessionId = sid(ctx);
      store.replaceState(sessionId, replayFromBranch(ctx));
      isForeground = sessionId === store.getActiveRenderSession();
    } catch (error) {
      if (!isStaleCtxError(error)) throw error;
    }
    if (isForeground) await updateTodoOverlay(true);
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshMetadata();
    let sessionId: string;
    try {
      sessionId = sid(ctx);
      store.replaceState(sessionId, replayFromBranch(ctx));
    } catch (error) {
      if (!isStaleCtxError(error)) throw error;
      return;
    }

    if (configResult.diagnostic && !diagnosedSessions.has(sessionId)) {
      diagnosedSessions.add(sessionId);
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: "warning",
        message: t("config.invalid", {
          path: configResult.diagnostic.path,
          error: configResult.diagnostic.error.message,
        }),
      });
    }

    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const activeRenderSession = store.getActiveRenderSession();
    if (activeRenderSession && activeRenderSession !== sessionId) {
      teardownRenderOwner();
    }
    if (!store.claimActiveRenderSession(sessionId)) return;
    renderCtx = ctx;
    uiCtx = ctx.ui;
    const generation = ++lifecycleGeneration;
    await updateTodoOverlay(true, generation);
    schedulePrewarm(generation);
  });

  pi.on("session_compact", async (_event, ctx) => replayAndRefresh(ctx));
  pi.on("session_tree", async (_event, ctx) => replayAndRefresh(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    let sessionId: string | undefined;
    try {
      sessionId = sid(ctx);
    } catch (error) {
      if (!isStaleCtxError(error)) throw error;
    }
    if (sessionId !== undefined) {
      store.evictSession(sessionId);
      diagnosedSessions.delete(sessionId);
    }

    const ownsRender = ctx === renderCtx || (sessionId !== undefined && sessionId === store.getActiveRenderSession());
    if (ownsRender) teardownRenderOwner();
    if (ownsRender || store.getActiveRenderSession() === undefined) releaseLocale();
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return;
    try {
      await updateTodoOverlay();
    } catch (error) {
      if (isStaleOverlayModuleError(error)) throw error;
      if (renderCtx) {
        notifyWithSource({
          ctx: renderCtx,
          source: NOTICE_SOURCE,
          level: "warning",
          message: t("overlay.refreshFailed", { error: formatError(error) }),
        });
      }
    }
  });

  pi.on("agent_start", async () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
}
