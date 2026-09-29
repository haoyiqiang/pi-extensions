import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute root directory of an installed package.
 *
 * These tests point the adapter at the real host and run the real TypeScript
 * compiler, and a package-local `node_modules` path only exists in a standalone
 * checkout. Walk up from this file the way Node resolves a bare specifier, so the
 * helper works from a package-local install, a hoisted monorepo workspace, or a
 * nested duplicate install.
 */
export function installedPackageRoot(packageName: string, from: string = HERE): string {
	let dir = from;
	while (true) {
		const candidate = join(dir, "node_modules", ...packageName.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Cannot resolve installed package "${packageName}" above ${from}`);
}
