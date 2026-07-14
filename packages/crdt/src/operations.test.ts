import { describe, it, expect } from "vitest";
import { makeDoc } from "./harness.js";
import { localInsert } from "./operations.js";

describe("localInsert", () => {
  it("rejects a value that is not exactly one character", () => {
    const doc = makeDoc("r1");
    expect(() => localInsert(doc, 0, "")).toThrow(/exactly one character/);
    expect(() => localInsert(doc, 0, "ab")).toThrow(/exactly one character/);
  });
});
