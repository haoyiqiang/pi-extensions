import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    maxWorkers: 4,
    hookTimeout: 30_000,
    testTimeout: 15_000,
    unstubGlobals: true,
    clearMocks: true,
    restoreMocks: true,
    // Keep Pi's registries shared if a regression exercises its real runtime.
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
