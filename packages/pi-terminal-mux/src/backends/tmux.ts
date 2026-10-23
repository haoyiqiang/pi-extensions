/**
 * backends/tmux.ts — Tmux 终端后端
 *
 * Tmux 特定的 surface 操作：split-window / send-keys / capture-pane / kill-pane。
 * Tmux 没有 pane 级命名，rename 退化为 window 命名。
 */

import { execFileSync, execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createBackendLogger } from "./shared.ts";
import type { BackendOps, CreateSurfaceOptions, SurfaceState } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Tmux 后端日志（统一格式，写入 /tmp/pi-mux-tmux.log） */
const tmuxLog = createBackendLogger("tmux", "/tmp/pi-mux-tmux.log");

export const ops: BackendOps = {
  create(name: string, options?: CreateSurfaceOptions): string {
    return ops.createSplit(name, "right", process.env.TMUX_PANE, options);
  },

  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string, options?: CreateSurfaceOptions): string {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");
    if (options?.command !== undefined) args.push("--", options.command);

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    tmuxLog(
      `[split] dir=${direction} from=${fromSurface ?? "<unset>"} new=${pane} name=${JSON.stringify(name)}`,
    );
    return pane;
  },

  send(surface: string, command: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
  },

  sendEscape(surface: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
  },

  read(surface: string, lines = 50): string {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  },

  async readAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  },

  close(surface: string): void {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    tmuxLog(`[close] surface=${surface}`);
  },

  rename(surface: string, name: string): void {
    // tmux 没有 pane 级命名，退化为所在 window 命名
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, name], { encoding: "utf8" });
  },

  state(surface: string): SurfaceState {
    const result = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8", timeout: 5000 });
    if (result.status === 0) return result.stdout.split(/\s+/).includes(surface) ? "present" : "absent";
    if (/no server running|error connecting.*No such file|failed to connect.*No such file/.test(result.stderr ?? "")) return "absent";
    return "unknown";
  },
};
