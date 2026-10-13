import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const REMOTE_SOURCE = /^(npm:|git:|github:|https?:|ssh:)/;

interface PackageSource {
	source: string;
	extensions?: string[];
}

/** Extension files and index-bearing directories Pi loads from a conventional extensions directory. */
function listExtensionEntries(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) found.push(path);
		else if (entry.isDirectory() && (existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js")))) found.push(path);
	}
	return found;
}

/** Individual extension entries a local package exposes, via manifest or conventional discovery. */
function packageEntries(packageDir: string, declared?: string[]): string[] {
	if (declared) return declared.map((entry) => resolve(packageDir, entry));
	const manifestPath = join(packageDir, "package.json");
	if (existsSync(manifestPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pi?: { extensions?: unknown } };
			const extensions = manifest.pi?.extensions;
			if (Array.isArray(extensions) && extensions.every((entry) => typeof entry === "string"))
				return extensions.map((entry) => resolve(packageDir, entry));
		} catch {
			// Malformed manifests fall back to conventional discovery.
		}
	}
	return listExtensionEntries(join(packageDir, "extensions"));
}

function readPackageSources(settingsPath: string): PackageSource[] {
	if (!existsSync(settingsPath)) return [];
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		if (!Array.isArray(settings.packages)) return [];
		return settings.packages.flatMap((entry): PackageSource[] => {
			if (typeof entry === "string") return [{ source: entry }];
			if (typeof entry !== "object" || entry === null) return [];
			const { source, extensions } = entry as PackageSource;
			if (typeof source !== "string") return [];
			return [{ source, extensions: Array.isArray(extensions) ? extensions.filter((item) => typeof item === "string") : undefined }];
		});
	} catch {
		return [];
	}
}

/** Extension sources Pi discovers for a working directory: configured packages plus conventional dirs. */
export function discoverExtensionSources(cwd: string): string[] {
	const agentDir = getAgentDir();
	const found = [
		...listExtensionEntries(join(agentDir, "extensions")),
		...listExtensionEntries(join(cwd, ".pi", "extensions")),
	];
	for (const settingsPath of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
		for (const { source, extensions } of readPackageSources(settingsPath)) {
			if (REMOTE_SOURCE.test(source)) {
				found.push(source);
				continue;
			}
			const packageDir = resolve(dirname(settingsPath), source);
			if (existsSync(packageDir)) found.push(...packageEntries(packageDir, extensions));
		}
	}
	return [...new Set(found)].sort();
}
