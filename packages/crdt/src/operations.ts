/**
 * Operations: the unit of change that crosses the wire and drives the CRDT.
 *
 * `localInsert` / `localDelete` turn a user edit (by linear index) into an op
 * AND apply it locally; the returned op is what you broadcast. `applyRemote`
 * integrates an op that arrived from another replica.
 *
 * `applyRemote` is:
 *   - idempotent — re-applying an op is a no-op (duplicate char id on insert;
 *     already-tombstoned target on delete), so at-least-once delivery is safe;
 *   - commutative — an op's final position is a pure function of its own fields
 *     (`afterId` + char id tiebreak), never of arrival order, and an op that
 *     outruns its causal dependency is buffered until that dependency lands.
 *
 * Wire/DB note: an InsertOp's origin lives in its `charId` (`{clock, replicaId}`
 * is the new char's identity). A DeleteOp's `charId` is the *target* being
 * tombstoned, so it separately carries the deleter's own `clock`/`replicaId` —
 * these map to the `document_operations` columns and keep Lamport causality
 * advancing on deletes too, but they are metadata to the CRDT: only the target
 * `charId` affects convergence.
 */

import { type CharId } from "./id.js";
import type { RGADocument, IntegrateResult } from "./document.js";
import { insertAnchorAt, visibleIdAt } from "./transform.js";

export const OP_VERSION = 1;

export interface InsertOp {
  readonly type: "insert";
  /** Identity of the inserted char: its Lamport clock + minting replica. */
  readonly charId: CharId;
  /** The char this one is inserted immediately after (ROOT for position 0). */
  readonly afterId: CharId;
  /** Exactly one character. */
  readonly value: string;
  /** Authoring user (metadata — never affects ordering). */
  readonly authorId: string;
  /** Wall-clock authoring time (metadata — never affects ordering). */
  readonly timestamp: number;
  readonly opVersion: number;
}

export interface DeleteOp {
  readonly type: "delete";
  /** The char being tombstoned. */
  readonly charId: CharId;
  /**
   * Deleter's Lamport clock. Together with `replicaId` this is the op's LWW visibility
   * stamp: a delete only wins (hides the char) if its `(clock, replicaId)` outranks the
   * char's current visibility stamp. Also drives causality + persistence.
   */
  readonly clock: number;
  /** Deleter's replica (LWW tiebreak + persistence). */
  readonly replicaId: string;
  readonly opVersion: number;
}

/**
 * Un-tombstone a character (undo of a delete). NOT a re-insert: it targets the SAME
 * `charId`, so the char reappears at its original RGA position — re-inserting with a
 * new id would place it elsewhere and break convergence. Deletes and revives resolve
 * as a last-writer-wins register keyed by `(clock, replicaId)`: whichever visibility
 * op has the highest stamp determines whether the char is visible. A revive minted to
 * undo a delete always outranks that delete (it's created after seeing it).
 */
export interface ReviveOp {
  readonly type: "revive";
  /** The char being made visible again. */
  readonly charId: CharId;
  /** Reviver's Lamport clock (LWW visibility stamp + causality + persistence). */
  readonly clock: number;
  /** Reviver's replica (LWW tiebreak + persistence). */
  readonly replicaId: string;
  readonly opVersion: number;
}

/**
 * Set (or clear) one formatting attribute on a char — an inline mark (e.g. `"bold"`) or a
 * block-level attribute (e.g. `"blockType"`) anchored to a block-boundary char. See
 * `apps/web/src/lib/crdt-bridge.ts` for how char/block anchors are chosen; the CRDT itself
 * treats `charId` as an opaque target and doesn't know "inline" from "block-level".
 *
 * Same LWW-register design as delete/revive, generalized to a `(charId, key)` keyed store:
 * a format op wins only if its `(clock, replicaId)` stamp outranks the current stamp for
 * that key, so concurrent formatting of overlapping ranges converges deterministically
 * without needing to merge values. `value: null` clears the attribute (distinct from
 * "never set" only in that it carries its own stamp, so it can outrank a concurrent set).
 */
export interface FormatOp {
  readonly type: "format";
  /** The char (inline mark) or block-anchor char (block attribute) this op targets. */
  readonly charId: CharId;
  /** Attribute name, e.g. `"bold" | "italic" | "code" | "link" | "blockType" | "listType"`. */
  readonly key: string;
  /** New value, or `null` to clear. */
  readonly value: string | boolean | null;
  /** Setter's Lamport clock (LWW stamp + causality + persistence). */
  readonly clock: number;
  /** Setter's replica (LWW tiebreak + persistence). */
  readonly replicaId: string;
  readonly opVersion: number;
}

export type Op = InsertOp | DeleteOp | ReviveOp | FormatOp;

export interface LocalInsertOptions {
  /** Override the wall-clock timestamp (used by tests for determinism). */
  readonly timestamp?: number;
}

/**
 * Produce and locally apply an insert of `char` at visible position `index`.
 * Appending at the end is O(1) (anchors to the cached tail); an interior insert
 * is O(n) to translate the index into an anchor id — see the module perf note.
 */
export function localInsert(
  doc: RGADocument,
  index: number,
  char: string,
  options: LocalInsertOptions = {},
): InsertOp {
  if ([...char].length !== 1) {
    throw new Error(`localInsert expects exactly one character, got ${JSON.stringify(char)}`);
  }
  const afterId = index >= doc.length ? doc.tailId : insertAnchorAt(doc, index);
  const clock = doc.clock.tick();
  const op: InsertOp = {
    type: "insert",
    charId: { clock, replicaId: doc.replicaId },
    afterId,
    value: char,
    authorId: doc.authorId,
    timestamp: options.timestamp ?? Date.now(),
    opVersion: OP_VERSION,
  };
  doc.integrateInsert(op);
  return op;
}

/** Produce and locally apply a delete of the visible char at position `index`. */
export function localDelete(doc: RGADocument, index: number): DeleteOp {
  const charId = visibleIdAt(doc, index);
  const op: DeleteOp = {
    type: "delete",
    charId,
    clock: doc.clock.tick(),
    replicaId: doc.replicaId,
    opVersion: OP_VERSION,
  };
  doc.integrateDelete(op);
  return op;
}

/** Produce and locally apply a format-attribute set/clear on `charId`. */
export function localFormat(
  doc: RGADocument,
  charId: CharId,
  key: string,
  value: string | boolean | null,
): FormatOp {
  const op: FormatOp = {
    type: "format",
    charId,
    key,
    value,
    clock: doc.clock.tick(),
    replicaId: doc.replicaId,
    opVersion: OP_VERSION,
  };
  doc.integrateFormat(op);
  return op;
}

/** Integrate a remote op. Idempotent + commutative; buffers on a missing dependency. */
export function applyRemote(doc: RGADocument, op: Op): IntegrateResult {
  if (op.type === "insert") {
    doc.clock.receive(op.charId.clock);
    return doc.integrateInsert(op);
  }
  if (op.type === "delete") {
    doc.clock.receive(op.clock);
    return doc.integrateDelete(op);
  }
  if (op.type === "revive") {
    doc.clock.receive(op.clock);
    return doc.integrateRevive(op);
  }
  doc.clock.receive(op.clock);
  return doc.integrateFormat(op);
}
