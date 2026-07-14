/**
 * Offline / fell-behind resync protocol (PLAN 2.10 hardening). Exercises the cases the
 * sync design has to survive, against a REAL Postgres (fake in-memory cache for
 * presence/hot-state; single instance — cross-instance fan-out is multi-instance.test.ts):
 *
 *   1. THE HARD CASE — a client disconnects, makes 50 LOCAL edits offline while a peer
 *      makes 50 CONCURRENT edits online, then reconnects. Both converge byte-for-byte.
 *      This is where a weak CRDT (OT with a wrong transform, or fractional-index
 *      ordering) interleaves or drops edits; RGA's globally-unique char ids + the
 *      deterministic (clock, replicaId) tiebreak make convergence a property of the OPS,
 *      not of arrival order — proven by aiming both edit streams at the SAME anchor.
 *   2. REPLAY-FLOOR fallback — a client below the 2nd-most-recent snapshot's seq gets a
 *      full snapshot even for a tiny gap, because the ops it needs may have been pruned.
 *   3. CLIENT AHEAD OF SERVER — `since > currentSeq` (server lost ops): the server
 *      answers `server_behind`; the client re-pushes its local ops via `edit`, and
 *      everything converges + rebroadcasts.
 *
 * The plain op-tail-vs-size-threshold boundary is already covered by realtime.test.ts.
 *
 * The "client" is a real socket.io client plus a local `RGADocument` it mutates and
 * syncs exactly as the Phase-3 web client will: mint local ops while offline; on
 * reconnect, apply the server's tail, then push buffered local ops via `edit`.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import pino from "pino";
import type pg from "pg";
import { RGADocument, localInsert, applyRemote, type Op } from "@sync-flow/crdt";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";
import { createSocketServer, type SocketServer } from "./io.js";
import type { CrdtStateCache } from "../crdt-service/index.js";
import type { PresenceCache } from "./presence.js";
import type { AckResult, JoinResult, SyncResult } from "./types.js";

const JWT_SECRET = "test-access-secret-0123456789";

function makeFakeCache(): CrdtStateCache & PresenceCache {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  return {
    get: async (k) => strings.get(k) ?? null,
    set: async (k, v) => {
      strings.set(k, v);
      return "OK";
    },
    del: async (k) => (strings.delete(k) ? 1 : 0),
    hSet: async (k, f, v) => {
      const h = hashes.get(k) ?? new Map();
      h.set(f, v);
      hashes.set(k, h);
      return 1;
    },
    hGetAll: async (k) => Object.fromEntries(hashes.get(k) ?? new Map()),
    hDel: async (k, f) => (hashes.get(k)?.delete(f) ? 1 : 0),
    expire: async () => 1,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Long enough for the OpWriter's 250ms batch window to flush to Postgres. */
const FLUSH_MS = 400;

let seedCounter = 0;

