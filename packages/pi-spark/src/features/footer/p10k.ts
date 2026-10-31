/** Nerd Font glyphs matching a lean powerlevel10k prompt (`nerdfont-v3`). */
const APPLE = "\uF179";
const LINUX = "\uF17C";
const WINDOWS = "\uF17A";
const SEPARATOR = "\uE0B1";
const FOLDER = "\uF115";
const GIT = "\uF113";
const BRANCH = "\uF126";

/** Distro logos from the `nf-linux-*` set, the same codepoints powerlevel10k uses for `nerdfont-v3`. */
const DISTRO_ICONS: Record<string, string> = {
  alpine: "\uF300",
  arch: "\uF303",
  artix: "\uF31F",
  centos: "\uF304",
  debian: "\uF306",
  endeavouros: "\uF322",
  fedora: "\uF30A",
  gentoo: "\uF30D",
  kali: "\uF327",
  linuxmint: "\uF30E",
  manjaro: "\uF312",
  nixos: "\uF313",
  "opensuse-leap": "\uF314",
  "opensuse-tumbleweed": "\uF314",
  raspbian: "\uF315",
  redhat: "\uF316",
  rocky: "\uF32B",
  suse: "\uF314",
  ubuntu: "\uF31B",
  void: "\uF32E",
};

export interface P10kPaint {
  text: (value: string) => string;
  dim: (value: string) => string;
  accent: (value: string) => string;
  success: (value: string) => string;
}

export interface P10kLeftInput {
  osIcon?: string;
  /** Already styled, usually a fish-shortened cwd. */
  path: string;
  branch: string | null;
}

export function osPromptIcon(platform: NodeJS.Platform, distroIds: readonly string[] = []): string | undefined {
  switch (platform) {
    case "darwin":
      return APPLE;
    case "linux":
      return distroIds.map((id) => (Object.hasOwn(DISTRO_ICONS, id) ? DISTRO_ICONS[id] : undefined)).find(Boolean) ?? LINUX;
    case "win32":
      return WINDOWS;
    default:
      return undefined;
  }
}

/** Lean p10k left prompt: os, folder + path, then `on` + git branch. */
export function formatP10kLeft(input: P10kLeftInput, paint: P10kPaint): string {
  const separator = paint.dim(` ${SEPARATOR} `);
  const segments = [];
  if (input.osIcon) segments.push(paint.text(input.osIcon));
  segments.push(`${paint.accent(FOLDER)} ${input.path}`);

  const head = segments.join(separator);
  if (!input.branch) return head;

  const vcs = [paint.dim("on"), paint.success(GIT), paint.success(`${BRANCH} ${input.branch}`)].join(" ");
  return `${head}${separator}${vcs}`;
}
