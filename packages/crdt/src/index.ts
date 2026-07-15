/**
 * @sync-flow/crdt — framework-free RGA CRDT. The single source of CRDT truth for
 * both the server and the web client (no forks). No pg/redis/express/socket/React
 * imports anywhere in this package.
 */

export {
  type CharId,
  ROOT,
  isRoot,
  encodeId,
  decodeId,
  compareId,
  idsEqual,
  LamportClock,
} from "./id.js";

export {
  RGADocument,
  type DocumentIdentity,
  type DocumentSnapshot,
  type SnapshotChar,
  type SnapshotFormatEntry,
  type VisibleChar,
  type IntegrateResult,
  SNAPSHOT_VERSION,
} from "./document.js";

export {
  type Op,
  type InsertOp,
  type DeleteOp,
  type ReviveOp,
  type FormatOp,
  type LocalInsertOptions,
  OP_VERSION,
  localInsert,
  localDelete,
  localFormat,
  applyRemote,
} from "./operations.js";

export { type ReconcileOptions, reconcileToText } from "./reconcile.js";

export {
  type Cursor,
  visibleIdAt,
  insertAnchorAt,
  idToIndex,
  cursorFromIndex,
  cursorToIndex,
  rebaseIndexThroughInsert,
  rebaseIndexThroughDelete,
} from "./transform.js";
