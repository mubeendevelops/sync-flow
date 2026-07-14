import { describe, expect, it, beforeEach } from "vitest";
import { useAuthStore } from "./auth-store";

const testUser = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "ada",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  presenceColor: "#4f46e5",
};

describe("useAuthStore", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null });
  });

  it("starts with no user", () => {
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("setUser stores the given user", () => {
    useAuthStore.getState().setUser(testUser);
    expect(useAuthStore.getState().user).toEqual(testUser);
  });

  it("clear resets back to null", () => {
    useAuthStore.getState().setUser(testUser);
    useAuthStore.getState().clear();
    expect(useAuthStore.getState().user).toBeNull();
  });
});
