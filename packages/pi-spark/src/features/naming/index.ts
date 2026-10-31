import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTitleEffort, parseConfig, TITLE_EFFORT_LEVELS, type NamingConfig } from "./config.ts";
import { loadNamingConfig } from "../../config/naming-store.ts";

import { getCurrentSessionUserMessages, requestSessionNameWithTimeout, type SessionNameRequester } from "./session-name.ts";

const RENAME_COMMAND = "rename";

const CONFIG_OPTION = {
  automaticNaming: 0,
  manualNaming: 1,
  maxLength: 2,
  preferredLength: 3,
  language: 4,
  instructions: 5,
  timeout: 6,
  maxTokens: 7,
  effort: 8,
} as const;
const MAX_LENGTH_PRESETS = ["15", "30", "60"] as const;
const PREFERRED_LENGTH_PRESETS = ["10", "20", "40"] as const;
const LANGUAGE_PRESETS = ["auto", "中文", "English", "日本語"] as const;
const TIMEOUT_PRESETS = ["5000", "10000", "30000"] as const;
const MAX_TOKENS_PRESETS = ["1024", "2048", "4096"] as const;
const MESSAGE_TYPE = "pi-spark";

/** 格式化捕获的异常，不丢失原始错误。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 无交互 UI 时仍通过 Pi 消息报告结果，不静默吞错。 */
function report(pi: ExtensionAPI, ctx: ExtensionContext, notice: { message: string; level: "info" | "warning" | "error" }): void {
  const { message, level } = notice;
  const noticeContext = ctx.hasUI ? ctx : {
    ...ctx,
    ui: {
      ...ctx.ui,
      notify: (content: string) => pi.sendMessage(
        { customType: MESSAGE_TYPE, content, display: true }, { triggerTurn: false },
      ),
    },
  };
  noticeContext.ui.notify(message, level);
}

export interface NamingConfigStore {
  load(ctx: ExtensionContext): NamingConfig | false;
  save(config: NamingConfig, ctx: ExtensionContext): string | void;
  path(ctx: ExtensionContext): string;
}

