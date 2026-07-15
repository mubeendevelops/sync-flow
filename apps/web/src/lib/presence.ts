/**
 * Presence list helpers. The server's presence hash is keyed by userId, so a single user with
 * two open tabs is one participant — these keep the client's active-user list deduplicated by
 * userId (last write wins, preserving first-seen order) as joins/leaves stream in.
 */

import type { PresenceUser } from "@/lib/websocket";

/** Collapse a raw presence list to one entry per userId, keeping first-seen order. */
export function dedupePresenceByUser(users: readonly PresenceUser[]): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>();
  for (const user of users) byUser.set(user.userId, user);
  return Array.from(byUser.values());
}

/** Insert or replace a user in the list, keeping order stable (existing slot reused). */
export function upsertPresence(
  users: readonly PresenceUser[],
  next: PresenceUser,
): PresenceUser[] {
  const idx = users.findIndex((u) => u.userId === next.userId);
  if (idx === -1) return [...users, next];
  const copy = users.slice();
  copy[idx] = next;
  return copy;
}

/** Drop a user from the list by userId. */
export function removePresence(
  users: readonly PresenceUser[],
  userId: string,
): PresenceUser[] {
  return users.filter((u) => u.userId !== userId);
}
