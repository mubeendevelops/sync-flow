import { describe, expect, it } from "vitest";
import { toSavedState } from "@/lib/connection-status";

describe("toSavedState", () => {
  it("is offline when the socket is offline, regardless of isSaving", () => {
    expect(toSavedState("offline", false)).toBe("offline");
    expect(toSavedState("offline", true)).toBe("offline");
  });

  it("is reconnecting for both connecting and reconnecting socket states", () => {
    expect(toSavedState("connecting", false)).toBe("reconnecting");
    expect(toSavedState("reconnecting", false)).toBe("reconnecting");
    expect(toSavedState("connecting", true)).toBe("reconnecting");
  });

  it("is saving when connected with an op in flight", () => {
    expect(toSavedState("connected", true)).toBe("saving");
  });

  it("is saved when connected and idle", () => {
    expect(toSavedState("connected", false)).toBe("saved");
  });
});
