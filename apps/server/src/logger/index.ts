import pino, { type Logger } from "pino";

export function createLogger(nodeEnv: string, level: string): Logger {
  return pino({
    level,
    transport:
      nodeEnv === "development"
        ? {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l" },
          }
        : undefined,
  });
}

export type { Logger };
