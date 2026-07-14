import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration test files share one real Postgres test database (syncflow_test) and each
    // truncates it between tests — running files in parallel lets one file's truncation wipe
    // out another file's in-progress data mid-test. Sequential file execution trades a little
    // speed for correctness; per-file databases would keep parallelism but aren't worth the
    // extra infra at this suite's size.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/server.ts", "src/seed.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        statements: 80,
      },
    },
  },
});
