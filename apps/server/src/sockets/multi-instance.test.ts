/**
 * Horizontal-scaling verification (PLAN: multi-instance WS layer). Boots TWO real,
 * fully independent server instances — each with its OWN HTTP server, Socket.io
 * server, Redis connections (adapter + peer relay), and `DocumentRoomManager` — on
 * two ports, sharing only the same real Postgres and Redis (exactly what N deployed
 * instances behind a load balancer would share). This is the thing a fake-cache unit
 * test can't prove: `realtime.test.ts` uses an in-memory cache and a single process,
 * so it can't catch a bug that only exists BETWEEN two instances.
 *
 * Three things are asserted, matching the CLAUDE.md architecture:
 *   1. Redis-adapter fan-out: an op/cursor sent on instance 1 reaches a client
 *      connected to instance 2.
 *   2. Redis-backed presence: the participant list is the union across instances,
 *      not per-process state.
 *   3. Peer-apply convergence: instance 2's OWN already-open `DocumentStore` (not a
 *      fresh Postgres reload) reflects an op that was only ever applied+persisted on
 *      instance 1 — the gap the Redis adapter alone does NOT close, since it only
 *      fans out to connected sockets, not to peer servers' materialized copies.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import pino from "pino";
import type pg from "pg";
import type { RedisClientType } from "redis";
import { RGADocument, localInsert, type Op } from "@sync-flow/crdt";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";
import { createRedisClient } from "../cache/client.js";
import { createSocketServer, type SocketServer } from "./io.js";
import { createRedisAdapter } from "./adapter.js";
import { createPeerOpRelay, type PeerOpRelay } from "./peer-relay.js";
import { DocumentRoomManager } from "./room-manager.js";
import type { AckResult, JoinResult, PresenceUser } from "./types.js";

const JWT_SECRET = "test-access-secret-0123456789";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Long enough for the OpWriter's 250ms batch window AND a Redis pub/sub round-trip. */
const FLUSH_MS = 400;

let seedCounter = 0;

interface Instance {
  readonly httpServer: HttpServer;
  readonly server: SocketServer;
  readonly url: string;
  readonly redis: RedisClientType;
  readonly adapterPub: RedisClientType;
  readonly adapterSub: RedisClientType;
  readonly peerRelay: PeerOpRelay;
}

