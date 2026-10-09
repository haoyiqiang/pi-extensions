import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Importing a test file's first module can be I/O-bound on slow or external
    // disks, so allow headroom above the 10s default for tests that load the graph.
    testTimeout: 120_000,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: [
      // Resolve .js → extension-less for our TypeScript source files
      {
        find: /\.js$/,
        replacement: "",
      },
    ],
  },
});
