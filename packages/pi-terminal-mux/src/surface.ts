/**
 * surface.ts — 统一 surface API（跨后端一致语义）
 *
 * tmux / Orca 使用原生创建命令，无终端时支持 headless 后台进程。
 * 其他 surface 操作通过 BackendOps 派发。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getMuxBackend, muxLog, muxSetupHint } from "./detection.ts";
import { isHeadlessSurface, createHeadlessSurface, closeHeadlessSurface, sendHeadlessEscape, readHeadlessScreen, readHeadlessScreenAsync, spawnHeadlessProcess, getHeadlessProcessExit, drainHeadlessProcess } from "./headless.ts";
import { shellEscape, powershellEscape } from "./shell.ts";
import type { MuxBackend } from "./detection.ts";
import type { BackendOps, CreateSurfaceOptions } from "./backends/types.ts";
import { ops as tmuxOps } from "./backends/tmux.ts";
import { ops as orcaOps, AGENT_ORCA_TERMINAL_HANDLE, renameOrcaTerminal } from "./backends/orca.ts";

export type { CreateSurfaceOptions } from "./backends/types.ts";
export type CreateSurfaceSplitOptions = CreateSurfaceOptions;
const TMUX_WINDOW_RENAME_SETTING = "PI_SUBAGENT_RENAME_TMUX_WINDOW";
const TMUX_SESSION_RENAME_SETTING = "PI_SUBAGENT_RENAME_TMUX_SESSION";
const ENABLED_SETTING_VALUE = "1";

const backendOps: Record<MuxBackend, BackendOps> = {
  tmux: tmuxOps,
  orca: orcaOps,
};

// ── 内部辅助 ──

/** 获取当前后端，无后端时抛错 */
function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`${"No supported terminal multiplexer found."} ${muxSetupHint()}`);
  }
  return backend;
}

// ── lastSplitSource 状态 ──

/**
 * 最近一次 createSurface / createSurfaceSplit 的来源 pane。
 * 用于在 pi TUI 中展示「新分屏来自哪个 pane」。
 * 每次调用 createSurface 时更新，调用方读取后可重置。
 */
let lastSplitSource: string | null = null;

export function getLastSplitSource(): string | null {
  return lastSplitSource;
}

export function clearLastSplitSource(): void {
  lastSplitSource = null;
}

// ── 统一 surface API ──

/**
 * 创建新 terminal surface（智能放置：分屏/堆叠/新 tab，按后端策略）。
 * 无后端时降级为 headless。
 */
export function createSurface(name: string, options?: CreateSurfaceOptions): string {
  validateStartupCommand(options);
  const backend = getMuxBackend();
  if (!backend) {
    lastSplitSource = null;
    const surface = createHeadlessSurface(name);
    if (options?.command !== undefined) spawnHeadlessProcess(surface, name, options.command);
    return surface;
  }
  lastSplitSource = backend === "tmux" ? process.env.TMUX_PANE ?? null : AGENT_ORCA_TERMINAL_HANDLE;
  return backendOps[backend].create(name, options);
}

/** Preserve the existing positional arguments; startup options are the optional fourth argument. */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: CreateSurfaceSplitOptions,
): string {
  validateStartupCommand(options);
  const backend = requireMuxBackend();
  lastSplitSource = fromSurface ?? (backend === "tmux" ? process.env.TMUX_PANE ?? null : AGENT_ORCA_TERMINAL_HANDLE);
  return backendOps[backend].createSplit(name, direction, fromSurface, options);
}

function validateStartupCommand(options?: CreateSurfaceOptions): void {
  if (options?.command !== undefined && !options.command.trim()) {
    throw new Error("Startup command must not be empty.");
  }
}

/**
 * 向 surface 发送命令字符串并执行。
 */
export function sendCommand(surface: string, command: string): void {
  if (isHeadlessSurface(surface)) return;

  const backend = requireMuxBackend();
  backendOps[backend].send(surface, command);
}

/**
 * 向 surface 发送 Escape 按键。
 */
export function sendEscape(surface: string): void {
  if (isHeadlessSurface(surface)) {
    sendHeadlessEscape(surface);
    return;
  }

  const backend = requireMuxBackend();
  backendOps[backend].sendEscape(surface);
}

