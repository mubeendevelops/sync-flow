/**
 * Cross-instance peer-apply relay (PLAN 2.7 follow-up: horizontal scaling).
 *
 * `@socket.io/redis-adapter` (adapter.ts) already fans out `socket.to(docId).emit(...)`
 * to CONNECTED CLIENTS on every instance — that part of multi-instance was already
 * correct. What it does NOT do is keep each instance's own server-side materialized
 * `DocumentStore.doc` (used to serve `join`/`sync` snapshots and to decide when to
 * write a persisted snapshot) convergent with ops that landed on a *different*
 * instance. Two clients on two instances editing the same doc would otherwise each
 * see correct live updates (via the adapter) while the two servers' own copies of
 * the document silently diverged — and a THIRD client joining the second instance
 * would get a stale `join` snapshot missing the first instance's edits.
 *
 * Fix: after an instance applies+persists a batch of client ops locally, it publishes
 * them on a dedicated Redis pub/sub channel (separate from the adapter's internal
 * channels). Every instance subscribes and, if it has that document open locally,
 * folds the ops into its own `DocumentStore` via `applyPeerOps` (apply-only, never
 * re-persisted — the origin instance already wrote the durable row). This relies on
 * ops being commutative + idempotent (CRDT invariant #1/#2), so a duplicate or
 * out-of-order peer op is always safe to (re)apply.
 */

import { randomUUID } from "node:crypto";
import type { RedisClientType } from "redis";
import type { Op } from "@sync-flow/crdt";
import type { DocumentRoomManager } from "./room-manager.js";

const CHANNEL = "crdt:peer-ops";

export interface PeerRelayLogger {
  error(obj: unknown, msg?: string): void;
}

export interface PeerOpRelay {
  /** Publish ops this instance just applied+persisted locally, for peer instances to fold in. */
  publish(documentId: string, ops: readonly Op[]): void;
  close(): Promise<void>;
}

interface PeerOpMessage {
  readonly originId: string;
  readonly documentId: string;
  readonly ops: Op[];
}

/**
 * Needs its own dedicated pub + sub connections (a subscriber connection can't issue
 * normal commands), duplicated from the app's base client — same pattern as
 * `createRedisAdapter`. `originId` is a random per-process id so an instance ignores
 * its own publishes echoed back through the subscription rather than re-applying
 * (harmless either way — idempotent — but wasted work).
 */
export async function createPeerOpRelay(
  base: RedisClientType,
  manager: DocumentRoomManager,
  logger?: PeerRelayLogger,
): Promise<PeerOpRelay> {
  const originId = randomUUID();
  const pub = base.duplicate();
  const sub = base.duplicate();
  // Each `duplicate()` is its own socket/EventEmitter, NOT covered by the base client's
  // error handler in server.ts — an unhandled `error` event here crashes the whole process
  // (see the matching note in adapter.ts, and the PLAN.md chaos findings this fixes).
  pub.on("error", (err: unknown) => logger?.error({ err }, "peer-relay pub connection error"));
  sub.on("error", (err: unknown) => logger?.error({ err }, "peer-relay sub connection error"));
  await Promise.all([pub.connect(), sub.connect()]);

  await sub.subscribe(CHANNEL, (message) => {
    let parsed: PeerOpMessage;
    try {
      parsed = JSON.parse(message) as PeerOpMessage;
    } catch (err) {
      logger?.error({ err }, "peer-op message parse failed");
      return;
    }
    if (parsed.originId === originId) return;
    manager.applyPeerOps(parsed.documentId, parsed.ops);
  });

  return {
    publish(documentId, ops) {
      const payload: PeerOpMessage = { originId, documentId, ops: [...ops] };
      pub.publish(CHANNEL, JSON.stringify(payload)).catch((err: unknown) => {
        logger?.error({ err, documentId }, "peer-op publish failed");
      });
    },
    async close() {
      await sub.unsubscribe(CHANNEL);
      await Promise.all([pub.quit(), sub.quit()]);
    },
  };
}
