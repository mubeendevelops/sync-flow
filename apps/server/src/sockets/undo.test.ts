/**
 * Collaborative undo/redo over the socket layer. Ctrl+Z undoes the CURRENT user's last
 * edit only, expressed as forward CRDT ops (delete to undo an insert, revive to undo a
 * delete) that every replica integrates and converges on. Covers the three specified
 * edge cases + redo, redo-cleared-on-edit, and two-user stack independence.
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
  localDelete,
  applyRemote,
  type DocumentSnapshot,
  type Op,
} from "@sync-flow/crdt";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";
import { createSocketServer, type SocketServer } from "./io.js";
import type { CrdtStateCache } from "../crdt-service/index.js";
import type { PresenceCache } from "./presence.js";
import type { UndoStackCache } from "./undo-stack.js";
import type { AckResult } from "./types.js";

const JWT_SECRET = "test-access-secret-0123456789";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 120;

/** In-memory cache covering CRDT state, presence hashes, AND undo/redo lists. */
function makeFakeCache(): CrdtStateCache & PresenceCache & UndoStackCache {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  return {
    get: async (k) => strings.get(k) ?? null,
    set: async (k, v) => {
      strings.set(k, v);
      return "OK";
    },
    del: async (k) => {
      const had = strings.delete(k) || hashes.delete(k) || lists.delete(k);
      return had ? 1 : 0;
    },
    hSet: async (k, f, v) => {
      const h = hashes.get(k) ?? new Map();
      h.set(f, v);
      hashes.set(k, h);
      return 1;
    },
    hGetAll: async (k) => Object.fromEntries(hashes.get(k) ?? new Map()),
    hDel: async (k, f) => (hashes.get(k)?.delete(f) ? 1 : 0),
    expire: async () => 1,
    lPush: async (k, v) => {
      const l = lists.get(k) ?? [];
      l.unshift(v); // newest at head
      lists.set(k, l);
      return l.length;
    },
    lPop: async (k) => {
      const l = lists.get(k);
      if (!l || l.length === 0) return null;
      return l.shift() ?? null;
    },
    lTrim: async (k, start, stop) => {
      const l = lists.get(k);
      if (l) lists.set(k, l.slice(start, stop + 1));
      return "OK";
    },
  };
}

let seedCounter = 0;

