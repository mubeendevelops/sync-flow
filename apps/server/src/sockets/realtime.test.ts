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
import type { AckResult, PresenceUser } from "./types.js";

const JWT_SECRET = "test-access-secret-0123456789";

/** In-memory cache satisfying both the CRDT state cache and presence surfaces. */
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
/** Long enough for the OpWriter's 250ms batch window to flush. */
const FLUSH_MS = 350;

let seedCounter = 0;

describe("real-time socket layer", () => {
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
      syncThreshold: 5,
      rate: { capacity: 50, refillPerSec: 50 },
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
    // io.close() also closes the underlying HTTP server it's attached to.
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
      [`rt-owner-${n}@example.com`, `Owner ${n}`, `rtowner${n}`],
    );
    const {
      rows: [doc],
    } = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [`RT Doc ${n}`, user!.id],
    );
    return { ownerId: user!.id, documentId: doc!.id };
  }

  async function addCollaborator(
    documentId: string,
    role: "editor" | "viewer",
  ): Promise<string> {
    seedCounter += 1;
    const n = seedCounter;
    const {
      rows: [user],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, '#E53E3E') RETURNING id`,
      [`rt-collab-${n}@example.com`, `Collab ${n}`, `rtcollab${n}`],
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

  function connect(userId?: string): Promise<ClientSocket> {
    const socket = ioClient(url, {
      reconnection: false,
      extraHeaders: userId ? { Cookie: cookieFor(userId) } : {},
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

  /** Build a batch of insert ops that type `text` into a fresh client-side CRDT. */
  function typeOps(text: string, authorId: string): { ops: Op[]; doc: RGADocument } {
    const doc = new RGADocument({ replicaId: randomUUID(), authorId });
    const ops: Op[] = [];
    for (let i = 0; i < text.length; i++) ops.push(localInsert(doc, i, text[i]!));
    return { ops, doc };
  }

  // ---- auth ---------------------------------------------------------------

  it("rejects a connection with no auth cookie", async () => {
    await expect(connect()).rejects.toThrow(/Authentication required/);
  });

  it("rejects a connection with an invalid token", async () => {
    const socket = ioClient(url, {
      reconnection: false,
      extraHeaders: { Cookie: `${ACCESS_TOKEN_COOKIE}=not-a-real-jwt` },
    });
    clients.push(socket);
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("connect_error", (err) => reject(err));
      }),
    ).rejects.toThrow(/Invalid or expired/);
  });

  it("accepts a connection with a valid cookie", async () => {
    const { ownerId } = await seedOwnerDoc();
    const socket = await connect(ownerId);
    expect(socket.connected).toBe(true);
  });

  // ---- authorization ------------------------------------------------------

  it("lets a viewer join read-only but rejects (and never persists) their edits", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const viewerId = await addCollaborator(documentId, "viewer");

    const owner = await connect(ownerId);
    const viewer = await connect(viewerId);

    const ownerJoin = await emit(owner, "join", { documentId });
    expect(ownerJoin.ok).toBe(true);

    const viewerJoin = await emit<{ role: string }>(viewer, "join", { documentId });
    expect(viewerJoin.ok).toBe(true);
    if (viewerJoin.ok) expect(viewerJoin.data.role).toBe("viewer");

    let ownerGotOp = false;
    owner.on("operation", () => (ownerGotOp = true));

    const { ops } = typeOps("hi", viewerId);
    const res = await emit(viewer, "edit", { ops });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(403);

    await sleep(FLUSH_MS);
    expect(ownerGotOp).toBe(false);
    expect(await opCount(documentId)).toBe(0);
  });

  // ---- round-trip + convergence ------------------------------------------

  it("applies, persists, and broadcasts an editor's ops so a second client converges", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(ownerId);
    const b = await connect(editorId);
    await emit(a, "join", { documentId });
    await emit(b, "join", { documentId });

    // Client B mirrors the doc from broadcasts.
    const bDoc = new RGADocument({ replicaId: randomUUID(), authorId: editorId });
    b.on("operation", (p: { ops: Op[] }) => {
      for (const op of p.ops) applyRemote(bDoc, op);
    });

    const { ops } = typeOps("Hello", ownerId);
    const ack = await emit<{ seq: number; count: number }>(a, "edit", { ops });
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.data.count).toBe(5);

    await sleep(FLUSH_MS);

    // (1) B received and converged; (2) ops persisted to the log.
    expect(bDoc.text()).toBe("Hello");
    expect(await opCount(documentId)).toBe(5);
  });

  // ---- validation ---------------------------------------------------------

  it("rejects malformed ops without applying them", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const owner = await connect(ownerId);
    await emit(owner, "join", { documentId });

    const badVersion = await emit(owner, "edit", {
      ops: [{ type: "insert", charId: { clock: 1, replicaId: "r" }, afterId: { clock: 0, replicaId: "ROOT" }, value: "x", authorId: "a", timestamp: 1, opVersion: 999 }],
    });
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error.code).toBe(400);

    const emptyValue = await emit(owner, "edit", {
      ops: [{ type: "insert", charId: { clock: 1, replicaId: "r" }, afterId: { clock: 0, replicaId: "ROOT" }, value: "", authorId: "a", timestamp: 1, opVersion: 1 }],
    });
    expect(emptyValue.ok).toBe(false);

    await sleep(FLUSH_MS);
    expect(await opCount(documentId)).toBe(0);
  });

  it("rejects an oversized op batch", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const owner = await connect(ownerId);
    await emit(owner, "join", { documentId });

    const { ops } = typeOps("x".repeat(300), ownerId); // > MAX_OPS_PER_EDIT (256)
    const res = await emit(owner, "edit", { ops });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(400);
  });

  // ---- resync -------------------------------------------------------------

  it("replays the op tail on a small sync gap and snapshots on a large one", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const owner = await connect(ownerId);
    await emit(owner, "join", { documentId });

    const { ops } = typeOps("abcdefgh", ownerId); // 8 ops, threshold is 5
    await emit(owner, "edit", { ops });
    await sleep(FLUSH_MS);

    // since=6 → gap 2 ≤ 5 → op tail
    const small = await emit<{ mode: string; ops: Op[] }>(owner, "sync", { since: 6 });
    expect(small.ok).toBe(true);
    if (small.ok) {
      expect(small.data.mode).toBe("ops");
      expect(small.data.ops.length).toBeGreaterThan(0);
    }

    // since=0 → gap 8 > 5 → snapshot
    const large = await emit<{ mode: string }>(owner, "sync", { since: 0 });
    expect(large.ok).toBe(true);
    if (large.ok) expect(large.data.mode).toBe("snapshot");
  });

  // ---- rate limiting ------------------------------------------------------

  it("throttles a flood beyond the ops/sec budget without dropping the connection", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const owner = await connect(ownerId);
    await emit(owner, "join", { documentId });

    // capacity is 50; a single 60-op batch exceeds the burst in one shot.
    const { ops } = typeOps("y".repeat(60), ownerId);
    const res = await emit(owner, "edit", { ops });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(429);

    expect(owner.connected).toBe(true);
    await sleep(FLUSH_MS);
    expect(await opCount(documentId)).toBe(0);
  });

  // ---- presence / disconnect ---------------------------------------------

  it("announces joins and leaves and clears presence on disconnect", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addCollaborator(documentId, "editor");

    const a = await connect(ownerId);
    await emit(a, "join", { documentId });

    const joined = new Promise<PresenceUser>((resolve) => a.on("user_joined", resolve));
    const b = await connect(editorId);
    const bJoin = await emit<{ users: PresenceUser[] }>(b, "join", { documentId });
    const joinedUser = await joined;
    expect(joinedUser.userId).toBe(editorId);
    if (bJoin.ok) expect(bJoin.data.users.map((u) => u.userId)).toContain(ownerId);

    const left = new Promise<{ userId: string }>((resolve) => a.on("user_left", resolve));
    b.disconnect();
    expect((await left).userId).toBe(editorId);
  });
});
