import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalRenameOutcome, TerminalRenameTarget, ResolveRenameOptions } from "pi-terminal-mux";
import { isTitleEffort, parseConfig, TITLE_EFFORT_LEVELS, type NamingConfig } from "./config.ts";
import { loadNamingConfig, namingConfigPath, saveNamingConfig } from "../../config/naming-store.ts";

import { getCurrentSessionUserMessages, requestSessionNameWithTimeout, type SessionNameRequester } from "./session-name.ts";

const RENAME_COMMAND = "rename";

function targetLabel(target: string): string {
  return {
    workspace: "workspace",
    tab: "tab",
    window: "window",
    pane: "pane",
    session: "session",
    terminal: "terminal",
  }[target] ?? target;
}

function skipReason(reason: string, setting: string): string {
  return {
    unsupported: "unsupported by the current backend",
    disabled: `backend setting is disabled: ${setting}`,
    shared: "the target is shared with other sessions and was not granted for renaming",
    unverified: "exclusive target ownership could not be verified",
    "missing-id": "missing an explicit target ID; current focus is not a substitute",
  }[reason] ?? reason;
}
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
  noticeContext.ui.notify(message, level);
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
    description: "Configure Spark naming",
    getArgumentCompletions: () => [{ value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND }],
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const argument = args.trim();
      if (argument && argument !== CONFIG_RESET_COMMAND) {
        report(pi, ctx, { message: "Usage: /config:naming (open the settings menu) or /config:naming reset (restore defaults)", level: "warning" });
        return;
      }
      if (argument === CONFIG_RESET_COMMAND) {
        try {
          const path = store.save(parseConfig({}), ctx) ?? store.path(ctx);
          report(pi, ctx, {
            message: `Naming configuration saved to ${path}. Run /reload to apply it.`,
            level: "info",
          });
        } catch (error) {
          report(pi, ctx, { message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
        }
        return;
      }
      if (!ctx.hasUI) {
        report(pi, ctx, { message: "Naming configuration requires the TUI; run this command in an interactive Pi session.", level: "warning" });
        return;
      }

      let config: NamingConfig;
      try {
        const loaded = store.load(ctx);
        if (loaded === false) {
          report(pi, ctx, { message: "Naming is disabled for this session. Configure naming in extensions/pi-spark/config.json or use /config:naming reset, then /reload.", level: "info" });
          return;
        }
        config = loaded;
      } catch (error) {
        report(pi, ctx, { message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
        return;
      }

      /** Saves one validated menu change and reports its result. */
      const save = (next: NamingConfig): boolean => {
        try {
          const path = store.save(next, ctx) ?? store.path(ctx);
          config = next;
          report(pi, ctx, { message: `Naming configuration saved to ${path}. Run /reload to apply it.`, level: "info" });
          return true;
        } catch (error) {
          report(pi, ctx, { message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
          return false;
        }
      };
      /** Formats a boolean setting for the localized menu label. */
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
          `Name session: ${toggle(config.targets.session)}`,
          `Name workspace: ${toggle(config.targets.workspace)}`,
          `Name tab: ${toggle(config.targets.tab)}`,
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
        } else if (selectedIndex === CONFIG_OPTION.sessionTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, session: !config.targets.session } });
        } else if (selectedIndex === CONFIG_OPTION.workspaceTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, workspace: !config.targets.workspace } });
        } else if (selectedIndex === CONFIG_OPTION.tabTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, tab: !config.targets.tab } });
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
            // 自定义输入可能不是受支持的档位；明确报错并重开菜单，不静默丢弃也不落到其它字段。
            if (!isTitleEffort(input)) {
              report(pi, ctx, {
                message: `Invalid thinking effort: ${input}; allowed: ${TITLE_EFFORT_LEVELS.join(", ")}`,
                level: "error",
              });
              continue;
            }
            title.effort = input;
          } else title.timeoutMs = Number(input.trim());
          try { next = parseConfig({ ...config, title }); }
          catch (error) {
            report(pi, ctx, { message: `Invalid naming configuration: ${errorMessage(error)}`, level: "error" });
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
        if (canApply()) report(pi, ctx, { message: `Naming failed: ${errorMessage(error)}`, level: "error" });
        return;
      }
    }
    if (!canApply()) return;

    const renamed: string[] = [];
    if (config.targets.session) {
      try { pi.setSessionName(label); renamed.push("Pi session"); }
      catch (error) { report(pi, ctx, { message: `Naming failed: ${errorMessage(error)}`, level: "error" }); }
    }
    if (resolutionError !== undefined) {
      report(pi, ctx, { message: `Terminal naming failed: ${errorMessage(resolutionError)}`, level: "warning" });
    }
    for (const target of targets) {
      let result = target;
      if (target.status === "ready" && terminal) {
        try { result = terminal.rename(target.reference, label); }
        catch (error) { result = { status: "failed", operation: target.reference.operation, error: errorMessage(error) }; }
      }
      if (result.status === "renamed") {
        renamed.push(targetLabel(result.reference.target));
      } else if (result.status === "skipped") {
        report(pi, ctx, { message: `Did not rename ${targetLabel(result.operation)}: ${skipReason(result.reason, result.setting ?? "")}`, level: "warning" });
      } else if (result.status === "failed") {
        report(pi, ctx, { message: `Terminal naming failed: ${result.error}`, level: "warning" });
      }
    }
    if (renamed.length > 0) {
      report(pi, ctx, { message: `Named ${[...new Set(renamed)].join(", ")}: ${label}`, level: "info" });
    }
  }

  pi.registerCommand(RENAME_COMMAND, {
    description: "Name the session and allowed terminal targets; omit the name to summarize all user messages on the current branch",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const state = sessionState(ctx);
      request++; // Even a disabled manual command supersedes pending automatic work.
      state.attempted = true;
      const config = readConfig(ctx);
      if (!config || !config.manualNaming || !Object.values(config.targets).some(Boolean)) {
        report(pi, ctx, { message: "Naming is disabled for this session. Configure naming in extensions/pi-spark/config.json or use /config:naming reset, then /reload.", level: "info" });
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
      report(pi, ctx, { message: `Naming failed: ${errorMessage(error)}`, level: "error" });
    });
  });
}

/** Spark owns the runtime and catalog; no configuration I/O at registration. */
export function registerNamingFeature(pi: ExtensionAPI): void {
  registerNamingConfigCommand(pi);
  registerNaming(pi, loadNamingConfig);
}