/**
 * sendLongCommand 选项。interpreter 缺省为 "bash"，与既有全部调用方保持兼容；
 * Windows PowerShell 调用方显式传 "powershell" 才切换到 PowerShell 脚本运行时。
 */
export interface SendLongCommandOptions {
  /** 显式脚本文件路径（原样保留，不自动改扩展名） */
  scriptPath?: string;
  /** 脚本前置片段（Shebang 除外；默认 Bash 时用于注入 env export 等） */
  scriptPreamble?: string;
  /** 脚本解释器，默认 "bash"；显式 "powershell" 时按 PowerShell 语法生成 .ps1 并执行 */
  interpreter?: "bash" | "powershell";
}

// ── 长命令脚本运行时常量 ──

/** 默认解释器：所有平台都保持 Bash，避免改变现有调用方语义 */
const DEFAULT_SEND_INTERPRETER = "bash";
const INTERPRETER_POWERSHELL = "powershell";

/** 解析 sendLongCommand 的解释器；省略时始终保持 Bash 兼容默认值。 */
export function resolveSendInterpreter(
  interpreter?: "bash" | "powershell",
): "bash" | "powershell" {
  return interpreter ?? DEFAULT_SEND_INTERPRETER;
}

/** 脚本文件写入权限：PowerShell 无需可执行位，Bash 脚本需可执行位 */
const POWERSHELL_SCRIPT_MODE = 0o644;
const BASH_SCRIPT_MODE = 0o755;

/** PowerShell -File / -Command 启动器可执行文件名与前导参数 */
const POWERSHELL_EXECUTABLE = "powershell.exe";
const POWERSHELL_LAUNCH_PREFIX = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"] as const;

/**
 * 返回按解释器选择的脚本扩展名（.sh / .ps1），用于自动脚本路径的文件后缀。
 */
export function sendScriptExtension(interpreter: "bash" | "powershell"): string {
  return interpreter === INTERPRETER_POWERSHELL ? ".ps1" : ".sh";
}

/**
 * 生成脚本内容：Bash 以 shebang + \n 分隔，PowerShell 无 shebang 且以 CRLF 分隔。
 */
export function buildSendScriptContent(
  interpreter: "bash" | "powershell",
  preamble: string | undefined,
  command: string,
): string {
  if (interpreter === INTERPRETER_POWERSHELL) {
    const parts: string[] = [];
    if (preamble) parts.push(preamble.trimEnd());
    parts.push(command);
    return parts.join("\r\n") + "\r\n";
  }
  const parts = ["#!/bin/bash"];
  if (preamble) parts.push(preamble.trimEnd());
  parts.push(command);
  return parts.join("\n") + "\n";
}

/**
 * 构建 mux pane 中执行脚本的 shell 调用：Bash 用 `bash <path>`，PowerShell 用
 * `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <path>`。
 */
export function buildMuxInvocation(interpreter: "bash" | "powershell", scriptPath: string): string {
  if (interpreter === INTERPRETER_POWERSHELL) {
    return `${POWERSHELL_EXECUTABLE} ${POWERSHELL_LAUNCH_PREFIX.join(" ")} -File ${powershellEscape(scriptPath)}`;
  }
  return `bash ${shellEscape(scriptPath)}`;
}

