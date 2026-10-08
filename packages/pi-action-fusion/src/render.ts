import { Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { catalog, i18n } from "./i18n.ts";
import {
  THEN_RUN_FAILED, THEN_RUN_RUNNING, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED,
  type ActionFusionDetails, type ThenRunInput,
} from "./then-run.ts";

type NativeTool = ToolDefinition<any, any>;
type RenderContext = Parameters<NonNullable<NativeTool["renderCall"]>>[2];
type Theme = Parameters<NonNullable<NativeTool["renderCall"]>>[1];
type Result = Parameters<NonNullable<NativeTool["renderResult"]>>[0];
type Options = Parameters<NonNullable<NativeTool["renderResult"]>>[1];
type RenderArgs = { then_run?: ThenRunInput };
type BashState = Parameters<NonNullable<ReturnType<typeof createBashToolDefinition>["renderCall"]>>[2]["state"];
type CommandStatus = "running" | "succeeded" | "failed" | "timeout" | "aborted" | "skipped";
type FusionView = {
  mutation: "saved" | "failed" | "unknown";
  status: CommandStatus;
  exitCode?: string;
  mutationResult: Result;
  commandResult: Result;
};
type RenderState = {
  native?: Record<string, unknown>;
  nativeCall?: Component;
  nativeResult?: Component;
  nativeError?: boolean;
  resultSeen?: boolean;
  bash?: BashState;
  bashCall?: Component;
  bashResult?: Component;
};

const newBashState = (): BashState => ({ startedAt: undefined, endedAt: undefined, interval: undefined });
const textOf = (result: Result) => result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
const textResult = (text: string, details?: unknown): Result => ({ content: [{ type: "text", text }], details });

function endsWithMessage(text: string, key: "mutationSkipped" | "commandSkipped"): boolean {
  // Normalized errors can be reopened in another locale. Recognize both stored
  // catalog variants without guessing from an arbitrary mutation error string.
  return Object.values(catalog[key] ?? {}).some((message) => text.endsWith(message));
}

/** Interpret only public Fusion boundaries, including Pi-normalized thrown errors. */
function resultView(result: Result, command: ThenRunInput, isError: boolean): FusionView | undefined {
  if (result.content.some((part) => part.type !== "text")) return undefined;
  const allText = textOf(result);
  const markers = [...allText.matchAll(/(?:^|\n)(\[then_run:(?:running|succeeded|failed|skipped)\])(?=\r?\n| |$)/g)];
  if (markers.length !== 1) return undefined;
  const marker = markers[0][1];
  const fusion = (result.details as Partial<ActionFusionDetails> | undefined)?.actionFusion;
  if (!isError) {
    const last = result.content.at(-1);
    if (!fusion || (fusion.status !== "running" && fusion.status !== "succeeded")
      || fusion.command !== command.command || last?.type !== "text") return undefined;
    const expected = fusion.status === "running" ? THEN_RUN_RUNNING : THEN_RUN_SUCCEEDED;
    if (marker !== expected || !last.text.startsWith(expected)) return undefined;
    return {
      mutation: "saved", status: fusion.status,
      mutationResult: { ...result, content: result.content.slice(0, -1) },
      commandResult: textResult(last.text.slice(expected.length).replace(/^\r?\n/, ""), fusion.bashDetails),
    };
  }
  if (marker !== THEN_RUN_FAILED && marker !== THEN_RUN_SKIPPED) return undefined;
  const match = markers[0];
  const start = match.index! + (match[0].startsWith("\n") ? 1 : 0);
  const prefix = allText.slice(0, start).replace(/\n+$/, "");
  const output = allText.slice(start + marker.length).replace(/^(?:\r?\n| )+/, "");
  if (marker === THEN_RUN_SKIPPED) {
    const mutationFailed = endsWithMessage(output, "mutationSkipped");
    const commandSkipped = endsWithMessage(output, "commandSkipped");
    if (!mutationFailed && !commandSkipped) return undefined;
    // The Chinese mutation-failure sentence contains the shorter command-skip
    // suffix. Prefer the specific full sentence over that shared tail.
    const mutation = mutationFailed ? "failed" : "saved";
    return { mutation, status: "skipped", mutationResult: textResult(prefix), commandResult: textResult(output) };
  }
  const exitCode = output.match(/(?:^|\n)Command exited with code (\d+)\s*$/)?.[1];
  const status = /(?:^|\n)Command timed out after [^\n]+\s*$/.test(output) ? "timeout"
    : /(?:^|\n)Command aborted\s*$/.test(output) ? "aborted" : "failed";
  return { mutation: "saved", status, exitCode, mutationResult: textResult(prefix), commandResult: textResult(output) };
}

function fit(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}
function rows(view: FusionView | undefined, command: ThenRunInput, theme: Theme, started: boolean, showCommand = true): string[] {
  const retained = view && ["failed", "timeout", "aborted"].includes(view.status);
  const mutationKey = !view ? started ? "uiMutationRunning" : "uiMutationPending"
    : view.mutation === "saved" ? retained ? "uiMutationRetained" : "uiMutationSaved"
    : view.mutation === "failed" ? "uiMutationFailed" : "uiMutationUnknown";
  const mutationIcon = !view ? started ? "◌" : "○" : view.mutation === "saved" ? "✓" : view.mutation === "failed" ? "✕" : "?";
  const mutationTone = !view ? "dim" : view.mutation === "saved" ? "success" : view.mutation === "failed" ? "error" : "warning";
  const commandKey = !view ? "uiCommandPending" : view.status === "succeeded" ? "uiCommandExit"
    : view.status === "running" ? "uiCommandRunning" : view.status === "timeout" ? "uiCommandTimeout"
    : view.status === "aborted" ? "uiCommandAborted" : view.status === "skipped" ? "uiCommandSkipped"
    : view.exitCode ? "uiCommandExit" : "uiCommandFailed";
  const commandLabel = i18n.t(commandKey, commandKey === "uiCommandExit" ? { code: view?.exitCode ?? "0" } : undefined);
  const commandIcon = !view ? "○" : view.status === "running" ? "◌" : view.status === "succeeded" ? "✓" : view.status === "skipped" ? "–" : "✕";
  const commandTone = !view ? "dim" : view.status === "succeeded" ? "success" : view.status === "running" ? "accent" : view.status === "skipped" ? "warning" : "error";
  const preview = typeof command.command === "string" && command.command.trim()
    ? stripTerminalSequences(command.command).replace(/\r?\n/g, " ↵ ").replace(/\r/g, " ↵ ").replace(/\t/g, "  ")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : i18n.t("uiCommandPlaceholder");
  return [
    theme.fg(mutationTone, `${mutationIcon} ${i18n.t(mutationKey)}`),
    `${theme.fg(commandTone, `${commandIcon} ${i18n.t("followUp")} · ${commandLabel}`)}${showCommand ? `  ${theme.fg("muted", `$ ${preview}`)}` : ""}`,
  ];
}

function nativeParts(component: Component | undefined, width: number): { header: string[]; body: string[] } {
  const lines = component?.render(width) ?? [];
  const blank = (line: string) => !stripTerminalSequences(line).trim();
  let start = 0;
  while (start < lines.length && blank(lines[start])) start++;
  let end = start;
  while (end < lines.length && !blank(lines[end])) end++;
  let bodyStart = end;
  while (bodyStart < lines.length && blank(lines[bodyStart])) bodyStart++;
  return { header: lines.slice(start, end).map((line) => truncateToWidth(line, visibleWidth(stripTerminalSequences(line).trimEnd()), "")), body: lines.slice(bodyStart) };
}

class MutationSection implements Component {
  constructor(private state: RenderState, private base: Component, private confirmation: string, private theme: Theme) {}
  render(width: number): string[] {
    const body = nativeParts(this.state.nativeCall, width).body;
    const result = this.base.render(width);
    return [...body, ...result, ...(result.length === 0 && this.confirmation
      ? new Text(this.theme.fg("muted", this.confirmation), 0, 0).render(width) : [])];
  }
  invalidate(): void { this.base.invalidate(); }
}

class FusionCall implements Component {
  constructor(private base: Component, private command: ThenRunInput, private state: RenderState, private theme: Theme, private started: boolean) {}
  render(width: number): string[] {
    const columns = Math.max(1, width);
    const lines = nativeParts(this.base, columns).header.map((line) => fit(line, columns));
    const badge = this.theme.fg("dim", ` · ${i18n.t("uiFusion")}`);
    if (lines.length && visibleWidth(lines[0]) + visibleWidth(badge) <= columns) lines[0] += badge;
    else lines.push(fit(this.theme.fg("dim", i18n.t("uiFusion")), columns));
    if (!this.state.resultSeen) lines.push(...rows(undefined, this.command, this.theme, this.started).map((line) => fit(line, columns)));
    return lines;
  }
  invalidate(): void { this.base.invalidate(); }
}

class FusionResult implements Component {
  constructor(private stages: string[], private sections: Component[]) {}
  render(width: number): string[] {
    const columns = Math.max(1, width);
    return [
      ...this.stages.map((line) => fit(line, columns)),
      ...this.sections.flatMap((section) => section.render(columns).map((line) => fit(line, columns))),
    ];
  }
  invalidate(): void { for (const section of this.sections) section.invalidate(); }
}

/** Native mutations stay native; Fusion adds two independent, UI-only phases. */
export function fusionRenderers(native: (cwd: string) => NativeTool): Required<Pick<NativeTool, "renderCall" | "renderResult">> {
  return {
    renderCall(args, theme, context: RenderContext) {
      const state = context.state as RenderState;
      state.native ??= {};
      const command = (args as RenderArgs).then_run;
      const base = native(context.cwd).renderCall!(args, theme, {
        // A fused edit's committed diff comes from its result. Do not compute
        // a speculative edit against an already-mutated file after reload.
        ...context, argsComplete: command ? false : context.argsComplete,
        state: state.native, lastComponent: state.nativeCall,
      });
      state.nativeCall = base;
      return command ? new FusionCall(base, command, state, theme, context.executionStarted) : base;
    },
    renderResult(result, options: Options, theme, context: RenderContext) {
      const state = context.state as RenderState;
      state.native ??= {};
      const command = (context.args as RenderArgs).then_run;
      const view = command ? resultView(result, command, context.isError) : undefined;
      if (command) state.resultSeen = true;
      const nativeError = view ? view.mutation === "failed" || view.mutation === "unknown" : context.isError;
      const base = native(context.cwd).renderResult!(view ? view.mutationResult : result,
        view ? { ...options, isPartial: false } : options, theme, {
        ...context, isPartial: view ? false : context.isPartial, isError: nativeError, state: state.native,
        lastComponent: state.nativeError === nativeError ? state.nativeResult : undefined,
      });
      state.nativeResult = base;
      state.nativeError = nativeError;
      if (!view || !command) return base;
      const sections: Component[] = [];
      if (options.expanded) {
        sections.push(new Text(theme.fg("dim", i18n.t("uiMutation")), 0, 0),
          new MutationSection(state, base, textOf(view.mutationResult), theme));
        sections.push(new Text(theme.fg("dim", i18n.t("followUp")), 0, 0));
        state.bash ??= newBashState();
        const bash = createBashToolDefinition(context.cwd);
        state.bashCall = bash.renderCall!(command, theme, {
          ...context, args: command, state: state.bash, lastComponent: state.bashCall, executionStarted: false,
        });
        sections.push(state.bashCall);
        if (view.status === "skipped") sections.push(new Text(theme.fg("warning", textOf(view.commandResult)), 0, 0));
        else {
          state.bashResult = bash.renderResult!(view.commandResult, options, theme, {
            ...context, args: command, state: state.bash, lastComponent: state.bashResult,
            isError: ["failed", "timeout", "aborted"].includes(view.status),
          });
          sections.push(state.bashResult);
        }
        if (view.status === "succeeded") sections.push(new Text(theme.fg("dim", i18n.t("savedRoundTrip")), 0, 0));
      }
      return new FusionResult(rows(view, command, theme, context.executionStarted, !options.expanded), sections);
    },
  };
}
