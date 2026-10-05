/**
 * Overlay file system paths for the user and project layers.
 *
 *   user    — config `~/.config/rpiv-workflow/config.ts`
 *             packs  `~/.config/rpiv-workflow/packs/*.ts`
 *   project — config `<cwd>/.rpiv/workflows/config.ts`
 *             packs  `<cwd>/.rpiv/workflows/packs/*.ts`
 *
 * Project config lives under the unified `.rpiv/<domain>/` tree alongside
 * run state (`.rpiv/workflows/runs/`), so the package no longer carries the
 * legacy `.rpiv-workflow/` outlier directory.
 */

import { join } from "node:path";
import { getLegacyWorkflowConfigDir } from "../config.js";

export interface OverlayPaths {
	/** Config file — the only place `default` may live. */
	configFile: string;
	/** Packs directory — alpha-sorted `*.ts` files merged before the config file. */
	packsDir: string;
}

/** Project overlay paths under `<cwd>/.rpiv/workflows/`. */
export function projectOverlayPaths(cwd: string): OverlayPaths {
	const root = join(cwd, ".rpiv", "workflows");
	return { configFile: join(root, "config.ts"), packsDir: join(root, "packs") };
}

/** User overlay paths under `~/.config/rpiv-workflow/`. */
export function userOverlayPaths(): OverlayPaths {
	return {
		configFile: join(getLegacyWorkflowConfigDir(), "config.ts"),
		packsDir: join(getLegacyWorkflowConfigDir(), "packs"),
	};
}
