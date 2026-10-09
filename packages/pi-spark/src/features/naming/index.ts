import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalRenameOutcome, TerminalRenameTarget, ResolveRenameOptions } from "pi-terminal-mux";
import { isTitleEffort, parseConfig, TITLE_EFFORT_LEVELS, type NamingConfig } from "./config.ts";
import { loadNamingConfig, namingConfigPath, saveNamingConfig } from "../../config/naming-store.ts";
import { NOTICE_SOURCE } from "../../i18n.ts";
import { i18n } from "./i18n.ts";
import { notifyWithSource } from "pi-utils";
import { getCurrentSessionUserMessages, requestSessionNameWithTimeout, type SessionNameRequester } from "./session-name.ts";

const RENAME_COMMAND = "rename";
const CONFIG_COMMAND_ALIASES = ["config:naming", "naming-config", "pi-naming-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
const CONFIG_OPTION = {
  automaticNaming: 0,
  manualNaming: 1,
  sessionTarget: 2,
  workspaceTarget: 3,
  tabTarget: 4,
  maxLength: 5,
  preferredLength: 6,
  language: 7,
  instructions: 8,
  timeout: 9,
  maxTokens: 10,
  effort: 11,
} as const;
const MAX_LENGTH_PRESETS = ["15", "30", "60"] as const;
const PREFERRED_LENGTH_PRESETS = ["10", "20", "40"] as const;
const LANGUAGE_PRESETS = ["auto", "中文", "English", "日本語"] as const;
const TIMEOUT_PRESETS = ["5000", "10000", "30000"] as const;
const MAX_TOKENS_PRESETS = ["1024", "2048", "4096"] as const;
const MESSAGE_TYPE = "pi-spark";

export interface TerminalNamingAdapter {
  resolve(options: ResolveRenameOptions): TerminalRenameOutcome[];
  rename(reference: TerminalRenameTarget, title: string): TerminalRenameOutcome;
}

/** 终端能力按需加载；session-only 使用不依赖终端运行环境。 */
async function loadTerminalAdapter(): Promise<TerminalNamingAdapter> {
  const mux = await import("pi-terminal-mux");
  return { resolve: mux.resolveTerminalRenameTargets, rename: mux.renameTerminalTarget };
}

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
  notifyWithSource({ ctx: noticeContext, source: NOTICE_SOURCE, level, message });
}

export interface NamingConfigStore {
  load(ctx: ExtensionContext): NamingConfig | false;
  save(config: NamingConfig, ctx: ExtensionContext): string | void;
  path(ctx: ExtensionContext): string;
}

