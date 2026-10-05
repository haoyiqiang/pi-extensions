/**
 * mtime-keyed jiti import cache. jiti's MODULE cache is disabled so `/reload`
 * picks up edits without restart; its fs TRANSFORM cache stays on (the
 * default) — entries are content-hash validated, so an edited overlay can
 * never be served stale, and fresh sessions skip the ~70ms/file Babel
 * re-transform. This wrapper layers a stat-driven cache on top so unchanged
 * overlays don't re-evaluate top-level code on every `/wf` invocation.
 *
 * The `jiti` instance lives here so the cache and the underlying importer
 * co-locate. Other loader modules import `cachedImport` — none touches
 * `jiti` directly.
 *
 * The cache does not invalidate on file deletion — a stale entry for a
 * deleted overlay sits dormant (the enumerator never passes it back to
 * `cachedImport`). The cache resets on `__resetLoadCache()` (wired into
 * `test/setup.ts` `beforeEach`) and on process exit.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	// Module cache OFF so /reload picks up edits without restart. The fs
	// transform cache (default ON) is deliberately kept: it is content-hash
	// validated (edit-safe) and saves ~70ms/file of Babel work per session.
	moduleCache: false,
	// Scoped to overlay evaluation: existing definitions need no upstream install.
	alias: Object.fromEntries(
		["@maplezzk/pi-workflow", "@juicesharp/rpiv-workflow"].flatMap((name) => [
			[`${name}/registration`, fileURLToPath(new URL("../registration.ts", import.meta.url))],
			[`${name}/startup`, fileURLToPath(new URL("../startup.ts", import.meta.url))],
			[`${name}/runner`, fileURLToPath(new URL("../runner/index.ts", import.meta.url))],
			[`${name}/internal`, fileURLToPath(new URL("../internal.ts", import.meta.url))],
			[name, fileURLToPath(new URL("../index.ts", import.meta.url))],
		]),
	),
});

const overlayCache = new Map<string, { mtimeMs: number; parsed: unknown }>();

export async function cachedImport(path: string): Promise<unknown> {
	const stat = statSync(path);
	const cached = overlayCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
	const value = await jiti.import(path, { default: true });
	overlayCache.set(path, { mtimeMs: stat.mtimeMs, parsed: value });
	return value;
}

/** Test-only reset. Wired into `test/setup.ts` `beforeEach`. */
export function __resetLoadCache(): void {
	overlayCache.clear();
}
