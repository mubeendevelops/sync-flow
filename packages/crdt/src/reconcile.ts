/**
 * reconcileToText — express "make this document read exactly `target`" as a set of
 * ordinary forward RGA ops (inserts + tombstone deletes), applied to `doc` and
 * returned for broadcast/persistence. This is the CRDT primitive behind version
 * *restore*: a restore is not a state overwrite, it's a diff replayed as normal ops.
 *
 * WHY THIS IS THE RIGHT SHAPE FOR RESTORE:
 *   - History stays append-only — nothing is mutated or removed, we only append new
 *     ops (deletes are tombstones, invariant #3).
 *   - The restore is itself undoable — to undo, reconcile back to the previous text,
 *     which produces another forward diff.
 *   - Live clients converge normally — the output is nothing but `insert`/`delete`
 *     ops, so a peer integrates them exactly like keystrokes and RGA convergence
 *     (invariant #1) does the rest, including merging edits made *concurrently* with
 *     the restore (their chars anchor to characters this diff keeps or tombstones —
 *     a tombstone is a valid anchor — so they survive).
 *
 * MINTING IDENTITY: ops are minted with the caller-supplied `identity` (a fresh,
 * restore-specific replica id — NOT `doc`'s own identity), advancing `doc`'s shared
 * Lamport clock via `tick()`. A fresh replica id keeps the new char ids globally
 * unique (invariant #2) and, because `tick()` returns a clock strictly greater than
 * every char the doc has integrated, every new char outranks its anchor — the
 * structural invariant the linear insert scan relies on (see `document.ts`).
 *
 * ATOMICITY: this function performs NO async work. It reads `doc.visibleChars()` and
 * applies every op synchronously, so against a single-threaded runtime it is atomic
 * with respect to any concurrent edit handler — the two can never interleave
 * mid-mutation. Ops that arrive after it returns are integrated afterwards as usual.
 *
 * DIFF: a longest-common-subsequence diff over the visible characters, with the
 * common prefix and suffix trimmed first so a localized restore stays cheap. The
 * trimmed middle is an O(n·m) DP; for plaintext v1 that is acceptable, and the
 * prefix/suffix trim makes the typical "changed one paragraph" restore near-linear.
 * (Hunt–Szymanski / Myers would drop the worst case; deferred.) Minimality is a
 * nicety, never a correctness requirement — any op set that yields `target` converges
 * — but an LCS diff keeps unchanged runs untouched, which best preserves concurrent
 * edits and produces the smallest broadcast.
 */

import { type CharId, ROOT } from "./id.js";
import type { RGADocument, DocumentIdentity, VisibleChar } from "./document.js";
import { type Op, type InsertOp, type DeleteOp, OP_VERSION } from "./operations.js";

export interface ReconcileOptions {
  /** Override the wall-clock timestamp stamped on minted inserts (metadata; tests use it). */
  readonly timestamp?: number;
}

/** One aligned diff step against the captured visible sequence / target code points. */
type Step =
  | { readonly kind: "keep"; readonly ci: number }
  | { readonly kind: "del"; readonly ci: number }
  | { readonly kind: "ins"; readonly ti: number };

/**
 * Diff `current` (captured visible chars) against `target` (target code points),
 * returning an ordered edit script of keep/del/ins steps. Common prefix and suffix
 * are trimmed first; the middle is aligned by LCS.
 */
function diffScript(current: readonly VisibleChar[], target: readonly string[]): Step[] {
  const n = current.length;
  const m = target.length;

  let lo = 0;
  while (lo < n && lo < m && current[lo]!.char === target[lo]!) lo += 1;

  let hiC = n;
  let hiT = m;
  while (hiC > lo && hiT > lo && current[hiC - 1]!.char === target[hiT - 1]!) {
    hiC -= 1;
    hiT -= 1;
  }

  const steps: Step[] = [];
  for (let i = 0; i < lo; i += 1) steps.push({ kind: "keep", ci: i });

  const la = hiC - lo;
  const lb = hiT - lo;

  if (la === 0) {
    // Pure insertion in the middle.
    for (let j = lo; j < hiT; j += 1) steps.push({ kind: "ins", ti: j });
  } else if (lb === 0) {
    // Pure deletion in the middle.
    for (let i = lo; i < hiC; i += 1) steps.push({ kind: "del", ci: i });
  } else {
    // LCS DP over the differing middle. dp[i*(lb+1)+j] = LCS length of
    // current[lo+i .. hiC) and target[lo+j .. hiT).
    const width = lb + 1;
    const dp = new Int32Array((la + 1) * width);
    for (let i = la - 1; i >= 0; i -= 1) {
      for (let j = lb - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          current[lo + i]!.char === target[lo + j]!
            ? dp[(i + 1) * width + (j + 1)]! + 1
            : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
      }
    }
    // Forward backtrack keeps the script in document order.
    let i = 0;
    let j = 0;
    while (i < la && j < lb) {
      if (current[lo + i]!.char === target[lo + j]!) {
        steps.push({ kind: "keep", ci: lo + i });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
        steps.push({ kind: "del", ci: lo + i });
        i += 1;
      } else {
        steps.push({ kind: "ins", ti: lo + j });
        j += 1;
      }
    }
    for (; i < la; i += 1) steps.push({ kind: "del", ci: lo + i });
    for (; j < lb; j += 1) steps.push({ kind: "ins", ti: lo + j });
  }

  for (let i = hiC; i < n; i += 1) steps.push({ kind: "keep", ci: i });
  return steps;
}

/**
 * Transform `doc` so its visible text equals `target`, applying the minted ops to
 * `doc` and returning them (in the order applied) for broadcast + persistence.
 * Returns `[]` when `doc` already reads `target` (a no-op restore).
 */
export function reconcileToText(
  doc: RGADocument,
  target: string,
  identity: DocumentIdentity,
  options: ReconcileOptions = {},
): Op[] {
  const current = doc.visibleChars();
  const targetChars = [...target]; // split by code point, matching one-char-per-op inserts
  const script = diffScript(current, targetChars);

  const ops: Op[] = [];
  // The id the next insert should anchor after: the visible char to its left, or
  // ROOT at the document start. Advances past kept AND tombstoned chars so inserts
  // land in the right place relative to a just-deleted region.
  let anchor: CharId = ROOT;

  for (const step of script) {
    if (step.kind === "keep") {
      anchor = current[step.ci]!.id;
      continue;
    }
    if (step.kind === "del") {
      const node = current[step.ci]!;
      const op: DeleteOp = {
        type: "delete",
        charId: node.id,
        clock: doc.clock.tick(),
        replicaId: identity.replicaId,
        opVersion: OP_VERSION,
      };
      doc.integrateDelete(op);
      ops.push(op);
      anchor = node.id;
      continue;
    }
    const value = targetChars[step.ti]!;
    const clock = doc.clock.tick();
    const op: InsertOp = {
      type: "insert",
      charId: { clock, replicaId: identity.replicaId },
      afterId: anchor,
      value,
      authorId: identity.authorId,
      timestamp: options.timestamp ?? Date.now(),
      opVersion: OP_VERSION,
    };
    doc.integrateInsert(op);
    ops.push(op);
    anchor = op.charId;
  }

  return ops;
}