describe("offline / fell-behind resync", () => {
  let pool: pg.Pool;
  let httpServer: HttpServer;
  let server: SocketServer;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    pool = await setupTestDb();
    httpServer = createServer();
    server = createSocketServer(httpServer, {
      corsOrigin: "http://localhost:3000",
      jwtAccessSecret: JWT_SECRET,
      db: pool,
      cache: makeFakeCache(),
      logger: pino({ level: "silent" }),
      // Production default (500). A 50-op catch-up gap stays on the op-tail path here, so
      // the hard case converges the realistic way; the replay-floor test isolates the
      // snapshot fallback so it isn't masked by the size threshold.
      syncThreshold: 500,
      // Roomy bucket so a 50-op offline batch isn't rate-limited (that's tested elsewhere).
      rate: { capacity: 500, refillPerSec: 500 },
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "localhost", () => resolve());
    });
    url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    await truncateAll(pool);
  });

  afterAll(async () => {
    await server.io.close();
    await pool.end();
  });

  // ---- fixtures -----------------------------------------------------------

  async function seedOwnerDoc(): Promise<{ ownerId: string; documentId: string }> {
    seedCounter += 1;
    const n = seedCounter;
    const {
      rows: [user],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, '#3182CE') RETURNING id`,
      [`rs-owner-${n}@example.com`, `Owner ${n}`, `rsowner${n}`],
    );
    const {
      rows: [doc],
    } = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [`RS Doc ${n}`, user!.id],
    );
    return { ownerId: user!.id, documentId: doc!.id };
  }

  async function addCollaborator(documentId: string, role: "editor" | "viewer"): Promise<string> {
    seedCounter += 1;
    const n = seedCounter;
    const {
      rows: [user],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, '#E53E3E') RETURNING id`,
      [`rs-collab-${n}@example.com`, `Collab ${n}`, `rscollab${n}`],
    );
    await pool.query(
      `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, $3)`,
      [documentId, user!.id, role],
    );
    return user!.id;
  }

  function cookieFor(userId: string): string {
    return `${ACCESS_TOKEN_COOKIE}=${signAccessToken(userId, JWT_SECRET, 900)}`;
  }

  function connect(userId: string): Promise<ClientSocket> {
    const socket = ioClient(url, {
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: { Cookie: cookieFor(userId) },
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", (err) => reject(err));
    });
  }

  function emit<T>(socket: ClientSocket, event: string, payload: unknown): Promise<AckResult<T>> {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res: AckResult<T>) => resolve(res));
    });
  }

  async function opCount(documentId: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM document_operations WHERE document_id = $1",
      [documentId],
    );
    return Number(rows[0]!.n);
  }

  /**
   * The server's authoritative text: a fresh socket join hydrates a store from durable
   * state and returns its live snapshot, which we materialize. Faithful to "server state"
   * because it's the same server-side materialized CRDT every other client joins against.
   */
  async function serverText(documentId: string, asUserId: string): Promise<string> {
    const observer = await connect(asUserId);
    const join = await emit<JoinResult>(observer, "join", { documentId });
    if (!join.ok) throw new Error("observer join failed");
    const doc = RGADocument.fromSnapshot(join.data.snapshot, {
      replicaId: randomUUID(),
      authorId: "observer",
    });
    observer.disconnect();
    return doc.text();
  }

  // ---- 1. the hard case ---------------------------------------------------

  it("converges after a client makes 50 offline edits while a peer makes 50 concurrent edits", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(ownerId);
    const b = await connect(editorId);

    const aDoc = new RGADocument({ replicaId: randomUUID(), authorId: ownerId });
    const bDoc = new RGADocument({ replicaId: randomUUID(), authorId: editorId });

    // `b` mirrors every op it's told about. (`a` deliberately has NO listener during its
    // offline window — that's what "offline" means here: it ignores the network and
    // catches up via `sync` on reconnect, exactly the resync protocol.)
    b.on("operation", (p: { ops: Op[] }) => {
      for (const op of p.ops) applyRemote(bDoc, op);
    });

    await emit(a, "join", { documentId });
    await emit(b, "join", { documentId });

    // Shared base "|" so the two concurrent runs compete for the SAME anchor (position 0).
    const baseOp = localInsert(aDoc, 0, "|");
    const baseAck = await emit<{ seq: number; count: number }>(a, "edit", { ops: [baseOp] });
    expect(baseAck.ok).toBe(true);
    // `a`'s last_known_version is the watermark it last saw (optimistic ack → lower bound;
    // over-replaying from a stale watermark is idempotent, which is the point).
    const aVersion = baseAck.ok ? baseAck.data.seq : 0;
    await sleep(FLUSH_MS);
    expect(bDoc.text()).toBe("|"); // `b` mirrored the base

    // --- `a` OFFLINE: buffer 50 local inserts at position 0. ---
    const aOfflineOps: Op[] = [];
    for (let i = 0; i < 50; i++) aOfflineOps.push(localInsert(aDoc, 0, "A"));
    expect(aDoc.text()).toBe("A".repeat(50) + "|");

    // --- `b` ONLINE: 50 concurrent inserts at position 0, sent to the server. ---
    const bOps: Op[] = [];
    for (let i = 0; i < 50; i++) bOps.push(localInsert(bDoc, 0, "B"));
    const bAck = await emit<{ seq: number; count: number }>(b, "edit", { ops: bOps });
    expect(bAck.ok).toBe(true);
    await sleep(FLUSH_MS);

    // --- `a` RECONNECTS: (down) sync catch-up, then (up) push offline ops. ---
    const sync = await emit<SyncResult>(a, "sync", { since: aVersion });
    expect(sync.ok).toBe(true);
    if (sync.ok) {
      // 50-op gap ≤ threshold(500) → op tail; apply it onto `a`'s local (offline) doc.
      expect(sync.data.mode).toBe("ops");
      if (sync.data.mode === "ops") {
        for (const op of sync.data.ops) applyRemote(aDoc, op);
      }
    }

    // `b` converges when it has received all of `a`'s pushed offline ops.
    const bReceivedAll = new Promise<void>((resolve) => {
      let seen = 0;
      b.on("operation", (p: { ops: Op[] }) => {
        seen += p.ops.length;
        if (seen >= aOfflineOps.length) resolve();
      });
    });
    const pushAck = await emit<{ seq: number; count: number }>(a, "edit", { ops: aOfflineOps });
    expect(pushAck.ok).toBe(true);
    await bReceivedAll;
    await sleep(FLUSH_MS);

    // Convergence: both clients AND the server's durable materialized state agree
    // byte-for-byte — the whole point.
    const finalText = aDoc.text();
    expect(bDoc.text()).toBe(finalText);
    expect(await serverText(documentId, ownerId)).toBe(finalText);
    // Nothing lost, nothing duplicated: 50 A + 50 B + base = 101 chars.
    expect(finalText.length).toBe(101);
    expect([...finalText].filter((c) => c === "A")).toHaveLength(50);
    expect([...finalText].filter((c) => c === "B")).toHaveLength(50);
    expect([...finalText].filter((c) => c === "|")).toHaveLength(1);
  });

  // ---- 2. replay-floor fallback -------------------------------------------

  it("sends a snapshot when the client is below the replay floor, even for a tiny gap", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const owner = await connect(ownerId);
    await emit(owner, "join", { documentId });

    const doc = new RGADocument({ replicaId: randomUUID(), authorId: ownerId });
    const ops: Op[] = [localInsert(doc, 0, "x"), localInsert(doc, 1, "y")];
    await emit(owner, "edit", { ops });
    await sleep(FLUSH_MS);

    // Simulate retention having snapshotted twice: insert two snapshot rows directly (the
    // policy-driven path is covered in persistence.test.ts). The 2nd-most-recent snapshot
    // seq becomes the replay floor. Anchoring both to the doc's current head keeps this
    // independent of the GLOBAL seq value, which drifts across tests.
    const {
      rows: [{ seq: headStr }],
    } = await pool.query<{ seq: string }>(
      "SELECT max(seq)::text AS seq FROM document_operations WHERE document_id = $1",
      [documentId],
    );
    const head = Number(headStr);
    const emptyState = JSON.stringify({ v: 1, clock: head, chars: [] });
    await pool.query(
      `INSERT INTO document_snapshots (document_id, seq, state, plain_text)
       VALUES ($1, $2, $3::jsonb, ''), ($1, $4, $3::jsonb, '')
       ON CONFLICT DO NOTHING`,
      [documentId, head - 1, emptyState, head],
    );
    // Snapshots now at {head-1, head} → replay floor = head-1.

    // Client is only a couple ops behind (small gap ≤ threshold) but its version is BELOW
    // the floor, so the ops it needs might be pruned → the server must send a snapshot.
    const belowFloor = head - 2;
    const sync = await emit<SyncResult>(owner, "sync", { since: belowFloor });
    expect(sync.ok).toBe(true);
    if (sync.ok) expect(sync.data.mode).toBe("snapshot");
  });

  // ---- 3. client ahead of server ------------------------------------------

  it("tells a client that is ahead of the server to re-push, then converges", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(ownerId);
    const b = await connect(editorId);
    await emit(a, "join", { documentId });

    const bDoc = new RGADocument({ replicaId: randomUUID(), authorId: editorId });
    b.on("operation", (p: { ops: Op[] }) => {
      for (const op of p.ops) applyRemote(bDoc, op);
    });
    await emit(b, "join", { documentId });

    // `a` holds local ops the server ended up WITHOUT (models a crash / PITR restore that
    // rolled back committed ops). Its last_known_version is ahead of the server's watermark.
    const aDoc = new RGADocument({ replicaId: randomUUID(), authorId: ownerId });
    const lostOps: Op[] = [];
    for (const ch of "recovered") lostOps.push(localInsert(aDoc, aDoc.length, ch));

    const currentSeq = 0; // fresh doc: the server has no ops
    const ahead = await emit<SyncResult>(a, "sync", { since: currentSeq + 100 });
    expect(ahead.ok).toBe(true);
    if (ahead.ok) {
      expect(ahead.data.mode).toBe("server_behind");
      if (ahead.data.mode === "server_behind") expect(ahead.data.seq).toBe(currentSeq);
    }

    // Recovery: `a` re-pushes its local ops via `edit`; the server integrates + rebroadcasts.
    const bReceivedAll = new Promise<void>((resolve) => {
      let seen = 0;
      b.on("operation", (p: { ops: Op[] }) => {
        seen += p.ops.length;
        if (seen >= lostOps.length) resolve();
      });
    });
    const push = await emit<{ seq: number; count: number }>(a, "edit", { ops: lostOps });
    expect(push.ok).toBe(true);
    await bReceivedAll;
    await sleep(FLUSH_MS);

    expect(aDoc.text()).toBe("recovered");
    expect(bDoc.text()).toBe("recovered");
    expect(await serverText(documentId, ownerId)).toBe("recovered");
    expect(await opCount(documentId)).toBe(lostOps.length);
  });
});
