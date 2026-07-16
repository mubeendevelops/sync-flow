import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import {
  API_PORT,
  API_URL,
  E2E_DATABASE_URL,
  E2E_REDIS_URL,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  WEB_PORT,
  WEB_URL,
  WS_URL,
} from "./env.ts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// `pnpm --filter <pkg> exec <cmd>` runs with cwd = that package's directory, and no dotenv
// wrapper — every env var the process needs must be supplied explicitly below (nothing is
// silently inherited from the repo's .env, which points at the dev ports/database instead).
const serverEnv: Record<string, string> = {
  NODE_ENV: "test",
  PORT: String(API_PORT),
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL: E2E_REDIS_URL,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL: "15m",
  JWT_REFRESH_TTL: "7d",
  COOKIE_DOMAIN: "localhost",
  CORS_ORIGIN: WEB_URL,
  LOG_LEVEL: "warn",
  // The suite signs up dozens of users (10 alone in the ten_editors spec) against one
  // long-lived server instance — well above the default 20/15min signup+login limiter.
  AUTH_RATE_LIMIT_MAX: "1000",
};

const webEnv: Record<string, string> = {
  NEXT_PUBLIC_API_URL: API_URL,
  NEXT_PUBLIC_WS_URL: WS_URL,
};

export default defineConfig({
  testDir: "./specs",
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Ten real browser contexts in the ten_editors spec + several two-context specs are already
  // memory/CPU heavy; capping workers avoids starving any one test's WS connections of CPU
  // time (a real cause of flaky "converged within Nms" assertions, not a test bug).
  workers: process.env.CI ? 3 : 4,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter server exec tsx src/server.ts",
      cwd: REPO_ROOT,
      url: `${API_URL}/health`,
      env: serverEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // A production build+start, not `next dev`: dev mode's on-demand route compilation
      // interacts badly with programmatic `router.push()` client-side navigation to a route
      // that hasn't been visited yet — the navigation silently never completes (no request is
      // even sent), which isn't a webServer-readiness issue at all, so retrying/waiting longer
      // doesn't help. Reproduced directly against `next dev` and confirmed absent against
      // `next build && next start`. Tests should exercise the app the way it actually ships.
      command: `pnpm --filter web exec next build && pnpm --filter web exec next start -p ${WEB_PORT}`,
      cwd: REPO_ROOT,
      url: WEB_URL,
      env: webEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
