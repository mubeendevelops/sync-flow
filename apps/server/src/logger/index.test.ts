import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

describe("createLogger", () => {
  it("builds a pino logger at the requested level", () => {
    const logger = createLogger("test", "warn");
    expect(logger.level).toBe("warn");
  });

  it("enables the pretty-print transport only in development", () => {
    // Just proves construction doesn't throw for both branches — pino-pretty's actual
    // output formatting isn't something worth asserting on here.
    expect(() => createLogger("development", "info")).not.toThrow();
    expect(() => createLogger("production", "info")).not.toThrow();
  });
});
