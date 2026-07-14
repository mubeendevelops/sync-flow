/**
 * The CRDT seam: the one interface TipTap and `packages/crdt` talk through. Prompt 19 wires
 * `apps/web` to `@sync-flow/crdt` and the WebSocket connection and implements this for real
 * (diffing TipTap transactions into ops, applying remote ops back into the editor, cursor
 * stability via transform.ts's ID-to-index remapping). Until then this is a stub that only
 * logs — it exists so the editor's call sites compile against their final shape now and don't
 * need to change when Prompt 19 lands.
 *
 * Field shape mirrors the wire format in CLAUDE.md:
 * `{ type, charId, afterId?, value?, replicaId, clock, docId, opVersion }`.
 */
export interface LocalOp {
  readonly type: "insert" | "delete";
  readonly charId: string;
  readonly afterId?: string;
  readonly value?: string;
  readonly replicaId: string;
  readonly clock: number;
  readonly docId: string;
  readonly opVersion: number;
}

export type RemoteOp = LocalOp;

export interface CursorIds {
  readonly anchorId: string;
  readonly headId: string;
}

export type CRDTBridge = {
  /** TipTap -> CRDT: called with the ops minted from a local edit. */
  onLocalChange: (ops: LocalOp[]) => void;
  /** CRDT -> TipTap: called to apply ops that arrived from another replica. */
  applyRemoteOps: (ops: RemoteOp[]) => void;
  /** Current selection expressed as CRDT char ids, so it survives remote edits re-indexing the doc. */
  getCursorIds: () => CursorIds | null;
  /** Restore a selection from CRDT char ids after applying remote ops. */
  applyCursorFromIds: (anchorId: string, headId: string) => void;
};

/** Stub implementation — every method just logs. Replaced in Prompt 19. */
export function createStubCrdtBridge(): CRDTBridge {
  return {
    onLocalChange(ops) {
      console.log("[crdt-bridge] onLocalChange (stub)", ops);
    },
    applyRemoteOps(ops) {
      console.log("[crdt-bridge] applyRemoteOps (stub)", ops);
    },
    getCursorIds() {
      return null;
    },
    applyCursorFromIds(anchorId, headId) {
      console.log("[crdt-bridge] applyCursorFromIds (stub)", { anchorId, headId });
    },
  };
}
