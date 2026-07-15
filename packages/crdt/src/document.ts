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
import type { InsertOp, DeleteOp, ReviveOp, FormatOp } from "./operations.js";

/** One formatting attribute's current LWW state: its value and the stamp that set it. */
interface FormatEntry {
  readonly value: string | boolean | null;
  readonly stamp: CharId;
}

interface Node {
  readonly id: CharId;
  readonly char: string;
  deleted: boolean;
  /**
   * LWW visibility stamp: the `(clock, replicaId)` of the op that currently decides
   * this char's visibility. Baseline is the char's own id (set on insert = visible);
   * a delete/revive replaces it only if it outranks the current stamp (`compareId`),
   * so visibility is a last-writer-wins register — commutative, idempotent, convergent.
   */
  visStamp: CharId;
  readonly authorId: string;
  /** Wall-clock authorship time — METADATA ONLY, never used for ordering (invariant #5). */
  readonly timestamp: number;
  readonly afterId: CharId;
  prev: Node | null;
  next: Node | null;
  /** Per-attribute LWW registers (formatting), keyed by attribute name. Lazy — most chars carry no formatting. */
  formats: Map<string, FormatEntry> | null;
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
  /**
   * Encoded LWW visibility stamp (see `Node.visStamp`). Added in snapshot v2 for
   * delete/revive convergence; optional so a v1 snapshot (no revives ever existed
   * then) still loads — it defaults to the char's own id, which any later
   * delete/revive outranks, so resolution stays correct.
   */
  readonly visId?: string;
  /**
   * Encoded per-attribute LWW formatting state, added in snapshot v3. Optional so a v1/v2
   * snapshot (no format ops ever existed then) still loads — chars simply default to no
   * formatting, which any later format op naturally outranks.
   */
  readonly formats?: SnapshotFormatEntry[];
}

export interface SnapshotFormatEntry {
  readonly key: string;
  readonly value: string | boolean | null;
  /** Encoded LWW stamp (`FormatEntry.stamp`). */
  readonly stampId: string;
}

export interface DocumentSnapshot {
  /** Op/format version, so the snapshot shape can evolve without silent misreads. */
  readonly v: number;
  /** The Lamport value at snapshot time, so a rehydrated replica keeps advancing correctly. */
  readonly clock: number;
  readonly chars: SnapshotChar[];
}

