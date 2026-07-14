import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./env.js";

const VALID_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "a".repeat(16),
  JWT_REFRESH_SECRET: "b".repeat(16),
  CORS_ORIGIN: "http://localhost:3000",
};

describe("loadConfig", () => {
  it("parses a valid environment and applies defaults", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(4000);
    expect(config.JWT_ACCESS_TTL).toBe("15m");
    expect(config.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
  });

  it("exits the process with a per-field error message when required secrets are missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    loadConfig({});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
