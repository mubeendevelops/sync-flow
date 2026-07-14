/**
 * The version-restore convergence guarantee (CRDT DoD (d) applied to restore):
 * two clients editing a live document while it is restored to an older version must
 * BOTH converge, byte-for-byte, to the restored text plus whatever they typed during
 * the restore. Restore is driven through the real `performRestore` path against the
 * same live `DocumentStore` the sockets edit, with ops fanned out to clients exactly
 * as `handleEdit` does.
 *
 * Determinism note: the two "typed during the restore" edits are fired from inside the
 * restore broadcaster, i.e. immediately AFTER the restore's forward diff has been
 * computed. That's the window the restore must preserve — an edit the server had
 * already linearized BEFORE the diff is part of the state being restored away, and is
 * legitimately reverted (see restore.ts). Convergence itself holds under any
 * interleaving; this pins the "concurrent edits survive" half deterministically.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import pino from "pino";
import type pg from "pg";
import {
  RGADocument,
  localInsert,
  applyRemote,
  type DocumentSnapshot,
  type Op,
} from "@sync-flow/crdt";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";
import { performRestore, type RestoreBroadcaster } from "../crdt-service/index.js";
import { createSocketServer, type SocketServer } from "./io.js";
import type { CrdtStateCache } from "../crdt-service/index.js";
import type { PresenceCache } from "./presence.js";
import type { AckResult } from "./types.js";

const JWT_SECRET = "test-access-secret-0123456789";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FLUSH_MS = 350;

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

let seedCounter = 0;

describe("version restore convergence", () => {
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
      rate: { capacity: 500, refillPerSec: 500 },
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "localhost", () => resolve()));
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
    // Every document has a version-0 creation snapshot (see documents.repo.ts CTE).
    await pool.query(
      `INSERT INTO document_snapshots (document_id, seq, state, plain_text)
       VALUES ($1, 0, '{"v":1,"clock":0,"chars":[]}'::jsonb, '')`,
      [doc!.id],
    );
    return { ownerId: user!.id, documentId: doc!.id };
  }

  async function addEditor(documentId: string): Promise<string> {
    seedCounter += 1;
    const n = seedCounter;
    const {
      rows: [user],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, '#E53E3E') RETURNING id`,
      [`rs-editor-${n}@example.com`, `Editor ${n}`, `rseditor${n}`],
    );
    await pool.query(
      `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [documentId, user!.id],
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

  /** A client with a live mirror CRDT driven by `operation` broadcasts. */
  interface Client {
    readonly socket: ClientSocket;
    readonly doc: RGADocument;
  }

  async function join(userId: string): Promise<Client> {
    const socket = await connect(userId);
    const res = await emit<{ snapshot: DocumentSnapshot }>(socket, "join", {
      documentId: currentDocId,
    });
    if (!res.ok) throw new Error("join failed");
    const doc = RGADocument.fromSnapshot(res.data.snapshot, {
      replicaId: randomUUID(),
      authorId: userId,
    });
    socket.on("operation", (p: { ops: Op[] }) => {
      for (const op of p.ops) applyRemote(doc, op);
    });
    return { socket, doc };
  }

  /** Type `text` at the end of a client's mirror and push the ops through `edit`. */
  function typeAtEnd(client: Client, text: string): Promise<AckResult<unknown>> {
    const ops: Op[] = [];
    for (const ch of [...text]) ops.push(localInsert(client.doc, client.doc.length, ch));
    return emit(client.socket, "edit", { ops });
  }

  let currentDocId = "";

  it("two clients typing through a restore both converge to restored text + their edits", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addEditor(documentId);
    currentDocId = documentId;

    const owner = await join(ownerId);
    const editor = await join(editorId);

    // Shared live store the sockets edit (deduped with the sockets' own refs).
    const store = await server.manager.acquire(documentId);
    try {
      // (1) Establish the version we'll restore to.
      await typeAtEnd(owner, "Hello World");
      await store.flush();
      const targetVersion = store.currentSeq; // text here == "Hello World"

      // (2) Diverge from it — this content must be reverted by the restore.
      await typeAtEnd(owner, "!!!");
      await typeAtEnd(editor, "???");
      await store.flush();
      expect(store.doc.text()).toContain("!!!");
      expect(store.doc.text()).toContain("???");

      // (3) Restore to targetVersion. Each client types one char AFTER the restore
      //     diff is computed (fired from the broadcaster) — these must survive.
      let firedConcurrent = false;
      const broadcaster: RestoreBroadcaster = {
        broadcast(docId, ops, seq) {
          server.io.to(docId).emit("operation", { ops, seq });
          if (!firedConcurrent) {
            firedConcurrent = true;
            void typeAtEnd(owner, "X");
            void typeAtEnd(editor, "Y");
          }
        },
        publishPeers() {
          /* single instance */
        },
      };

      const result = await performRestore(
        store,
        { db: pool, broadcaster },
        { documentId, version: targetVersion, userId: ownerId },
      );
      expect(result.opCount).toBeGreaterThan(0);

      // Let the concurrent X/Y edits + all broadcasts settle into every mirror.
      await store.flush();
      await sleep(FLUSH_MS);

      const serverText = store.doc.text();

      // Convergence — the hard guarantee: every replica is byte-for-byte identical.
      expect(owner.doc.text()).toBe(serverText);
      expect(editor.doc.text()).toBe(serverText);

      // Restored content is back, the divergence is gone, concurrent edits survived.
      expect(serverText).toContain("Hello World");
      expect(serverText).not.toContain("!!!");
      expect(serverText).not.toContain("???");
      expect(serverText).toContain("X");
      expect(serverText).toContain("Y");

      // A cold hydrate (snapshot + op-log replay) reproduces the same text — the
      // restore is durably persisted as forward ops, not just an in-memory mutation.
      const cold = RGADocument.fromSnapshot(store.doc.toSnapshot(), {
        replicaId: "cold",
        authorId: "cold",
      });
      expect(cold.text()).toBe(serverText);
    } finally {
      server.manager.release(documentId);
    }
  });
});
