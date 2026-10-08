import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test-setup.ts"],
    fileParallelism: false,
    testTimeout: 40_000,
  },
});
