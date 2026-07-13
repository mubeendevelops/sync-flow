import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Pure in-memory tests with no shared external state (unlike the server suite, which shares
    // one Postgres db and must run files serially) — safe to run files in parallel.
  },
});