/**
 * 向 surface 发送长命令（通过脚本文件避免终端自动换行问题）。
 * 返回脚本文件路径。默认解释器为 Bash（所有平台）；显式 interpreter:"powershell"
 * 时按 PowerShell 语法写 .ps1 并执行。
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: SendLongCommandOptions,
): string {
  const interpreter = resolveSendInterpreter(options?.interpreter);
  const extension = sendScriptExtension(interpreter);

  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${extension}`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const content = buildSendScriptContent(interpreter, options?.scriptPreamble, command);
  const mode = interpreter === INTERPRETER_POWERSHELL ? POWERSHELL_SCRIPT_MODE : BASH_SCRIPT_MODE;
  writeFileSync(scriptPath, content, { mode });

  // Headless mode: spawn as a background child process
  if (isHeadlessSurface(surface)) {
    const headlessCommand =
      interpreter === INTERPRETER_POWERSHELL
        ? `& ${powershellEscape(scriptPath)}`
        : `bash ${shellEscape(scriptPath)}`;
    spawnHeadlessProcess(surface, "subagent", headlessCommand, {
      cwd: process.cwd(),
      env: { PI_SUBAGENT_HEADLESS: "1" },
      interpreter,
    });
    return scriptPath;
  }

  sendCommand(surface, buildMuxInvocation(interpreter, scriptPath));
  return scriptPath;
}

export function readScreen(surface: string, lines = 50): string {
  if (isHeadlessSurface(surface)) return readHeadlessScreen(surface, lines);
  return backendOps[requireMuxBackend()].read(surface, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (isHeadlessSurface(surface)) return readHeadlessScreenAsync(surface, lines);
  return backendOps[requireMuxBackend()].readAsync(surface, lines);
}

/**
 * 关闭 surface。
 */
export function closeSurface(surface: string): void {
  if (isHeadlessSurface(surface)) {
    closeHeadlessSurface(surface);
    return;
  }

  const backend = requireMuxBackend();
  backendOps[backend].close(surface);
}

/**
 * 重命名指定 surface。
 */
export function renameSurface(surface: string, name: string): void {
  if (isHeadlessSurface(surface)) return;

  const backend = requireMuxBackend();
  backendOps[backend].rename(surface, name);
}

export type RenameOperation = "tab" | "workspace";
export type RenameTarget = "window" | "session" | "terminal";
export type RenameBackend = MuxBackend | "headless";

export type RenameCapability =
  | { status: "supported"; backend: MuxBackend; operation: RenameOperation; target: RenameTarget }
  | { status: "unsupported"; backend: RenameBackend; operation: RenameOperation }
  | { status: "disabled"; backend: MuxBackend; operation: RenameOperation; setting: string };

export type RenameResult =
  | { status: "renamed"; backend: MuxBackend; operation: RenameOperation; target: RenameTarget }
  | { status: "unsupported"; backend: RenameBackend; operation: RenameOperation }
  | { status: "disabled"; backend: MuxBackend; operation: RenameOperation; setting: string }
  | { status: "failed"; backend: MuxBackend; operation: RenameOperation; target: RenameTarget; error: string };

/** Report actual rename targets without executing terminal commands. */
export function getRenameCapability(
  operation: RenameOperation,
  backend: MuxBackend | null = getMuxBackend(),
  env: NodeJS.ProcessEnv = process.env,
): RenameCapability {
  if (!backend) return { status: "unsupported", backend: "headless", operation };
  if (backend === "orca") {
    return operation === "tab"
      ? { status: "supported", backend, operation, target: "terminal" }
      : { status: "unsupported", backend, operation };
  }
  const setting = operation === "tab" ? TMUX_WINDOW_RENAME_SETTING : TMUX_SESSION_RENAME_SETTING;
  if (env[setting] !== ENABLED_SETTING_VALUE) return { status: "disabled", backend, operation, setting };
  return { status: "supported", backend, operation, target: operation === "tab" ? "window" : "session" };
}

