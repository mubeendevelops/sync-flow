/**
 * Character identifiers and the ordering rule for the RGA CRDT.
 *
 * ============================================================================
 * THE ORDERING RULE (read this before touching anything below)
 * ============================================================================
 * Document order in an RGA is NOT a flat global sort of every character by its
 * id. It is an *anchor-based* order: every character is inserted immediately
 * after an existing character (its "anchor", `afterId`). Position 0 anchors to
 * the fixed `ROOT` sentinel.
 *
 * `(clock, replicaId)` — the `CharId` — is therefore used for exactly two
 * things, and NEITHER of them is "sort the whole document by id":
 *
 *   1. Identity. A char id is globally unique and never reused, so applying a
 *      duplicate op is a no-op (idempotency) and an anchor can be looked up in
 *      O(1).
 *   2. The *sibling tiebreak*. When several characters share the same anchor
 *      (concurrent inserts at the same spot), they are ordered among themselves
 *      by `(clock, replicaId)`, with the GREATER id placed nearer the anchor.
 *
 * CLAUDE.md invariant #4 says "the deterministic total order is
 * `(clock, replicaId)`". That phrasing describes the *sibling tiebreak*, not a
 * document-wide sort key. Implementing it as a global sort would reinterleave
 * concurrent runs — the exact anomaly the golden tests exist to catch — because
 * each character of a typed run anchors to the *previous character of that run*,
 * which is what keeps two concurrent runs contiguous instead of interleaved.
 *
 * "Greater id nearer the anchor" means a later concurrent insert (higher Lamport
 * clock) appears first after the anchor, which matches the intuition "insert
 * after X puts the new char directly after X".
 *
 * Lamport clock: advances by `+1` on every local op and to `max(local, remote)
 * + 1` on receive. It is NEVER derived from wall-clock time (invariant #5).
 * ============================================================================
 */

/** Globally unique character identifier: a Lamport clock paired with the minting replica. */
export interface CharId {
  readonly clock: number;
  readonly replicaId: string;
}

/**
 * Sentinel anchor for inserts at the very start of the document. Every real
 * character transitively descends from ROOT. Its clock is 0 and no real op ever
 * mints clock 0 (local ops start at 1), so ROOT can never collide with a real id
 * and always sorts strictly before every real id.
 */
export const ROOT: CharId = Object.freeze({ clock: 0, replicaId: "ROOT" });

export function isRoot(id: CharId): boolean {
  return id.clock === ROOT.clock && id.replicaId === ROOT.replicaId;
}

/** Encode a `CharId` as `"<clock>@<replicaId>"` for use as a Map key and on the wire. */
export function encodeId(id: CharId): string {
  return `${id.clock}@${id.replicaId}`;
}

/** Inverse of {@link encodeId}. Throws on malformed input rather than returning a bad id. */
export function decodeId(encoded: string): CharId {
  const at = encoded.indexOf("@");
  if (at <= 0 || at === encoded.length - 1) {
    throw new Error(`Malformed CharId: "${encoded}"`);
  }
  const clock = Number(encoded.slice(0, at));
  if (!Number.isInteger(clock) || clock < 0) {
    throw new Error(`Malformed CharId clock: "${encoded}"`);
  }
  return { clock, replicaId: encoded.slice(at + 1) };
}

/**
 * Total order on `CharId`, primarily by `clock`, breaking ties by `replicaId`.
 * Returns <0 if `a` sorts before `b`, >0 if after, 0 iff the ids are equal.
 *
 * This is a *total* order (any two ids are comparable, antisymmetric,
 * transitive), which is what makes the sibling tiebreak deterministic across all
 * replicas regardless of the order ops arrive in.
 */
export function compareId(a: CharId, b: CharId): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.replicaId < b.replicaId) return -1;
  if (a.replicaId > b.replicaId) return 1;
  return 0;
}

export function idsEqual(a: CharId, b: CharId): boolean {
  return a.clock === b.clock && a.replicaId === b.replicaId;
}

/**
 * A per-replica Lamport clock. Local ops call {@link tick}; every received op's
 * clock is fed to {@link receive} so this replica's clock always stays ahead of
 * anything it has seen. The clock only ever moves forward.
 */
export class LamportClock {
  private value: number;

  constructor(initial = 0) {
    this.value = initial;
  }

  /** Current value without advancing — useful for snapshots. */
  peek(): number {
    return this.value;
  }

  /** Advance for a new local operation and return the new value. */
  tick(): number {
    this.value += 1;
    return this.value;
  }

  /** Integrate a remote clock: move to `max(local, remote) + 1`. */
  receive(remoteClock: number): number {
    this.value = Math.max(this.value, remoteClock) + 1;
    return this.value;
  }

  /**
   * Set the clock to an exact value. For snapshot rehydration ONLY — a snapshot
   * records the Lamport value it was taken at, and a replica loading it must
   * resume from exactly there. Not part of the normal advance-only path.
   */
  restore(value: number): void {
    this.value = value;
  }
}
