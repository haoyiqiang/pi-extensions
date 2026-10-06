import {
  ExtensionEditorComponent,
  type ExtensionContext,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { i18n } from "../i18n.js";

// Workflow hosts share one foreground terminal, including runs draining across /new.
// This is only a modal queue, not another agent registry or workflow UI owner.
let dialogs: Promise<void> = Promise.resolve();

function cancelled(): DOMException {
  return new DOMException(i18n.t("workflowExecution.cancelled"), "AbortError");
}

function enqueue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const task = dialogs.then(() => {
    if (signal.aborted) throw cancelled();
    return operation();
  });
  dialogs = task.then(() => {}, () => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const ROOT_SURFACES = new Set([
  "setStatus", "setWidget", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator",
  "setHiddenThinkingLabel", "setFooter", "setHeader", "setTitle", "pasteToEditor",
  "setEditorText", "setEditorComponent", "addAutocompleteProvider", "setToolsExpanded",
]);

/** Child dialogs are serialized and scope-cancelled; ambient root surfaces stay with the launcher. */
export function createStandardWorkflowUi(
  real: ExtensionUIContext,
  signal: AbortSignal,
  mode: ExtensionContext["mode"],
): ExtensionUIContext {
  const dialogSignal = (opts?: ExtensionUIDialogOptions) => opts?.signal
    ? AbortSignal.any([signal, opts.signal])
    : signal;

  const custom: ExtensionUIContext["custom"] = (factory, options) => enqueue(signal, async () => {
    let detach = () => {};
    try {
      return await real.custom(async (tui, theme, keybindings, done) => {
        const abort = () => done(undefined as never);
        signal.addEventListener("abort", abort, { once: true });
        detach = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          abort();
          return { render: () => [], invalidate: () => {} };
        }
        const component = await factory(tui, theme, keybindings, done);
        // Pi discards a factory that resolves after done(); its component still needs disposal.
        if (signal.aborted) component.dispose?.();
        return component;
      }, options);
    } finally {
      detach();
    }
  });

  const overrides: Partial<ExtensionUIContext> = {
    select(title, choices, opts) {
      const current = dialogSignal(opts);
      return enqueue(current, () => real.select(title, choices, { ...opts, signal: current }));
    },
    confirm(title, message, opts) {
      const current = dialogSignal(opts);
      return enqueue(current, () => real.confirm(title, message, { ...opts, signal: current }));
    },
    input(title, placeholder, opts) {
      const current = dialogSignal(opts);
      return enqueue(current, () => real.input(title, placeholder, { ...opts, signal: current }));
    },
    custom,
    editor: (title, prefill) => mode === "tui"
      ? custom<string | undefined>((tui, _theme, keys, done) =>
        new ExtensionEditorComponent(tui, keys, title, prefill, done, () => done(undefined)))
      : enqueue(signal, () => real.editor(title, prefill)),
    notify(message, level) { if (!signal.aborted) real.notify(message, level); },
    onTerminalInput: () => () => {},
    setTheme: () => ({ success: false, error: i18n.t("workflowExecution.childUiReadOnly") }),
  };
  const noop = () => {};
  return new Proxy(real, {
    get(target, property) {
      if (typeof property === "string" && ROOT_SURFACES.has(property)) return noop;
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
