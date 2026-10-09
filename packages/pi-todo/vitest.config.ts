import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
