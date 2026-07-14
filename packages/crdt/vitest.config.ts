import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Pure in-memory tests with no shared external state (unlike the server suite, which shares
    // one Postgres db and must run files serially) — safe to run files in parallel.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/harness.ts", "src/benchmark.test.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 100,
      },
    },
  },
});