describe("multi-instance horizontal scaling", () => {
  let pool: pg.Pool;
  let instance1: Instance;
  let instance2: Instance;
  const clients: ClientSocket[] = [];

  async function bootInstance(): Promise<Instance> {
    const logger = pino({ level: "silent" });
    const redis = createRedisClient(TEST_REDIS_URL) as RedisClientType;
    await redis.connect();

    const httpServer = createServer();
    const { adapter, pub: adapterPub, sub: adapterSub } = await createRedisAdapter(redis);
    const manager = new DocumentRoomManager({ db: pool, cache: redis, logger });
    const peerRelay = await createPeerOpRelay(redis, manager, logger);

    const server = createSocketServer(httpServer, {
      corsOrigin: "http://localhost:3000",
      jwtAccessSecret: JWT_SECRET,
      db: pool,
      cache: redis,
      logger,
      adapter,
      manager,
      peerRelay,
      syncThreshold: 5,
      rate: { capacity: 50, refillPerSec: 50 },
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "localhost", () => resolve());
    });
    const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

    return { httpServer, server, url, redis, adapterPub, adapterSub, peerRelay };
  }

  async function shutdownInstance(instance: Instance): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      instance.server.io.close((err) => (err ? reject(err) : resolve()));
    });
    await instance.server.manager.closeAll();
    await instance.peerRelay.close();
    await Promise.all([instance.adapterPub.quit(), instance.adapterSub.quit()]);
    await instance.redis.quit();
  }

  beforeAll(async () => {
    pool = await setupTestDb();
    instance1 = await bootInstance();
    instance2 = await bootInstance();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    await truncateAll(pool);
  });

  afterAll(async () => {
    await Promise.all([shutdownInstance(instance1), shutdownInstance(instance2)]);
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
      [`mi-owner-${n}@example.com`, `Owner ${n}`, `miowner${n}`],
    );
    const {
      rows: [doc],
    } = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [`MI Doc ${n}`, user!.id],
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
      [`mi-collab-${n}@example.com`, `Collab ${n}`, `micollab${n}`],
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

  function connect(instance: Instance, userId: string): Promise<ClientSocket> {
    const socket = ioClient(instance.url, {
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

  function typeOps(text: string, authorId: string): Op[] {
    const doc = new RGADocument({ replicaId: randomUUID(), authorId });
    const ops: Op[] = [];
    for (let i = 0; i < text.length; i++) ops.push(localInsert(doc, i, text[i]!));
    return ops;
  }

  // ---- 1. cross-instance op fan-out ---------------------------------------

  it("relays an editor's ops from instance 1 to a client connected on instance 2", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(instance1, ownerId);
    const b = await connect(instance2, editorId);
    await emit(a, "join", { documentId });
    await emit(b, "join", { documentId });

    const received = new Promise<{ ops: Op[] }>((resolve) => b.on("operation", resolve));

    const ops = typeOps("Hello", ownerId);
    const ack = await emit<{ seq: number; count: number }>(a, "edit", { ops });
    expect(ack.ok).toBe(true);

    const payload = await received;
    expect(payload.ops.map((o) => (o.type === "insert" ? o.value : null))).toEqual([
      "H",
      "e",
      "l",
      "l",
      "o",
    ]);
  });

  // ---- 2. cross-instance cursor fan-out -----------------------------------

  it("relays cursor updates from instance 1 to a client connected on instance 2", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(instance1, ownerId);
    const b = await connect(instance2, editorId);
    await emit(a, "join", { documentId });
    await emit(b, "join", { documentId });

    const received = new Promise<PresenceUser>((resolve) => b.on("cursor_update", resolve));
    a.emit("cursor", { anchor: "1@abc", head: "1@abc" });

    const update = await received;
    expect(update.userId).toBe(ownerId);
    expect(update.anchor).toBe("1@abc");
  });

  // ---- 3. Redis-backed presence, not per-instance memory ------------------

  it("returns the union of participants across instances (presence is Redis, not in-process)", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(instance1, ownerId);
    await emit(a, "join", { documentId });

    const b = await connect(instance2, editorId);
    const bJoin = await emit<JoinResult>(b, "join", { documentId });

    expect(bJoin.ok).toBe(true);
    if (bJoin.ok) {
      // instance2 never saw `a` connect locally — this list can only be complete
      // because presence lives in a shared Redis hash, not per-process memory.
      expect(bJoin.data.users.map((u) => u.userId)).toContain(ownerId);
    }
  });

  // ---- 4. peer-apply: server-side materialized copies stay convergent -----

  it("keeps instance 2's already-open store convergent with ops applied only on instance 1", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(instance1, ownerId);
    await emit(a, "join", { documentId });

    // `b` keeps instance2's DocumentStore open (refs > 0) for the rest of the test,
    // so a later join on instance2 reuses this SAME in-memory store rather than
    // triggering a fresh Postgres hydrate — which is the only way this test can
    // distinguish "peer-apply worked" from "the join just reloaded from Postgres".
    const b = await connect(instance2, editorId);
    await emit(b, "join", { documentId });

    const ops = typeOps("Hello", ownerId);
    const ack = await emit<{ seq: number; count: number }>(a, "edit", { ops });
    expect(ack.ok).toBe(true);

    // Give the OpWriter's batch flush + the peer-relay's Redis pub/sub round-trip
    // time to land on instance 2.
    await sleep(FLUSH_MS);

    const viewerId = await addCollaborator(documentId, "viewer");
    const c = await connect(instance2, viewerId);
    const cJoin = await emit<JoinResult>(c, "join", { documentId });

    expect(cJoin.ok).toBe(true);
    if (cJoin.ok) {
      const text = RGADocument.fromSnapshot(cJoin.data.snapshot, {
        replicaId: randomUUID(),
        authorId: "test-observer",
      }).text();
      expect(text).toBe("Hello");
    }
  });
});
