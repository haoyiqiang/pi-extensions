import { readFileSync } from "node:fs";

/**
 * Distro identifiers from os-release content: `ID` first, then `ID_LIKE`.
 *
 * Derivatives inherit their parent's identity this way, so `ID=cachyos` with
 * `ID_LIKE=arch` still resolves to the Arch logo.
 */
export function parseDistroIds(osRelease: string): string[] {
  const fields = new Map<string, string>();
  for (const line of osRelease.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields.set(match[1], match[2].replace(/^["']|["']$/g, "").toLowerCase());
  }
  const ids = [fields.get("ID"), ...(fields.get("ID_LIKE") ?? "").split(/\s+/)];
  return ids.filter((id): id is string => Boolean(id));
}

let cached: string[] | undefined;

/** The running distro's identifiers, read from /etc/os-release once per process. */
export function linuxDistroIds(): string[] {
  cached ??= readDistroIds();
  return cached;
}

function readDistroIds(): string[] {
  try {
    return parseDistroIds(readFileSync("/etc/os-release", "utf8"));
  } catch {
    return [];
  }
}
