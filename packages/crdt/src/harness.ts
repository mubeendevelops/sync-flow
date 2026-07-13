/**
 * Test-only utilities (not part of the public API — `index.ts` does not re-export
 * this). Kept in `src/` so it is typechecked under the same `strict` settings as
 * the library it exercises.
 */

import { RGADocument, type DocumentIdentity } from "./document.js";
import { applyRemote, type Op } from "./operations.js";

export function makeDoc(replicaId: string, authorId = `user-${replicaId}`): RGADocument {
  const identity: DocumentIdentity = { replicaId, authorId };
  return new RGADocument(identity);
}

/** Deliver a batch of ops to a doc in the given order via `applyRemote`. */
export function applyAll(doc: RGADocument, ops: readonly Op[]): RGADocument {
  for (const op of ops) applyRemote(doc, op);
  return doc;
}

/** All permutations of `items` (n! — keep n small; caller is responsible). */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i]!;
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) {
      perm.unshift(head);
      result.push(perm);
    }
  }
  return result;
}

/** Deterministic Fisher–Yates shuffle seeded by `seed` (mulberry32), for reproducible fuzz. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = items.slice();
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = arr[i]!;
    const b = arr[j]!;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}