/** 注册配置命令，通过 TUI 菜单和输入框修改命名配置。 */
export function registerNamingConfigCommand(
  pi: ExtensionAPI,
  store: NamingConfigStore = { load: loadNamingConfig, save: saveNamingConfig, path: namingConfigPath },
): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    getArgumentCompletions: () => [{ value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND }],
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const argument = args.trim();
      if (argument && argument !== CONFIG_RESET_COMMAND) {
        report(pi, ctx, { message: i18n.t("configCommandUsage"), level: "warning" });
        return;
      }
      if (argument === CONFIG_RESET_COMMAND) {
        try {
          const path = store.save(parseConfig({}), ctx) ?? store.path(ctx);
          report(pi, ctx, {
            message: i18n.t("configCommandSaved", { path }),
            level: "info",
          });
        } catch (error) {
          report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
        }
        return;
      }
      if (!ctx.hasUI) {
        report(pi, ctx, { message: i18n.t("configCommandInteractiveOnly"), level: "warning" });
        return;
      }

      let config: NamingConfig;
      try {
        const loaded = store.load(ctx);
        if (loaded === false) {
          report(pi, ctx, { message: i18n.t("namingDisabled"), level: "info" });
          return;
        }
        config = loaded;
      } catch (error) {
        report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
        return;
      }

      /** Saves one validated menu change and reports its result. */
      const save = (next: NamingConfig): boolean => {
        try {
          const path = store.save(next, ctx) ?? store.path(ctx);
          config = next;
          report(pi, ctx, { message: i18n.t("configCommandSaved", { path }), level: "info" });
          return true;
        } catch (error) {
          report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
          return false;
        }
      };
      /** Formats a boolean setting for the localized menu label. */
      const toggle = (value: boolean): string => value ? i18n.t("configOn") : i18n.t("configOff");
      /** Opens a choice list for common values and falls back to text only for custom values. */
      const chooseSettingValue = async (
        title: string,
        current: string,
        options: readonly string[],
      ): Promise<string | undefined> => {
        const customChoice = i18n.t("configCustom");
        const cancelChoice = i18n.t("configCancel");
        const choices = [
          ...options.map((value) => i18n.t("configPresetValue", { value })),
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
        const doneChoice = i18n.t("configDone");
        const choices = [
          i18n.t("configAutomaticNaming", { value: toggle(config.automaticNaming) }),
          i18n.t("configManualNaming", { value: toggle(config.manualNaming) }),
          i18n.t("configSessionTarget", { value: toggle(config.targets.session) }),
          i18n.t("configWorkspaceTarget", { value: toggle(config.targets.workspace) }),
          i18n.t("configTabTarget", { value: toggle(config.targets.tab) }),
          i18n.t("configMaxLength", { value: config.title.maxLength }),
          i18n.t("configPreferredLength", { value: config.title.preferredLength }),
          i18n.t("configLanguage", { value: config.title.language }),
          i18n.t("configInstructions", { value: config.title.instructions || i18n.t("configEmpty") }),
          i18n.t("configTimeout", { value: config.title.timeoutMs }),
          i18n.t("configMaxTokens", { value: config.title.maxTokens }),
          i18n.t("configEffort", { value: config.title.effort }),
          doneChoice,
        ];
        const selected = await ctx.ui.select(i18n.t("configMenuTitle"), choices);
        if (selected === undefined || selected === doneChoice) return;
        const selectedIndex = choices.indexOf(selected);
        let next: NamingConfig | undefined;
        if (selectedIndex === CONFIG_OPTION.automaticNaming) {
          next = parseConfig({ ...config, automaticNaming: !config.automaticNaming });
        } else if (selectedIndex === CONFIG_OPTION.manualNaming) {
          next = parseConfig({ ...config, manualNaming: !config.manualNaming });
        } else if (selectedIndex === CONFIG_OPTION.sessionTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, session: !config.targets.session } });
        } else if (selectedIndex === CONFIG_OPTION.workspaceTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, workspace: !config.targets.workspace } });
        } else if (selectedIndex === CONFIG_OPTION.tabTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, tab: !config.targets.tab } });
        } else {
          let inputTitle = i18n.t("configTimeoutInput");
          let inputValue = String(config.title.timeoutMs);
          let options: readonly string[] = TIMEOUT_PRESETS;
          if (selectedIndex === CONFIG_OPTION.maxLength) {
            inputTitle = i18n.t("configMaxLengthInput");
            inputValue = String(config.title.maxLength);
            options = MAX_LENGTH_PRESETS;
          } else if (selectedIndex === CONFIG_OPTION.preferredLength) {
            inputTitle = i18n.t("configPreferredLengthInput");
            inputValue = String(config.title.preferredLength);
            options = PREFERRED_LENGTH_PRESETS;
          } else if (selectedIndex === CONFIG_OPTION.language) {
            inputTitle = i18n.t("configLanguageInput");
            inputValue = config.title.language;
            options = LANGUAGE_PRESETS;
          } else if (selectedIndex === CONFIG_OPTION.instructions) {
            inputTitle = i18n.t("configInstructionsInput");
            inputValue = config.title.instructions;
            options = [];
          } else if (selectedIndex === CONFIG_OPTION.maxTokens) {
            inputTitle = i18n.t("configMaxTokensInput");
            inputValue = String(config.title.maxTokens);
            options = MAX_TOKENS_PRESETS;
          } else if (selectedIndex === CONFIG_OPTION.effort) {
            inputTitle = i18n.t("configEffortInput");
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
            // 自定义输入可能不是受支持的档位；明确报错并重开菜单，不静默丢弃也不落到其它字段。
            if (!isTitleEffort(input)) {
              report(pi, ctx, {
                message: i18n.t("configEffortInvalid", { value: input, options: TITLE_EFFORT_LEVELS.join(", ") }),
                level: "error",
              });
              continue;
            }
            title.effort = input;
          } else title.timeoutMs = Number(input.trim());
          try { next = parseConfig({ ...config, title }); }
          catch (error) {
            report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
          }
        }
        if (next) save(next);
      }
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
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
  dependencies: { requestName?: SessionNameRequester; loadTerminal?: () => Promise<TerminalNamingAdapter> } = {},
): void {
  const { requestName, loadTerminal = loadTerminalAdapter } = dependencies;
  const getConfig: NamingConfigGetter = typeof selection === "function" ? selection : () => selection;
  const sessions = new Map<string, SessionNamingState>();
  let activeSession: string | undefined;
  let terminalPromise: Promise<TerminalNamingAdapter> | undefined;
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
        report(pi, ctx, { message: i18n.t("namingConfigFailed", { error: message }), level: "warning" });
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

  /** Capture owned terminal IDs before generation; invalidate every asynchronous boundary. */
  async function rename(args: string, ctx: ExtensionContext, automatic: boolean, config: NamingConfig): Promise<void> {
    const currentGeneration = generation;
    const currentRequest = ++request;
    const currentSession = ctx.sessionManager.getSessionId();
    const configSnapshot = JSON.stringify(config);
    const isCurrent = () => {
      if (generation !== currentGeneration || request !== currentRequest || activeSession !== currentSession) return false;
      // A settings command can disable naming or revoke terminal targets while a request is pending.
      return JSON.stringify(readConfig(ctx)) === configSnapshot;
    };
    const canApply = () => isCurrent() && (!automatic || !pi.getSessionName());
    const userMessages = automatic ? [args] : getCurrentSessionUserMessages(ctx);
    let terminal: TerminalNamingAdapter | undefined;
    let targets: TerminalRenameOutcome[] = [];
    let resolutionError: unknown;
    if (config.targets.workspace || config.targets.tab) {
      try {
        terminalPromise ??= Promise.resolve().then(loadTerminal);
        terminal = await terminalPromise;
        if (!canApply()) return;
        targets = terminal.resolve({ tab: config.targets.tab, workspace: config.targets.workspace });
      } catch (error) {
        terminalPromise = undefined;
        resolutionError = error;
      }
    }
    if (!canApply()) return;
    let label = automatic ? "" : args.trim();
    if (!label) {
      try {
        label = await requestSessionNameWithTimeout({ userMessages, ctx, requestName, title: config.title });
      } catch (error) {
        if (canApply()) report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" });
        return;
      }
    }
    if (!canApply()) return;

    const renamed: string[] = [];
    if (config.targets.session) {
      try { pi.setSessionName(label); renamed.push(i18n.t("piSessionTarget")); }
      catch (error) { report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" }); }
    }
    if (resolutionError !== undefined) {
      report(pi, ctx, { message: i18n.t("terminalNamingFailed", { error: errorMessage(resolutionError) }), level: "warning" });
    }
    for (const target of targets) {
      let result = target;
      if (target.status === "ready" && terminal) {
        try { result = terminal.rename(target.reference, label); }
        catch (error) { result = { status: "failed", operation: target.reference.operation, error: errorMessage(error) }; }
      }
      if (result.status === "renamed") {
        renamed.push(i18n.t(`${result.reference.target}Target`));
      } else if (result.status === "skipped") {
        report(pi, ctx, { message: i18n.t("terminalNamingSkipped", {
          target: i18n.t(`${result.operation}Target`),
          reason: i18n.t(`skip.${result.reason}`, { setting: result.setting ?? "" }),
        }), level: "warning" });
      } else if (result.status === "failed") {
        report(pi, ctx, { message: i18n.t("terminalNamingFailed", { error: result.error }), level: "warning" });
      }
    }
    if (renamed.length > 0) {
      report(pi, ctx, { message: i18n.t("namingDone", { label, targets: [...new Set(renamed)].join(", ") }), level: "info" });
    }
  }

  pi.registerCommand(RENAME_COMMAND, {
    description: i18n.t("renameDescription"),
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const state = sessionState(ctx);
      request++; // Even a disabled manual command supersedes pending automatic work.
      state.attempted = true;
      const config = readConfig(ctx);
      if (!config || !config.manualNaming || !Object.values(config.targets).some(Boolean)) {
        report(pi, ctx, { message: i18n.t("namingDisabled"), level: "info" });
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
    if (!config || !config.automaticNaming || !Object.values(config.targets).some(Boolean)) return;
    const inputGeneration = generation;
    const naming = rename(text, ctx, true, config);
    const inputRequest = request;
    void naming.catch((error: unknown) => {
      if (generation !== inputGeneration || request !== inputRequest) return;
      report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" });
    });
  });
}

/** Spark owns the runtime, catalog and notice renderer; no configuration I/O at registration. */
export function registerNamingFeature(pi: ExtensionAPI): void {
  registerNamingConfigCommand(pi);
  registerNaming(pi, loadNamingConfig);
}
