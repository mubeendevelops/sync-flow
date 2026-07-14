import { describe, expect, it } from "vitest";
import { AppError } from "./app-error.js";

describe("AppError static factories", () => {
  it("internal() defaults to 500 and carries an optional cause", () => {
    const cause = new Error("db exploded");
    const err = AppError.internal("db unavailable", cause);
    expect(err.status).toBe(500);
    expect(err.title).toBe("Internal Server Error");
    expect(err.cause).toBe(cause);
  });

  it("notImplemented() defaults to 501", () => {
    const err = AppError.notImplemented("undo disabled");
    expect(err.status).toBe(501);
    expect(err.title).toBe("Not Implemented");
    expect(err.detail).toBe("undo disabled");
  });
});
