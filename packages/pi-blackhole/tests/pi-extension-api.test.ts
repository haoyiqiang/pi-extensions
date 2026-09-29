import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("extension API double", () => {
  it("keeps the callback argument contract on the package typecheck", () => {
    // `tests/fixtures/pi-extension-api.typecheck.ts` proves replay preserves each
    // callback's argument types. Running it here would spawn a compiler inside the
    // test suite and starve the parallel workers, so the package tsconfig checks it
    // during `npm run typecheck`. Fail loudly if that include disappears.
    const tsconfig = JSON.parse(readFileSync(join(PACKAGE_ROOT, "tsconfig.json"), "utf8")) as {
      include?: string[];
    };
    expect(tsconfig.include).toContain("tests/fixtures/pi-extension-api.typecheck.ts");
  });

  it("fails loudly for an unused host member", () => {
    expect(() => createExtensionApiDouble().getFlag("unused")).toThrow(
      "createExtensionApiDouble: getFlag is not implemented",
    );
  });
});
