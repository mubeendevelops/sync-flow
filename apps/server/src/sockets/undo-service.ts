/**
 * Turn a popped undo/redo entry into the forward CRDT ops that carry it out, applying
 * them to the live `DocumentStore.doc` and persisting them. The inverse of any edit is
 * a visibility toggle of the SAME char ids (never a re-insert), so both directions emit
 * only `delete` / `revive` ops:
 *
 *   direction   original insert        original delete
 *   ---------   --------------------   --------------------
 *   undo        delete (hide)          revive (show)
 *   redo        revive (show)          delete (hide)
 *
 * Ops are minted with the doc's own Lamport clock (`tick()` → a stamp that outranks the
 * char's current visibility stamp, so the undo/redo always wins its LWW race) and a
 * fresh UUID replica (satisfies `document_operations.replica_id` + globally unique),
 * attributed to the acting user. Undo replays the entry's ops in reverse so a
 * multi-op edit unwinds tail-first; redo replays them forward.
 */

import { randomUUID } from "node:crypto";
import { decodeId, OP_VERSION, type DeleteOp, type ReviveOp, type Op } from "@sync-flow/crdt";
import type { DocumentStore } from "../crdt-service/index.js";
import type { UndoEntry } from "./undo-stack.js";

export type UndoDirection = "undo" | "redo";

export function applyUndoEntry(
  store: DocumentStore,
  entry: UndoEntry,
  direction: UndoDirection,
  userId: string,
): Op[] {
  const records = direction === "undo" ? [...entry.ops].reverse() : entry.ops;
  const ops: Op[] = [];

  for (const rec of records) {
    const charId = decodeId(rec.charId);
    const clock = store.doc.clock.tick();
    const replicaId = randomUUID();
    // Show the char when undoing a delete or redoing an insert; hide it otherwise.
    const makeVisible = direction === "undo" ? rec.type === "delete" : rec.type === "insert";

    if (makeVisible) {
      const op: ReviveOp = { type: "revive", charId, clock, replicaId, opVersion: OP_VERSION };
      store.doc.integrateRevive(op);
      store.persist(op, userId);
      ops.push(op);
    } else {
      const op: DeleteOp = { type: "delete", charId, clock, replicaId, opVersion: OP_VERSION };
      store.doc.integrateDelete(op);
      store.persist(op, userId);
      ops.push(op);
    }
  }

  return ops;
}
