/** 轻量运行时没有完整 ctx 时，仍通过已有 UI 提示。 */
export function notifyBlackhole(
  ctx: { hasUI?: boolean; ui?: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  level: "info" | "warning" | "error",
  message: string,
): void {
  ctx.ui?.notify(message, level);
}