/** 将终端命令异常封装为可判别的失败结果。 */
function failedRenameResult(
  capability: Extract<RenameCapability, { status: "supported" }>,
  error: unknown,
): RenameResult {
  return {
    status: "failed",
    backend: capability.backend,
    operation: capability.operation,
    target: capability.target,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function renameCurrentTab(title: string): RenameResult {
  const capability = getRenameCapability("tab");
  if (capability.status !== "supported") return capability;
  try {
    if (capability.backend === "tmux") {
      const pane = process.env.TMUX_PANE;
      if (!pane) throw new Error("TMUX_PANE not set");
      const window = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{window_id}"], { encoding: "utf8" }).trim();
      execFileSync("tmux", ["rename-window", "-t", window, title], { encoding: "utf8" });
    } else {
      if (!AGENT_ORCA_TERMINAL_HANDLE) throw new Error("ORCA_TERMINAL_HANDLE not set");
      if (!renameOrcaTerminal(AGENT_ORCA_TERMINAL_HANDLE, title)) throw new Error("Orca did not complete terminal renaming.");
    }
    return { status: "renamed", backend: capability.backend, operation: capability.operation, target: capability.target };
  } catch (error) {
    return failedRenameResult(capability, error);
  }
}

export function renameWorkspace(title: string): RenameResult {
  const capability = getRenameCapability("workspace");
  if (capability.status !== "supported") return capability;
  try {
    const pane = process.env.TMUX_PANE;
    if (!pane) throw new Error("TMUX_PANE not set");
    const session = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{session_id}"], { encoding: "utf8" }).trim();
    execFileSync("tmux", ["rename-session", "-t", session, title], { encoding: "utf8" });
    return { status: "renamed", backend: capability.backend, operation: capability.operation, target: capability.target };
  } catch (error) {
    return failedRenameResult(capability, error);
  }
}

// ── pollForExit ──

/**
 * 类型收窄辅助：将 unknown 收窄为 Record<string, unknown>。
 * 仅应在 typeof v === "object" && v !== null 检查后调用。
 * JSON.parse 返回 any，此处为类型边界必须用 as 收窄。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRecord(v: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return v as Record<string, unknown>;
}

/** pollForExit sentinel 检测每次读取的屏幕行数 */
const SENTINEL_READ_LINES = 200;

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "structured_output" | "sentinel";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Validated structured output if reason is "structured_output" */
  structuredOutput?: unknown;
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const isHeadless = isHeadlessSurface(surface);

  for (;;) {
    if (signal.aborted) {
      muxLog(`[pollForExit] ABORTED at loop start surface=${surface} elapsed=${Date.now() - start}ms — signal was aborted before/synchronously after watchSubagent entered poll loop (likely stale POLL_ABORT_KEY controller). Throwing "Aborted while waiting..."\n`);
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file
    if (options.sessionFile) {
      const exitFile = `${options.sessionFile}.exit`;
      try {
        if (existsSync(exitFile)) {
          let data: unknown;
          try {
            data = JSON.parse(readFileSync(exitFile, "utf8"));
          } catch (parseErr: unknown) {
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            muxLog(
              `[pollForExit] FAST PATH BUG: ${exitFile} exists but JSON.parse failed: ${errMsg}\n` +
                `[pollForExit] contents(raw)=${JSON.stringify((() => { try { return readFileSync(exitFile, "utf8"); } catch { return "<unreadable>"; } })())}\n`,
            );
            throw parseErr;
          }
          // 双重确认：子 pi 进程必须已启动
          const sessionJsonl = options.sessionFile;
          try {
            if (!existsSync(sessionJsonl) || (await (await import("node:fs/promises")).stat(sessionJsonl)).size === 0) {
              rmSync(exitFile, { force: true });
              muxLog(
                `[pollForExit] fast path FALSE POSITIVE: ${exitFile} type=${String((data as Record<string, unknown>).type)} but ${sessionJsonl} is ` +
                  `${existsSync(sessionJsonl) ? `empty (0 bytes)` : `missing`} — subagent never started, ` +
                  `deleting stale .exit and continuing poll\n`,
              );
              throw Object.assign(new Error("subprocess not started"), { code: "SUBPROCESS_NOT_STARTED" });
            }
          } catch (e2: unknown) {
            if (e2 instanceof Error && (e2 as Error & { code?: string }).code === "SUBPROCESS_NOT_STARTED") throw e2;
            muxLog(`[pollForExit] session jsonl check failed (non-fatal): ${e2 instanceof Error ? e2.message : String(e2)}\n`);
          }
          rmSync(exitFile, { force: true });
          if (typeof data !== "object" || data === null) {
            muxLog(`[pollForExit] fast path unexpected data type exitFile=${exitFile}\n`);
            return { reason: "done", exitCode: 0 };
          }
          const typed = asRecord(data);
          muxLog(`[pollForExit] fast path hit exitFile=${exitFile} type=${String(typed.type)}\n`);
          if (typed.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: String(typed.name ?? ""), message: String(typed.message ?? "") } };
          }
          if (typed.type === "structured_output") {
            return { reason: "structured_output", exitCode: 0, structuredOutput: typed.value };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch (e: any) {
        if (e?.code !== "ENOENT" && e?.code !== "SUBPROCESS_NOT_STARTED") {
          muxLog(
            `[pollForExit] fast path error sessionFile=${options.sessionFile} err=${e?.message ?? String(e)}\n`,
          );
        }
      }
    }

    // Check Claude sentinel file
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          muxLog(`[pollForExit] sentinel file hit path=${options.sentinelFile}\n`);
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch (e: any) {
        muxLog(
          `[pollForExit] sentinel file check error path=${options.sentinelFile} err=${e?.message ?? String(e)}\n`,
        );
      }
    }

    // Headless mode: check if the child process has exited
    if (isHeadless) {
      const headlessExit = getHeadlessProcessExit(surface);
      if (headlessExit) {
        const { exitCode } = await Promise.race([
          headlessExit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 100),
          ),
        ]).catch(() => ({ exitCode: null as number | null }));
        if (exitCode !== null && exitCode !== undefined) {
          drainHeadlessProcess(surface);
          return { reason: "sentinel", exitCode };
        }
      }
    }

    // Slow path: read terminal screen for sentinel
    if (!isHeadless) {
      let screen = "";
      let readErr: unknown = null;
      try {
        screen = await readScreenAsync(surface, SENTINEL_READ_LINES);
      } catch (e) {
        readErr = e;
      }

      if (readErr) {
        muxLog(
          `[pollForExit] slow path read screen FAILED surface=${surface} err=${(readErr as Error)?.message ?? String(readErr)}\n`,
        );
        if (options.sessionFile) {
          const exitFile = `${options.sessionFile}.exit`;
          try {
            if (existsSync(exitFile)) {
              const raw: unknown = JSON.parse(readFileSync(exitFile, "utf8"));
              if (typeof raw !== "object" || raw === null) {
                return { reason: "done", exitCode: 0 };
              }
              const rData: Record<string, unknown> = asRecord(raw);
              rmSync(exitFile, { force: true });
              muxLog(`[pollForExit] recovery via .exit after screen read failure file=${exitFile} type=${String(rData.type)}\n`);
              if (rData.type === "ping") {
                return { reason: "ping", exitCode: 0, ping: { name: String(rData.name ?? ""), message: String(rData.message ?? "") } };
              }
              if (rData.type === "structured_output") {
                return { reason: "structured_output", exitCode: 0, structuredOutput: rData.value };
              }
              return { reason: "done", exitCode: 0 };
            }
          } catch (e2: unknown) {
            muxLog(
              `[pollForExit] recovery .exit check FAILED file=${exitFile} err=${e2 instanceof Error ? e2.message : String(e2)}\n`,
            );
          }
        }
      } else {
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) {
          muxLog(`[pollForExit] slow path sentinel hit surface=${surface} exitCode=${match[1]}\n`);
          return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
        }
        // 每 10 秒记一次屏幕尾部快照
        if (Date.now() - start > 0 && Math.floor((Date.now() - start) / 1000) % 10 === 0) {
          muxLog(
            `[pollForExit] slow path no sentinel surface=${surface} tail=${JSON.stringify(screen.slice(-200))}\n`,
          );
        }
      }
    } else if (options.sessionFile) {
      const exitFile = `${options.sessionFile}.exit`;
      try {
        if (existsSync(exitFile)) {
          const raw = JSON.parse(readFileSync(exitFile, "utf8"));
          if (typeof raw !== "object" || raw === null) {
            return { reason: "done", exitCode: 0 };
          }
          const hData = asRecord(raw);
          rmSync(exitFile, { force: true });
          muxLog(`[pollForExit] headless .exit hit file=${exitFile} type=${hData.type}\n`);
          if (hData.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: String(hData.name ?? ""), message: String(hData.message ?? "") } };
          }
          if (hData.type === "structured_output") {
            return { reason: "structured_output", exitCode: 0, structuredOutput: hData.value };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch (e: unknown) {
        muxLog(
          `[pollForExit] headless .exit check FAILED file=${exitFile} err=${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
