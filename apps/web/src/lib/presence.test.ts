import { describe, it, expect } from "vitest";
import type { PresenceUser } from "@/lib/websocket";
import { dedupePresenceByUser, removePresence, upsertPresence } from "./presence";

function user(userId: string, displayName = userId): PresenceUser {
  return { userId, displayName, color: "#123456", anchor: null, head: null };
}

describe("dedupePresenceByUser", () => {
  it("collapses two tabs of the same user into one entry", () => {
    const list = dedupePresenceByUser([user("u1", "Ada"), user("u2"), user("u1", "Ada (tab 2)")]);
    expect(list).toHaveLength(2);
    expect(list.map((u) => u.userId)).toEqual(["u1", "u2"]);
    // Last write wins for the deduped entry.
    expect(list.find((u) => u.userId === "u1")?.displayName).toBe("Ada (tab 2)");
  });

  it("returns an empty list for no users", () => {
    expect(dedupePresenceByUser([])).toEqual([]);
  });
});

describe("upsertPresence", () => {
  it("appends a genuinely new user", () => {
    const next = upsertPresence([user("u1")], user("u2"));
    expect(next.map((u) => u.userId)).toEqual(["u1", "u2"]);
  });

  it("replaces an existing user in place without reordering", () => {
    const next = upsertPresence([user("u1"), user("u2")], user("u1", "renamed"));
    expect(next.map((u) => u.userId)).toEqual(["u1", "u2"]);
    expect(next[0]!.displayName).toBe("renamed");
  });
});

describe("removePresence", () => {
  it("drops the matching user and leaves the rest", () => {
    expect(removePresence([user("u1"), user("u2")], "u1").map((u) => u.userId)).toEqual(["u2"]);
  });

  it("is a no-op for an unknown user", () => {
    expect(removePresence([user("u1")], "nope").map((u) => u.userId)).toEqual(["u1"]);
  });
});
