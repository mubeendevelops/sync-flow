/**
 * Per-user, per-document undo/redo stacks in Redis (collaborative undo: Ctrl+Z
 * affects only the current user's own operations, never anyone else's).
 *
 *   undo:{docId}:{userId}   redo:{docId}:{userId}   — Redis lists, newest at the head.
 *
 * An entry is the invertible record of ONE edit event (one `edit` batch = one undo
 * unit): the ordered `{ type, charId }` of each op that actually changed state. That's
 * all undo/redo needs, because the inverse of any edit is a visibility toggle of the
 * SAME char ids:
 *   - undo an insert → delete (tombstone) those ids      · redo → revive them
 *   - undo a delete  → revive those ids                  · redo → delete them again
 * Never a re-insert with new ids (that would move the char in RGA order).
 *
 * Lifecycle: each edit pushes an undo entry, trims to depth 100, refreshes the 24h TTL,
 * and CLEARS the redo stack (a new edit invalidates the redo future). Undo pops undo →
 * pushes redo; redo pops redo → pushes undo. Neither undo nor redo clears the redo
 * stack. Redis is not a source of truth here — a lost stack just means "nothing to
 * undo", never a document-integrity problem.
 */

/** One recorded op in an undo entry: the original type + the (encoded) char id it touched. */
export interface UndoOpRecord {
  readonly type: "insert" | "delete";
  /** Encoded CharId ("<clock>@<replicaId>") of the inserted char / deleted target. */
  readonly charId: string;
}

/** One edit event's worth of invertible ops (the unit a single Ctrl+Z acts on). */
export interface UndoEntry {
  readonly ops: UndoOpRecord[];
}

/** Narrow subset of the redis client used for the list-backed stacks. */
export interface UndoStackCache {
  lPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export const UNDO_MAX_DEPTH = 100;
export const UNDO_TTL_SECONDS = 24 * 60 * 60; // 24h after the last edit

const undoKey = (documentId: string, userId: string): string => `undo:${documentId}:${userId}`;
const redoKey = (documentId: string, userId: string): string => `redo:${documentId}:${userId}`;

async function pushCapped(cache: UndoStackCache, key: string, entry: UndoEntry): Promise<void> {
  await cache.lPush(key, JSON.stringify(entry));
  // Keep only the newest UNDO_MAX_DEPTH entries (head = newest), then refresh the TTL.
  await cache.lTrim(key, 0, UNDO_MAX_DEPTH - 1);
  await cache.expire(key, UNDO_TTL_SECONDS);
}

async function popEntry(cache: UndoStackCache, key: string): Promise<UndoEntry | null> {
  const raw = await cache.lPop(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as UndoEntry;
  } catch {
    // A corrupt entry must never wedge undo — treat it as "nothing to undo".
    return null;
  }
}

/**
 * Record one edit event on the undo stack and clear the redo stack. Called after a
 * user's `edit` is applied. A no-op if the edit produced no invertible ops.
 */
export async function recordEdit(
  cache: UndoStackCache,
  documentId: string,
  userId: string,
  entry: UndoEntry,
): Promise<void> {
  await cache.del(redoKey(documentId, userId)); // a new edit invalidates the redo future
  if (entry.ops.length === 0) return;
  await pushCapped(cache, undoKey(documentId, userId), entry);
}

/** Pop the most recent undo entry, or null if the stack is empty. */
export function popUndo(
  cache: UndoStackCache,
  documentId: string,
  userId: string,
): Promise<UndoEntry | null> {
  return popEntry(cache, undoKey(documentId, userId));
}

/** Pop the most recent redo entry, or null if the stack is empty. */
export function popRedo(
  cache: UndoStackCache,
  documentId: string,
  userId: string,
): Promise<UndoEntry | null> {
  return popEntry(cache, redoKey(documentId, userId));
}

/** Push an entry onto the redo stack (after an undo). Does NOT clear undo. */
export function pushRedo(
  cache: UndoStackCache,
  documentId: string,
  userId: string,
  entry: UndoEntry,
): Promise<void> {
  return pushCapped(cache, redoKey(documentId, userId), entry);
}

/** Push an entry back onto the undo stack (after a redo). Does NOT clear redo. */
export function pushUndo(
  cache: UndoStackCache,
  documentId: string,
  userId: string,
  entry: UndoEntry,
): Promise<void> {
  return pushCapped(cache, undoKey(documentId, userId), entry);
}
