import { fileURLToPath } from "node:url";
import { verifyShipManifest } from "../test/upstream/index.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
import { describe, expect, it } from "vitest";

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		expect(verifyShipManifest(packageRoot).missing).toEqual([]);
	});

	it("every `files` entry points at something on disk — a stale entry ships nothing", () => {
		expect(verifyShipManifest(packageRoot).stale).toEqual([]);
	});
});
