import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { i18n } from "./i18n.ts";

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("ff")) return true;
  // URL parsing canonicalizes mapped IPv4 literals to hexadecimal (for
  // example ::ffff:127.0.0.1 becomes ::ffff:7f00:1). Reject the mapped range
  // wholesale rather than risk bypassing the IPv4 checks.
  if (value.startsWith("::ffff:")) return true;
  return false;
}

export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  return false;
}

export function parseAndAssertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(i18n.t("error.invalidUrl", { url: raw }));
  }
  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error(i18n.t("error.unsupportedUrlProtocol", { protocol: url.protocol }));
  }
  if (url.username || url.password) throw new Error(i18n.t("error.urlCredentials"));
  if (isPrivateOrLoopbackHostname(url.hostname)) {
    throw new Error(i18n.t("error.privateAddress", { host: url.hostname }));
  }
  return url;
}

function assertPublicAddresses(hostname: string, addresses: Array<{ address: string; family: number }>): void {
  if (addresses.length === 0) throw new Error(i18n.t("error.noDnsAddress", { host: hostname }));
  for (const entry of addresses) {
    if (isPrivateOrLoopbackHostname(entry.address)) {
      throw new Error(i18n.t("error.privateDnsAddress", { host: hostname, address: entry.address }));
    }
  }
}

export async function assertPublicDns(url: URL): Promise<void> {
  const hostname = normalizeHost(url.hostname);
  if (isIP(hostname)) return;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  assertPublicAddresses(hostname, addresses);
}

/**
 * DNS lookup used by the direct-fetch connection itself. Validation and
 * address selection happen in the same lookup callback consumed by the
 * socket connector, preventing a second attacker-controlled resolution.
 */
export const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  const normalized = normalizeHost(hostname);
  lookup(normalized, {
    all: true,
    verbatim: true,
    family: options.family,
    hints: options.hints,
  }).then((addresses) => {
    assertPublicAddresses(normalized, addresses);
    if (options.all) {
      (callback as any)(null, addresses);
      return;
    }
    const selected = addresses[0];
    (callback as any)(null, selected.address, selected.family);
  }).catch((error) => (callback as any)(error));
};