describe("collaborative undo/redo", () => {
  let pool: pg.Pool;
  let httpServer: HttpServer;
  let server: SocketServer;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    pool = await setupTestDb();
    httpServer = createServer();
    const cache = makeFakeCache();
    server = createSocketServer(httpServer, {
      corsOrigin: "http://localhost:3000",
      jwtAccessSecret: JWT_SECRET,
      db: pool,
      cache,
      undoStack: cache,
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
      [`un-owner-${n}@example.com`, `Owner ${n}`, `unowner${n}`],
    );
    const {
      rows: [doc],
    } = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [`UN Doc ${n}`, user!.id],
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
      [`un-editor-${n}@example.com`, `Editor ${n}`, `uneditor${n}`],
    );
    await pool.query(
      `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [documentId, user!.id],
    );
    return user!.id;
  }

  async function addViewer(documentId: string): Promise<string> {
    seedCounter += 1;
    const n = seedCounter;
    const {
      rows: [user],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, '#38A169') RETURNING id`,
      [`un-viewer-${n}@example.com`, `Viewer ${n}`, `unviewer${n}`],
    );
    await pool.query(
      `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'viewer')`,
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

  function emitBare<T>(socket: ClientSocket, event: string): Promise<AckResult<T>> {
    return new Promise((resolve) => {
      socket.emit(event, (res: AckResult<T>) => resolve(res));
    });
  }

  interface Client {
    readonly socket: ClientSocket;
    readonly doc: RGADocument;
    readonly userId: string;
  }

  async function join(userId: string, documentId: string): Promise<Client> {
    const socket = await connect(userId);
    const res = await emit<{ snapshot: DocumentSnapshot }>(socket, "join", { documentId });
    if (!res.ok) throw new Error("join failed");
    const doc = RGADocument.fromSnapshot(res.data.snapshot, {
      replicaId: randomUUID(),
      authorId: userId,
    });
    socket.on("operation", (p: { ops: Op[] }) => {
      for (const op of p.ops) applyRemote(doc, op);
    });
    return { socket, doc, userId };
  }

  /** One edit event: append `text` at the end of the client's mirror. */
  function type(client: Client, text: string): Promise<AckResult<{ seq: number }>> {
    const ops: Op[] = [];
    for (const ch of [...text]) ops.push(localInsert(client.doc, client.doc.length, ch));
    return emit(client.socket, "edit", { ops });
  }

  /** One edit event: delete the visible char at `index`. */
  function del(client: Client, index: number): Promise<AckResult<{ seq: number }>> {
    const op = localDelete(client.doc, index);
    return emit(client.socket, "edit", { ops: [op] });
  }

  const undo = (c: Client) => emitBare<{ applied: number }>(c.socket, "undo");
  const redo = (c: Client) => emitBare<{ applied: number }>(c.socket, "redo");

  it("undoes an insert (tombstone) and redoes it (revive), converging on a peer", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addEditor(documentId);
    const owner = await join(ownerId, documentId);
    const observer = await join(editorId, documentId);

    await type(owner, "abc");
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("abc");
    expect(observer.doc.text()).toBe("abc");

    const u = await undo(owner);
    expect(u.ok && u.data.applied).toBe(3);
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe(""); // caller sees its own undo too
    expect(observer.doc.text()).toBe("");

    const r = await redo(owner);
    expect(r.ok && r.data.applied).toBe(3);
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("abc"); // revived at original positions, same ids
    expect(observer.doc.text()).toBe("abc");
  });

  it("undoes a delete by reviving the exact characters at their original position", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addEditor(documentId);
    const owner = await join(ownerId, documentId);
    const observer = await join(editorId, documentId);

    await type(owner, "abcde"); // edit 1
    await sleep(SETTLE_MS);
    await del(owner, 2); // edit 2: delete "c" -> "abde"
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("abde");
    expect(observer.doc.text()).toBe("abde");

    // Undo the delete (most recent edit) -> revive "c" back into place.
    await undo(owner);
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("abcde");
    expect(observer.doc.text()).toBe("abcde");
  });

  it("edge case 2: revive lands in original position even after a peer edits around the gap", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addEditor(documentId);
    const owner = await join(ownerId, documentId);
    const editor = await join(editorId, documentId);

    await type(owner, "abc");
    await sleep(SETTLE_MS);
    await del(owner, 1); // owner deletes "b" -> "ac"
    await sleep(SETTLE_MS);
    // Editor edits around the gap: append "Z" -> "acZ".
    await type(editor, "Z");
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("acZ");

    await undo(owner); // revive "b"
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe(editor.doc.text());
    expect(owner.doc.text()).toBe("abcZ"); // b back between a and c; Z untouched
  });

  it("edge case 1: undoing an insert another user already deleted is a converging no-op", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addEditor(documentId);
    const owner = await join(ownerId, documentId);
    const editor = await join(editorId, documentId);

    await type(owner, "X");
    await sleep(SETTLE_MS);
    await del(editor, 0); // the OTHER user deletes X
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("");

    // Owner undoes its insert (= delete X). Already tombstoned; acks fine, stays empty.
    const u = await undo(owner);
    expect(u.ok).toBe(true);
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("");
    expect(editor.doc.text()).toBe("");
  });

  it("edge case 3 + redo-clear: two users' stacks are independent; a new edit clears redo", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const editorId = await addEditor(documentId);
    const owner = await join(ownerId, documentId);
    const editor = await join(editorId, documentId);

    await type(owner, "A"); // owner's edit
    await sleep(SETTLE_MS);
    await type(editor, "B"); // editor's edit -> "AB"
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("AB");

    // Owner undo removes ONLY "A" (its own op); "B" stays.
    await undo(owner);
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("B");
    expect(editor.doc.text()).toBe("B");

    // Editor undo removes ONLY "B".
    await undo(editor);
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("");

    // A new edit by owner clears its redo stack: re-adding "A" was undone, but typing
    // "C" now means the earlier redo (of "A") is gone.
    await type(owner, "C");
    await sleep(SETTLE_MS);
    const r = await redo(owner);
    expect(r.ok && r.data.applied).toBe(0); // redo stack was cleared by the "C" edit
    await sleep(SETTLE_MS);
    expect(owner.doc.text()).toBe("C");
  });

  it("undo with an empty stack is a silent no-op", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const owner = await join(ownerId, documentId);
    const u = await undo(owner);
    expect(u.ok && u.data.applied).toBe(0);
  });

  it("a viewer cannot undo", async () => {
    const { ownerId, documentId } = await seedOwnerDoc();
    const viewerId = await addViewer(documentId);
    const owner = await join(ownerId, documentId);
    await type(owner, "hi");
    const viewer = await join(viewerId, documentId);

    const u = await undo(viewer);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.error.code).toBe(403);
  });
});
