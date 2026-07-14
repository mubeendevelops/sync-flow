/**
 * Load a document's CRDT state into a hydrated `RGADocument`.
 *
 * Path:
 *   1. Try the Redis hot-state cache. On a hit, rebuild from the cached snapshot.
 *   2. On a miss, read the latest Postgres snapshot (or start empty if none).
 *   3. Either way, replay ops with seq > watermark from Postgres. Replay is the
 *      correctness backstop: even a stale cache (an op landed after it was written)
 *      converges, because `applyRemote` is idempotent + commutative.
 *   4. Refresh the cache with the now-current state so the next load is cheap.
 *
 * The returned `seq` is the highest op version folded into `doc` — the watermark a
 * caller resumes from ("give me ops after seq") and stamps onto future snapshots.
 */

import { RGADocument, applyRemote, type DocumentIdentity, type DocumentSnapshot } from "@sync-flow/crdt";
import type { DbClient } from "../db/types.js";
import { getLatestSnapshot } from "./snapshot.repo.js";
import { getOperationsAfter } from "./op-log.repo.js";
import { readCachedState, writeCachedState, type CrdtStateCache } from "./cache.js";

export interface HydrateDeps {
  readonly db: DbClient;
  readonly cache: CrdtStateCache;
}

export interface HydratedDocument {
  readonly doc: RGADocument;
  /** Highest op version folded into `doc`; resume/replay watermark. */
  readonly seq: number;
}

/** A real (versioned) snapshot vs. the legacy `{chars:[]}` placeholder or absence. */
function isDocumentSnapshot(state: unknown): state is DocumentSnapshot {
  return (
    typeof state === "object" &&
    state !== null &&
    typeof (state as DocumentSnapshot).v === "number" &&
    typeof (state as DocumentSnapshot).clock === "number" &&
    Array.isArray((state as DocumentSnapshot).chars)
  );
}

function baseDocument(state: unknown, identity: DocumentIdentity): RGADocument {
  return isDocumentSnapshot(state)
    ? RGADocument.fromSnapshot(state, identity)
    : new RGADocument(identity);
}

export async function hydrateDocument(
  deps: HydrateDeps,
  documentId: string,
  identity: DocumentIdentity,
): Promise<HydratedDocument> {
  const { db, cache } = deps;

  const cached = await readCachedState(cache, documentId);
  let doc: RGADocument;
  let watermark: number;

  if (cached) {
    doc = baseDocument(cached.state, identity);
    watermark = cached.seq;
  } else {
    const snapshot = await getLatestSnapshot(db, documentId);
    doc = baseDocument(snapshot?.state, identity);
    watermark = snapshot?.seq ?? 0;
  }

  // Replay the tail, advancing the watermark to the last row's seq (seq is a global
  // BIGSERIAL with per-document gaps, so it's the max seq, never watermark + count).
  const tail = await getOperationsAfter(db, documentId, watermark);
  let seq = watermark;
  for (const { seq: opSeq, op } of tail) {
    applyRemote(doc, op);
    seq = opSeq;
  }

  // Refresh the cache to the current state so subsequent loads skip most of the replay.
  await writeCachedState(cache, documentId, seq, doc.toSnapshot());

  return { doc, seq };
}
