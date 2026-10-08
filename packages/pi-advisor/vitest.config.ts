import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 120_000,
  },
  resolve: {
    alias: [{ find: /\\.js$/, replacement: "" }],
  },
});