/** Detailed naming settings, opened only from Spark's unified configuration panel. */
export async function openNamingConfigPanel(
  ctx: ExtensionCommandContext,
  store: NamingConfigStore,
): Promise<void> {
  const notify = (notice: { message: string; level: "info" | "warning" | "error" }) => ctx.ui.notify(notice.message, notice.level);
  if (!ctx.hasUI) {
    notify({ message: "Naming configuration requires an interactive Pi session.", level: "warning" });
    return;
  }

  let config: NamingConfig;
  try {
    const loaded = store.load(ctx);
    if (loaded === false) {
      notify({ message: "Enable naming in /config:spark first.", level: "info" });
      return;
    }
    config = loaded;
  } catch (error) {
    notify({ message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
    return;
  }

  /** Saves one validated menu change and reports its result. */
  const save = (next: NamingConfig): boolean => {
    try {
      const path = store.save(next, ctx) ?? store.path(ctx);
      config = next;
      notify({ message: `Naming configuration saved to ${path}. Run /reload to apply it.`, level: "info" });
      return true;
    } catch (error) {
      notify({ message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
      return false;
    }
  };
  const toggle = (value: boolean): string => value ? "on" : "off";
  /** Opens a choice list for common values and falls back to text only for custom values. */
  const chooseSettingValue = async (
    title: string,
    current: string,
    options: readonly string[],
  ): Promise<string | undefined> => {
    const customChoice = "Custom…";
    const cancelChoice = "Cancel";
    const choices = [
      ...options.map((value) => `Common value: ${value}`),
      customChoice,
      cancelChoice,
    ];
    const selected = await ctx.ui.select(title, choices);
    if (selected === undefined || selected === cancelChoice) return undefined;
    if (selected === customChoice) return ctx.ui.input(title, current);
    const index = choices.indexOf(selected);
    return index >= 0 && index < options.length ? options[index] : undefined;
  };

  while (true) {
    const doneChoice = "Done";
    const choices = [
      `Automatic naming: ${toggle(config.automaticNaming)}`,
      `Manual /rename: ${toggle(config.manualNaming)}`,
      `Maximum title length: ${config.title.maxLength}`,
      `Preferred title length: ${config.title.preferredLength}`,
      `Title language: ${config.title.language}`,
      `Title instructions: ${config.title.instructions || "not set"}`,
      `Request timeout: ${config.title.timeoutMs} ms`,
      `Output budget: ${config.title.maxTokens} tokens`,
      `Thinking effort: ${config.title.effort}`,
      doneChoice,
    ];
    const selected = await ctx.ui.select("Naming settings", choices);
    if (selected === undefined || selected === doneChoice) return;
    const selectedIndex = choices.indexOf(selected);
    let next: NamingConfig | undefined;
    if (selectedIndex === CONFIG_OPTION.automaticNaming) {
      next = parseConfig({ ...config, automaticNaming: !config.automaticNaming });
    } else if (selectedIndex === CONFIG_OPTION.manualNaming) {
      next = parseConfig({ ...config, manualNaming: !config.manualNaming });
    } else {
      let inputTitle = "Request timeout (positive milliseconds)";
      let inputValue = String(config.title.timeoutMs);
      let options: readonly string[] = TIMEOUT_PRESETS;
      if (selectedIndex === CONFIG_OPTION.maxLength) {
        inputTitle = "Maximum title length (positive integer)";
        inputValue = String(config.title.maxLength);
        options = MAX_LENGTH_PRESETS;
      } else if (selectedIndex === CONFIG_OPTION.preferredLength) {
        inputTitle = "Preferred title length (positive integer)";
        inputValue = String(config.title.preferredLength);
        options = PREFERRED_LENGTH_PRESETS;
      } else if (selectedIndex === CONFIG_OPTION.language) {
        inputTitle = "Title language";
        inputValue = config.title.language;
        options = LANGUAGE_PRESETS;
      } else if (selectedIndex === CONFIG_OPTION.instructions) {
        inputTitle = "Title instructions (can be empty)";
        inputValue = config.title.instructions;
        options = [];
      } else if (selectedIndex === CONFIG_OPTION.maxTokens) {
        inputTitle = "Output budget (positive integer, shared by thinking and title)";
        inputValue = String(config.title.maxTokens);
        options = MAX_TOKENS_PRESETS;
      } else if (selectedIndex === CONFIG_OPTION.effort) {
        inputTitle = "Thinking effort";
        inputValue = config.title.effort;
        options = TITLE_EFFORT_LEVELS;
      }
      const input = selectedIndex === CONFIG_OPTION.instructions
        ? await ctx.ui.input(inputTitle, inputValue)
        : await chooseSettingValue(inputTitle, inputValue, options);
      if (input === undefined) continue;
      const title = { ...config.title };
      if (selectedIndex === CONFIG_OPTION.maxLength) title.maxLength = Number(input.trim());
      else if (selectedIndex === CONFIG_OPTION.preferredLength) title.preferredLength = Number(input.trim());
      else if (selectedIndex === CONFIG_OPTION.language) title.language = input;
      else if (selectedIndex === CONFIG_OPTION.instructions) title.instructions = input;
      else if (selectedIndex === CONFIG_OPTION.maxTokens) title.maxTokens = Number(input.trim());
      else if (selectedIndex === CONFIG_OPTION.effort) {
        if (!isTitleEffort(input)) {
          notify({
            message: `Invalid thinking effort: ${input}; allowed: ${TITLE_EFFORT_LEVELS.join(", ")}`,
            level: "error",
          });
          continue;
        }
        title.effort = input;
      } else title.timeoutMs = Number(input.trim());
      try { next = parseConfig({ ...config, title }); }
      catch (error) {
        notify({ message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
      }
    }
    if (next) save(next);
  }
}

export type NamingConfigSelection = NamingConfig | false;
export type NamingConfigGetter = (ctx: ExtensionContext) => NamingConfigSelection;

interface SessionNamingState {
  eligible: boolean;
  attempted: boolean;
}

/** Register once; configuration and eligibility belong to the active session, not the factory. */
export function registerNaming(
  pi: ExtensionAPI,
  selection: NamingConfigSelection | NamingConfigGetter,
  dependencies: { requestName?: SessionNameRequester } = {},
): void {
  const { requestName } = dependencies;
  const getConfig: NamingConfigGetter = typeof selection === "function" ? selection : () => selection;
  const sessions = new Map<string, SessionNamingState>();
  let activeSession: string | undefined;
  let generation = 0;
  let request = 0;
  let lastConfigError: string | undefined;

  function readConfig(ctx: ExtensionContext): NamingConfigSelection {
    try {
      const config = getConfig(ctx);
      lastConfigError = undefined;
      return config;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== lastConfigError) {
        lastConfigError = message;
        report(pi, ctx, { message: `Naming is disabled because configuration failed. Fix the naming section in extensions/pi-spark/config.json or the legacy naming file and /reload: ${message}`, level: "warning" });
      }
      return false;
    }
  }

  function sessionState(ctx: ExtensionContext): SessionNamingState {
    const id = ctx.sessionManager.getSessionId();
    if (activeSession !== id) {
      generation++;
      activeSession = id;
      lastConfigError = undefined;
    }
    let state = sessions.get(id);
    if (!state) {
      state = { eligible: !pi.getSessionName() && getCurrentSessionUserMessages(ctx).length === 0, attempted: false };
      sessions.set(id, state);
    }
    return state;
  }

  function startSession(_event: unknown, ctx: ExtensionContext): void {
    generation++;
    const state = sessionState(ctx);
    state.eligible &&= !pi.getSessionName() && getCurrentSessionUserMessages(ctx).length === 0;
    readConfig(ctx);
  }
  pi.on("session_start", startSession);
  // Invalidate before asynchronous navigation; session_start initializes the destination.
  pi.on("session_before_switch", () => { generation++; });
  pi.on("session_before_fork", () => { generation++; });
  pi.on("session_before_tree", () => { generation++; });
  pi.on("session_shutdown", () => { generation++; activeSession = undefined; });
  pi.on("session_tree", (_event, ctx) => { generation++; sessionState(ctx).eligible = false; });

  /** Invalidate every asynchronous boundary before applying a generated title. */
  async function rename(args: string, ctx: ExtensionContext, automatic: boolean, config: NamingConfig): Promise<void> {
    const currentGeneration = generation;
    const currentRequest = ++request;
    const currentSession = ctx.sessionManager.getSessionId();
    const configSnapshot = JSON.stringify(config);
    const isCurrent = () => {
      if (generation !== currentGeneration || request !== currentRequest || activeSession !== currentSession) return false;
      // A settings command can disable naming while a request is pending.
      return JSON.stringify(readConfig(ctx)) === configSnapshot;
    };
    const canApply = () => isCurrent() && (!automatic || !pi.getSessionName());
    const userMessages = automatic ? [args] : getCurrentSessionUserMessages(ctx);
    let label = automatic ? "" : args.trim();
    if (!label) {
      try {
        label = await requestSessionNameWithTimeout({ userMessages, ctx, requestName, title: config.title });
      } catch (error) {
        if (canApply()) report(pi, ctx, { message: `Naming failed: ${errorMessage(error)}`, level: "error" });
        return;
      }
    }
    if (!canApply()) return;
    try {
      pi.setSessionName(label);
      report(pi, ctx, { message: `Named Pi session: ${label}`, level: "info" });
    } catch (error) {
      report(pi, ctx, { message: `Naming failed: ${errorMessage(error)}`, level: "error" });
    }
  }

  pi.registerCommand(RENAME_COMMAND, {
    description: "Name the Pi session; omit the name to summarize all user messages on the current branch",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const state = sessionState(ctx);
      request++; // Even a disabled manual command supersedes pending automatic work.
      state.attempted = true;
      const config = readConfig(ctx);
      if (!config || !config.manualNaming) {
        report(pi, ctx, { message: "Naming is disabled for this session. Enable it in /config:spark, then /reload.", level: "info" });
        return;
      }
      await rename(args, ctx, false, config);
    },
  });
  pi.on("input", (event, ctx) => {
    const state = sessionState(ctx);
    if (!state.eligible || state.attempted || event.source === "extension" || pi.getSessionName()) return;
    const text = event.text.trim();
    if (!text) return;
    state.attempted = true;
    const config = readConfig(ctx);
    if (!config || !config.automaticNaming) return;
    const inputGeneration = generation;
    const naming = rename(text, ctx, true, config);
    const inputRequest = request;
    void naming.catch((error: unknown) => {
      if (generation !== inputGeneration || request !== inputRequest) return;
      report(pi, ctx, { message: `Naming failed: ${errorMessage(error)}`, level: "error" });
    });
  });
}

/** Spark owns the runtime and catalog; no configuration I/O at registration. */
export function registerNamingFeature(pi: ExtensionAPI): void {
  registerNaming(pi, loadNamingConfig);
}
