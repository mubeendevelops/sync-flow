import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // lib/api-client.ts crashes at import time without this — dev/build get it from the root
    // .env via dotenv-cli, but vitest doesn't go through that, and modules that transitively
    // import it (even just for types re-exported at runtime) need it to be importable at all.
    env: { NEXT_PUBLIC_API_URL: "http://localhost:4000" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
