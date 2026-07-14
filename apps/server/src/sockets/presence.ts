/**
 * Live presence — remote cursors/selections + the participant list — stored ONLY in
 * Redis with a TTL (PLAN 2.9: ephemeral, never persisted to Postgres). Per document,
 * a hash `presence:{docId}` maps `socketId -> JSON(PresenceUser)`; the hash's TTL is
 * refreshed on every write and on edit activity, so a crashed/abruptly-dropped client
 * disappears on its own even if `disconnect` cleanup never ran.
 */

import type { PresenceUser } from "./types.js";

/** Narrow structural subset of the redis client used for presence (real client satisfies it). */
export interface PresenceCache {
  hSet(key: string, field: string, value: string): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Long enough to survive a brief network blip, short enough to reap ghosts quickly. */
export const PRESENCE_TTL_SECONDS = 60;

function presenceKey(documentId: string): string {
  return `presence:${documentId}`;
}

export async function setPresence(
  cache: PresenceCache,
  documentId: string,
  socketId: string,
  user: PresenceUser,
): Promise<void> {
  const key = presenceKey(documentId);
  await cache.hSet(key, socketId, JSON.stringify(user));
  await cache.expire(key, PRESENCE_TTL_SECONDS);
}

export async function removePresence(
  cache: PresenceCache,
  documentId: string,
  socketId: string,
): Promise<void> {
  await cache.hDel(presenceKey(documentId), socketId);
}

/** Bump the TTL without changing presence — called on edit activity. */
export async function touchPresence(cache: PresenceCache, documentId: string): Promise<void> {
  await cache.expire(presenceKey(documentId), PRESENCE_TTL_SECONDS);
}

export async function listPresence(
  cache: PresenceCache,
  documentId: string,
): Promise<PresenceUser[]> {
  const raw = await cache.hGetAll(presenceKey(documentId));
  const users: PresenceUser[] = [];
  for (const value of Object.values(raw)) {
    try {
      users.push(JSON.parse(value) as PresenceUser);
    } catch {
      // A corrupt presence entry must never wedge a join — skip it.
    }
  }
  return users;
}
