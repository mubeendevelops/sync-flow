/**
 * The RGA document: an anchor-ordered sequence of characters with tombstone
 * deletes. See `id.ts` for the ordering rule — the short version is that order
 * is defined by "insert after an anchor", with `(clock, replicaId)` breaking
 * ties between characters that share an anchor.
 *
 * Structure:
 *   - A doubly-linked list of nodes in document order, fronted by a frozen ROOT
 *     head sentinel so every real node has a non-null `prev` (no null-checks in
 *     the insert hot path).
 *   - `byId`: encoded-id -> node, giving O(1) anchor lookup and O(1) duplicate
 *     detection (idempotency).
 *   - `tail`: the last node in list order, so appending at the end is O(1).
 *   - Two pending buffers so an op that arrives before its causal dependency is
 *     *held, not dropped*: inserts waiting on a not-yet-seen anchor, and deletes
 *     waiting on a not-yet-seen target. This is what makes `applyRemote`
 *     commutative under arbitrary delivery order.
 *
 * KEY STRUCTURAL INVARIANT that makes the linear insert scan correct: a child's
 * Lamport clock is always strictly greater than its anchor's. A replica can only
 * anchor to a node it has already integrated, and integrating that anchor pushed
 * the local clock past it (`receive` = max+1); buffering guarantees we never
 * integrate a node before its anchor. So `child.id > anchor.id` always, which
 * means skipping "greater-id siblings" during insertion also skips their entire
 * subtrees — no tree walk needed, a flat forward scan suffices.
 */

import { type CharId, ROOT, encodeId, decodeId, compareId, isRoot, LamportClock } from "./id.js";
import type { InsertOp, DeleteOp } from "./operations.js";

interface Node {
  readonly id: CharId;
  readonly char: string;
  deleted: boolean;
  readonly authorId: string;
  /** Wall-clock authorship time — METADATA ONLY, never used for ordering (invariant #5). */
  readonly timestamp: number;
  readonly afterId: CharId;
  prev: Node | null;
  next: Node | null;
}

export type IntegrateResult = "applied" | "duplicate" | "buffered" | "noop";

export interface VisibleChar {
  readonly id: CharId;
  readonly char: string;
  readonly authorId: string;
}

export interface SnapshotChar {
  readonly id: string;
  readonly char: string;
  readonly deleted: boolean;
  readonly authorId: string;
  readonly timestamp: number;
  readonly after: string;
}

export interface DocumentSnapshot {
  /** Op/format version, so the snapshot shape can evolve without silent misreads. */
  readonly v: number;
  /** The Lamport value at snapshot time, so a rehydrated replica keeps advancing correctly. */
  readonly clock: number;
  readonly chars: SnapshotChar[];
}

export const SNAPSHOT_VERSION = 1;

export interface DocumentIdentity {
  /** Per-tab replica id used to mint new char ids. */
  readonly replicaId: string;
  /** Per-user author id stamped on locally-created chars (metadata). */
  readonly authorId: string;
}

export class RGADocument {
  readonly replicaId: string;
  readonly authorId: string;
  readonly clock: LamportClock;

  private readonly head: Node;
  private tail: Node;
  private readonly byId = new Map<string, Node>();
  private readonly pendingInserts = new Map<string, InsertOp[]>();
  private readonly pendingDeletes = new Map<string, DeleteOp[]>();
  private visibleCount = 0;

  constructor(identity: DocumentIdentity) {
    this.replicaId = identity.replicaId;
    this.authorId = identity.authorId;
    this.clock = new LamportClock();

    // ROOT head sentinel: never visible, never deleted-countable, always present.
    this.head = {
      id: ROOT,
      char: "",
      deleted: true,
      authorId: "ROOT",
      timestamp: 0,
      afterId: ROOT,
      prev: null,
      next: null,
    };
    this.tail = this.head;
    this.byId.set(encodeId(ROOT), this.head);
  }

  /** Number of visible (non-tombstoned) characters. */
  get length(): number {
    return this.visibleCount;
  }

  has(id: CharId): boolean {
    return this.byId.has(encodeId(id));
  }

  /** The id of the last node in document order (visible or tombstoned) — the anchor for an append. */
  get tailId(): CharId {
    return this.tail.id;
  }

  /**
   * Integrate an insert. Idempotent (a duplicate id is a no-op) and
   * order-independent (position is a pure function of `afterId` + id). Returns
   * `"buffered"` if the anchor hasn't been seen yet — the op is retried
   * automatically once the anchor arrives.
   */
  integrateInsert(op: InsertOp): IntegrateResult {
    const key = encodeId(op.charId);
    if (this.byId.has(key)) return "duplicate";

    const anchor = this.byId.get(encodeId(op.afterId));
    if (!anchor) {
      this.buffer(this.pendingInserts, encodeId(op.afterId), op);
      return "buffered";
    }

    // Walk forward past every sibling that outranks the new node. Because a
    // child's id always exceeds its anchor's, "id greater than new node" also
    // covers that sibling's whole subtree, so this flat scan lands exactly at
    // the RGA position without descending any tree.
    let pos = anchor;
    while (pos.next !== null && compareId(pos.next.id, op.charId) > 0) {
      pos = pos.next;
    }

    const node: Node = {
      id: op.charId,
      char: op.value,
      deleted: false,
      authorId: op.authorId,
      timestamp: op.timestamp,
      afterId: op.afterId,
      prev: pos,
      next: pos.next,
    };
    if (pos.next !== null) {
      pos.next.prev = node;
    } else {
      this.tail = node;
    }
    pos.next = node;

    this.byId.set(key, node);
    this.visibleCount += 1;

    this.flushPending(key);
    return "applied";
  }

