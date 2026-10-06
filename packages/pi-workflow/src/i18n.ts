import {
  NOTICE_TAG_COLOR,
  getLocale,
  notifyWithSource,
  scope,
  type MessageParams,
  type NoticeColor,
  type NoticeLevel,
  type NoticeSource,
} from "pi-extensions-i18n";
import { registerLocalesFromDir } from "pi-extensions-i18n/loader";

const NAMESPACE = "pi-workflow";
const loaded = registerLocalesFromDir(NAMESPACE, new URL("../locales/", import.meta.url));
if (loaded.diagnostics.length > 0) {
  throw new Error(
    `Failed to load pi-workflow locales: ${loaded.diagnostics.map((item) => `${item.locale}: ${item.error}`).join("; ")}`,
  );
}

const translate = scope(NAMESPACE);

export const i18n = {
  locale: getLocale,
  t(key: string, params?: MessageParams): string {
    return translate(key, key, params);
  },
};

const NOTICE_TAG = "workflow";
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
export const WORKFLOW_NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

export interface WorkflowNoticeContext {
  mode?: string;
  ui: {
    notify(message: string, level?: NoticeLevel): void;
    theme?: { fg(color: NoticeColor, text: string): string };
  };
}

const noticeViews = new WeakMap<WorkflowNoticeContext, WorkflowNoticeContext>();
const noticeOrigins = new WeakMap<WorkflowNoticeContext, WorkflowNoticeContext>();

/** Decorate only the abstract UI port; retain the current SDK context through its prototype. */
export function workflowNoticeObserver<T extends WorkflowNoticeContext>(ctx: T): T {
  // Programmatic engine hosts own their own notice ports and need no Pi decoration.
  if (ctx.mode === undefined || noticeOrigins.has(ctx)) return ctx;
  const previous = noticeViews.get(ctx);
  if (previous) return previous as T;
  // The detached run may outlive the launcher's guarded SDK context. Capture
  // only the notice port; model/session fields still come from the live context.
  const noticeContext: WorkflowNoticeContext = { mode: ctx.mode, ui: ctx.ui };
  const ui = Object.create(noticeContext.ui, { notify: { value: (message: string, level: NoticeLevel = "info") => {
    notifyWorkflow(noticeContext, message, level);
  } } });
  const view = Object.create(ctx, { ui: { value: ui } }) as T;
  noticeViews.set(ctx, view);
  noticeOrigins.set(view, noticeContext);
  return view;
}

/**
 * Pi notices use the shared catalog-backed notice outlet. Programmatic hosts
 * predate Pi's `mode` field; keep their caller-owned UI port byte-compatible
 * while still routing the send through `notifyWithSource`.
 */
export function notifyWorkflow(ctx: WorkflowNoticeContext, message: string, level: NoticeLevel): void {
  ctx = noticeOrigins.get(ctx) ?? ctx;
  if (ctx.mode !== undefined) {
    notifyWithSource({ ctx, source: WORKFLOW_NOTICE_SOURCE, level, message });
    return;
  }

  const prefix = `[${NOTICE_TAG}] `;
  notifyWithSource({
    ctx: {
      mode: undefined,
      ui: {
        notify(formatted, noticeLevel) {
          ctx.ui.notify(formatted.startsWith(prefix) ? formatted.slice(prefix.length) : formatted, noticeLevel);
        },
      },
    },
    source: WORKFLOW_NOTICE_SOURCE,
    level,
    message,
  });
}
