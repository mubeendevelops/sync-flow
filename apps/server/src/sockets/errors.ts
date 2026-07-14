/**
 * Translate thrown errors into the socket wire shape. Mirrors the HTTP `error-handler`
 * middleware: an `AppError` surfaces its status + safe message; anything else is a
 * generic 500 with the real error logged server-side and never leaked to the client.
 */

import type { Socket } from "socket.io";
import { AppError } from "../errors/app-error.js";
import type { Ack, SocketErrorPayload } from "./types.js";
import type { DocumentStoreLogger } from "../crdt-service/document-store.js";

export function toErrorPayload(err: unknown, logger?: DocumentStoreLogger): SocketErrorPayload {
  if (err instanceof AppError) {
    return { code: err.status, message: err.detail ?? err.title };
  }
  logger?.error({ err }, "unexpected socket error");
  return { code: 500, message: "Internal server error" };
}

/**
 * Report a failure back to the caller. Prefers the ack envelope (so the client can
 * correlate it with its request); falls back to the `error` channel when the client
 * gave no callback.
 */
export function respondError(
  socket: Socket,
  ack: Ack<never> | undefined,
  err: unknown,
  logger?: DocumentStoreLogger,
): void {
  const error = toErrorPayload(err, logger);
  if (typeof ack === "function") {
    ack({ ok: false, error });
  } else {
    socket.emit("error", error);
  }
}