  /**
   * Integrate a delete as a tombstone. Idempotent (deleting twice is a no-op).
   * If the target char hasn't been seen yet, the delete is buffered until it is,
   * so a delete can safely arrive before its insert.
   */
  integrateDelete(op: DeleteOp): IntegrateResult {
    const key = encodeId(op.charId);
    const node = this.byId.get(key);
    if (!node) {
      this.buffer(this.pendingDeletes, key, op);
      return "buffered";
    }
    if (node.deleted) return "duplicate";

    node.deleted = true;
    this.visibleCount -= 1;
    return "applied";
  }

  /** Materialize the visible text, skipping tombstones. O(n). */
  text(): string {
    let out = "";
    for (let cur = this.head.next; cur !== null; cur = cur.next) {
      if (!cur.deleted) out += cur.char;
    }
    return out;
  }

  /** Visible characters in document order, with their ids (for index/cursor mapping). O(n). */
  visibleChars(): VisibleChar[] {
    const result: VisibleChar[] = [];
    for (let cur = this.head.next; cur !== null; cur = cur.next) {
      if (!cur.deleted) {
        result.push({ id: cur.id, char: cur.char, authorId: cur.authorId });
      }
    }
    return result;
  }

  /**
   * Given a char id (which may itself be a tombstone), return the id of the
   * nearest visible character at or to its left, or `null` if there is none
   * (i.e. the position is the very start of the document). Used to resolve a
   * cursor whose anchor was deleted out from under it. O(n) worst case.
   */
  nearestVisibleLeft(id: CharId): CharId | null {
    if (isRoot(id)) return null;
    const start = this.byId.get(encodeId(id));
    if (!start) return null; // unknown id → treat as start of document
    for (let cur: Node | null = start; cur !== null && cur !== this.head; cur = cur.prev) {
      if (!cur.deleted) return cur.id;
    }
    return null;
  }

  /** Serialize to a JSONB-ready snapshot: chars in document order, tombstones included. O(n). */
  toSnapshot(): DocumentSnapshot {
    const chars: SnapshotChar[] = [];
    for (let cur = this.head.next; cur !== null; cur = cur.next) {
      chars.push({
        id: encodeId(cur.id),
        char: cur.char,
        deleted: cur.deleted,
        authorId: cur.authorId,
        timestamp: cur.timestamp,
        after: encodeId(cur.afterId),
      });
    }
    return { v: SNAPSHOT_VERSION, clock: this.clock.peek(), chars };
  }

  /**
   * Rebuild a document from a snapshot. The snapshot chars are already in
   * document order, so this appends them directly — no re-integration needed —
   * making it O(n). `identity` sets the rehydrated instance's own replica/author
   * (the snapshot captures shared state, not who is opening it).
   */
  static fromSnapshot(snapshot: DocumentSnapshot, identity: DocumentIdentity): RGADocument {
    const doc = new RGADocument(identity);
    for (const entry of snapshot.chars) {
      const node: Node = {
        id: decodeId(entry.id),
        char: entry.char,
        deleted: entry.deleted,
        authorId: entry.authorId,
        timestamp: entry.timestamp,
        afterId: decodeId(entry.after),
        prev: doc.tail,
        next: null,
      };
      doc.tail.next = node;
      doc.tail = node;
      doc.byId.set(entry.id, node);
      if (!entry.deleted) doc.visibleCount += 1;
    }
    doc.clock.restore(snapshot.clock);
    return doc;
  }

  private buffer<T>(store: Map<string, T[]>, key: string, op: T): void {
    const existing = store.get(key);
    if (existing) existing.push(op);
    else store.set(key, [op]);
  }

  /**
   * A node with `key` was just integrated. Retry any inserts that were waiting
   * on it as their anchor, and any deletes that were waiting on it as their
   * target. Retried inserts may in turn unblock further ops, so this cascades.
   */
  private flushPending(key: string): void {
    const waitingInserts = this.pendingInserts.get(key);
    if (waitingInserts) {
      this.pendingInserts.delete(key);
      for (const op of waitingInserts) this.integrateInsert(op);
    }
    const waitingDeletes = this.pendingDeletes.get(key);
    if (waitingDeletes) {
      this.pendingDeletes.delete(key);
      for (const op of waitingDeletes) this.integrateDelete(op);
    }
  }
}
