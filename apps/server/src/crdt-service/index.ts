/**
 * crdt-service — the layer that wires the pure `@sync-flow/crdt` core to Postgres +
 * Redis. Load hydrated documents, persist ops (batched), snapshot on policy. The
 * CRDT package stays framework-/DB-free; all persistence lives here.
 */

export { DocumentStore } from "./document-store.js";
export type { DocumentStoreDeps, DocumentStoreLogger } from "./document-store.js";

export { hydrateDocument } from "./hydrate.js";
export type { HydrateDeps, HydratedDocument } from "./hydrate.js";

export {
  appendOperations,
  getOperationsAfter,
  type PersistedOp,
  type PendingOp,
  type ReplayOp,
} from "./op-log.repo.js";

export {
  getLatestSnapshot,
  getReplayFloor,
  writeSnapshot,
  type StoredSnapshot,
} from "./snapshot.repo.js";

export { OpWriter, type OpWriterOptions, type PersistFn } from "./op-writer.js";

export { SnapshotPolicy, type SnapshotPolicyOptions } from "./snapshot-policy.js";

export {
  readCachedState,
  writeCachedState,
  invalidateCachedState,
  STATE_CACHE_TTL_SECONDS,
  type CrdtStateCache,
} from "./cache.js";

export { opToRowValues, rowToOp } from "./row-mapping.js";
export type { OperationRow, OperationRowValues } from "./row-mapping.js";
