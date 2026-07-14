import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { AppError } from "../errors/app-error.js";
import { toErrorPayload, respondError } from "./errors.js";

describe("toErrorPayload", () => {
  it("surfaces an AppError's own status + message", () => {
    expect(toErrorPayload(AppError.forbidden("nope"))).toEqual({ code: 403, message: "nope" });
  });

  it("logs and masks an unexpected error as a generic 500", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const raw = new Error("boom");
    expect(toErrorPayload(raw, logger)).toEqual({
      code: 500,
      message: "Internal server error",
    });
    expect(logger.error).toHaveBeenCalledWith({ err: raw }, "unexpected socket error");
  });
});

describe("respondError", () => {
  it("replies via the ack callback when one was given", () => {
    const ack = vi.fn();
    respondError({} as Socket, ack, AppError.badRequest("bad"));
    expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: 400, message: "bad" } });
  });

  it("falls back to the error event when no ack was given", () => {
    const emit = vi.fn();
    const socket = { emit } as unknown as Socket;
    respondError(socket, undefined, AppError.notFound("gone"));
    expect(emit).toHaveBeenCalledWith("error", { code: 404, message: "gone" });
  });
});