/** v3 adds per-char, per-attribute LWW formatting state (`SnapshotChar.formats`). */
export const SNAPSHOT_VERSION = 3;

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
  private readonly pendingRevives = new Map<string, ReviveOp[]>();
  private readonly pendingFormats = new Map<string, FormatOp[]>();
  private visibleCount = 0;

  constructor(identity: DocumentIdentity) {
    this.replicaId = identity.replicaId;
    this.authorId = identity.authorId;
    this.clock = new LamportClock();

    // ROOT head sentinel: never visible, never deleted-countable, always present. It IS a
    // valid format-op target — block 0 (no preceding block-boundary char) anchors its
    // block-level attributes here.
    this.head = {
      id: ROOT,
      char: "",
      deleted: true,
      visStamp: ROOT,
      authorId: "ROOT",
      timestamp: 0,
      afterId: ROOT,
      prev: null,
      next: null,
      formats: null,
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
      // Baseline visibility stamp = the char's own id; any later delete/revive (whose
      // clock strictly exceeds this char's) outranks it.
      visStamp: op.charId,
      authorId: op.authorId,
      timestamp: op.timestamp,
      afterId: op.afterId,
      prev: pos,
      next: pos.next,
      formats: null,
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
   * Integrate a delete as a tombstone. Deletes and revives are a last-writer-wins
   * register on `(clock, replicaId)`: this delete hides the char only if its stamp
   * outranks the char's current visibility stamp, otherwise it's a stale/duplicate
   * no-op. Idempotent (the same delete re-applied has an equal stamp → no change) and
   * commutative (final visibility is the highest stamp regardless of arrival order).
   * If the target char hasn't been seen yet, the delete is buffered until it is, so a
   * delete can safely arrive before its insert.
   */
  integrateDelete(op: DeleteOp): IntegrateResult {
    if (isRoot(op.charId)) return "noop";
    const key = encodeId(op.charId);
    const node = this.byId.get(key);
    if (!node) {
      this.buffer(this.pendingDeletes, key, op);
      return "buffered";
    }
    const stamp: CharId = { clock: op.clock, replicaId: op.replicaId };
    if (compareId(stamp, node.visStamp) <= 0) return "duplicate"; // stale or exact dup — LWW loser

    if (!node.deleted) this.visibleCount -= 1;
    node.deleted = true;
    node.visStamp = stamp;
    return "applied";
  }

  /**
   * Integrate a revive (undo of a delete): make the char visible again by the same
   * LWW rule — it wins only if its `(clock, replicaId)` outranks the current stamp.
   * A revive minted to undo a delete always outranks that delete (it's created after
   * seeing it). Idempotent + commutative like `integrateDelete`, and buffered if the
   * target char hasn't arrived yet.
   */
  integrateRevive(op: ReviveOp): IntegrateResult {
    if (isRoot(op.charId)) return "noop";
    const key = encodeId(op.charId);
    const node = this.byId.get(key);
    if (!node) {
      this.buffer(this.pendingRevives, key, op);
      return "buffered";
    }
    const stamp: CharId = { clock: op.clock, replicaId: op.replicaId };
    if (compareId(stamp, node.visStamp) <= 0) return "duplicate";

    if (node.deleted) this.visibleCount += 1;
    node.deleted = false;
    node.visStamp = stamp;
    return "applied";
  }

  /**
   * Integrate a format-attribute set/clear as an LWW register on `(charId, key)`: it wins
   * only if its `(clock, replicaId)` stamp outranks the current stamp for that key,
   * otherwise it's a stale/duplicate no-op. Idempotent + commutative like delete/revive.
   * A target char that's tombstoned can still carry formatting (its visibility and its
   * attributes are independent registers) — buffered if the target hasn't arrived yet, same
   * as delete/revive, so a format op can safely arrive before its target's insert.
   */
  integrateFormat(op: FormatOp): IntegrateResult {
    const key = encodeId(op.charId);
    const node = this.byId.get(key);
    if (!node) {
      this.buffer(this.pendingFormats, key, op);
      return "buffered";
    }
    const stamp: CharId = { clock: op.clock, replicaId: op.replicaId };
    const formats = node.formats ?? (node.formats = new Map());
    const existing = formats.get(op.key);
    if (existing && compareId(stamp, existing.stamp) <= 0) return "duplicate";

    formats.set(op.key, { value: op.value, stamp });
    return "applied";
  }

  /** Current value of format attribute `key` on char `id`, or `null` if never set. */
  getFormat(id: CharId, key: string): string | boolean | null {
    const node = this.byId.get(encodeId(id));
    const entry = node?.formats?.get(key);
    return entry ? entry.value : null;
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
    // ROOT is never walked (the loop starts at head.next), but it can carry block-0
    // formatting — represented as a synthetic leading chars[] entry so fromSnapshot can
    // restore it onto the rebuilt head sentinel without a special-cased wire shape.
    const rootFormats = this.encodeFormats(this.head);
    if (rootFormats) {
      chars.push({
        id: encodeId(ROOT),
        char: "",
        deleted: true,
        authorId: "ROOT",
        timestamp: 0,
        after: encodeId(ROOT),
        visId: encodeId(ROOT),
        formats: rootFormats,
      });
    }
    for (let cur = this.head.next; cur !== null; cur = cur.next) {
      chars.push({
        id: encodeId(cur.id),
        char: cur.char,
        deleted: cur.deleted,
        authorId: cur.authorId,
        timestamp: cur.timestamp,
        after: encodeId(cur.afterId),
        visId: encodeId(cur.visStamp),
        formats: this.encodeFormats(cur) ?? undefined,
      });
    }
    return { v: SNAPSHOT_VERSION, clock: this.clock.peek(), chars };
  }

  private encodeFormats(node: Node): SnapshotFormatEntry[] | null {
    if (!node.formats || node.formats.size === 0) return null;
    const out: SnapshotFormatEntry[] = [];
    for (const [key, entry] of node.formats) {
      out.push({ key, value: entry.value, stampId: encodeId(entry.stamp) });
    }
    return out;
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
      // ROOT never gets its own linked-list node (the constructor already made `doc.head`) —
      // a v3 snapshot may carry a synthetic ROOT entry solely to transport block-0 formatting.
      if (isRoot(decodeId(entry.id))) {
        doc.applyFormats(doc.head, entry.formats);
        continue;
      }
      const node: Node = {
        id: decodeId(entry.id),
        char: entry.char,
        deleted: entry.deleted,
        // v2 carries the visibility stamp; a v1 snapshot defaults it to the char's own id.
        visStamp: entry.visId ? decodeId(entry.visId) : decodeId(entry.id),
        authorId: entry.authorId,
        timestamp: entry.timestamp,
        afterId: decodeId(entry.after),
        prev: doc.tail,
        next: null,
        formats: null,
      };
      doc.applyFormats(node, entry.formats);
      doc.tail.next = node;
      doc.tail = node;
      doc.byId.set(entry.id, node);
      if (!entry.deleted) doc.visibleCount += 1;
    }
    doc.clock.restore(snapshot.clock);
    return doc;
  }

  private applyFormats(node: Node, formats: SnapshotFormatEntry[] | undefined): void {
    if (!formats || formats.length === 0) return;
    const map = node.formats ?? (node.formats = new Map());
    for (const f of formats) map.set(f.key, { value: f.value, stamp: decodeId(f.stampId) });
  }

  private buffer<T>(store: Map<string, T[]>, key: string, op: T): void {
    const existing = store.get(key);
    if (existing) existing.push(op);
    else store.set(key, [op]);
  }

  /**
   * A node with `key` was just integrated. Retry any inserts that were waiting
   * on it as their anchor, and any deletes/revives/formats that were waiting on it as
   * their target. Retried inserts may in turn unblock further ops, so this cascades.
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
    const waitingRevives = this.pendingRevives.get(key);
    if (waitingRevives) {
      this.pendingRevives.delete(key);
      for (const op of waitingRevives) this.integrateRevive(op);
    }
    const waitingFormats = this.pendingFormats.get(key);
    if (waitingFormats) {
      this.pendingFormats.delete(key);
      for (const op of waitingFormats) this.integrateFormat(op);
    }
  }
}
