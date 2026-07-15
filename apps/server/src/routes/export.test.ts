/**
 * GET /:id/export/pdf — server-side PDF export.
 *
 * The document is seeded through the real op-log with genuine CRDT ops: inserts plus
 * `FormatOp`s for a heading, a bold run, a bulleted list, and a code block — so the
 * server-side HTML reconstruction (`renderHtmlDocument`) is exercised for real. The PDF is
 * rendered through the actual headless-Chromium renderer, then asserted to be a valid PDF
 * (the `%PDF-` magic bytes) with the correct `Content-Disposition` attachment header.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import type pg from "pg";
import {
  RGADocument,
  ROOT,
  localInsert,
  localFormat,
  type CharId,
  type Op,
} from "@sync-flow/crdt";
import { createApp } from "../app.js";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { signAccessToken } from "../auth/tokens.js";
import { ACCESS_TOKEN_COOKIE } from "../auth/cookies.js";
import { appendOperations, type CrdtStateCache } from "../crdt-service/index.js";
import { renderPdf as realRenderPdf, closePdfBrowser } from "../documents/export/index.js";
import type { CacheClient } from "../cache/types.js";

const JWT_SECRET = "test-access-secret-0123456789";
const AUTH_CONFIG = {
  jwtAccessSecret: JWT_SECRET,
  jwtRefreshSecret: "test-refresh-secret-0123456789",
  jwtAccessTtlSeconds: 900,
  jwtRefreshTtlSeconds: 604800,
  cookieDomain: "localhost",
  secureCookies: false,
  authRateLimit: { windowMs: 60_000, max: 1000 },
};
const fakeCache: CacheClient = { ping: async () => "PONG", quit: async () => "OK" };

function makeStateCache(): CrdtStateCache {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
      return "OK";
    },
    del: async (k) => (m.delete(k) ? 1 : 0),
  };
}

let counter = 0;

describe("PDF export route", () => {
  let pool: pg.Pool;
  let server: import("node:http").Server;
  let app: string;
  // Wrap the real Chromium renderer so we can assert the cache short-circuits re-renders.
  const renderPdf = vi.fn(realRenderPdf);

  beforeAll(async () => {
    pool = await setupTestDb();
    const expressApp = createApp({
      logger: pino({ level: "silent" }),
      db: pool,
      cache: fakeCache,
      corsOrigin: "http://localhost:3000",
      auth: AUTH_CONFIG,
      export: { cache: makeStateCache(), renderPdf },
    });
    await new Promise<void>((resolve) => {
      server = expressApp.listen(0, "localhost", () => resolve());
    });
    const { port } = server.address() as import("node:net").AddressInfo;
    app = `http://localhost:${port}`;
  });

  afterEach(async () => {
    renderPdf.mockClear();
    await truncateAll(pool);
  });

  afterAll(async () => {
    await closePdfBrowser();
    await pool.end();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function cookie(userId: string): string {
    return `${ACCESS_TOKEN_COOKIE}=${signAccessToken(userId, JWT_SECRET, 900)}`;
  }

  async function seedUser(): Promise<string> {
    counter += 1;
    const n = counter;
    const {
      rows: [u],
    } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, username, presence_color)
       VALUES ($1, 'x', $2, $3, '#3182CE') RETURNING id`,
      [`exp-${n}@example.com`, `User ${n}`, `expuser${n}`],
    );
    return u!.id;
  }

  /**
   * A document titled "Quarterly Report" whose body has one of each formatted construct:
   *   - Heading 1: "Report"
   *   - Paragraph with a bold run: "This is bold text."
   *   - Bulleted list: "First item", "Second item"
   *   - Code block: "const x = 1;"
   */
  async function seedFormattedDoc(title: string): Promise<{ ownerId: string; documentId: string }> {
    const ownerId = await seedUser();
    counter += 1;
    const {
      rows: [d],
    } = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      [title, ownerId],
    );
    const documentId = d!.id;
    await pool.query(
      `INSERT INTO document_snapshots (document_id, seq, state, plain_text)
       VALUES ($1, 0, '{"v":1,"clock":0,"chars":[]}'::jsonb, '')`,
      [documentId],
    );

    const doc = new RGADocument({ replicaId: randomUUID(), authorId: ownerId });
    const ops: Op[] = [];
    const flat = "Report\nThis is bold text.\nFirst item\nSecond item\nconst x = 1;";
    for (const ch of [...flat]) ops.push(localInsert(doc, doc.length, ch));

    // Block anchors: ROOT for block 0, each "\n" char for the block that follows it.
    const anchors: CharId[] = [ROOT];
    const blocks: { id: CharId; char: string }[][] = [[]];
    for (const vc of doc.visibleChars()) {
      if (vc.char === "\n") {
        anchors.push(vc.id);
        blocks.push([]);
      } else {
        blocks[blocks.length - 1]!.push(vc);
      }
    }

    ops.push(localFormat(doc, anchors[0]!, "blockType", "heading1"));
    ops.push(localFormat(doc, anchors[2]!, "listType", "bulletList"));
    ops.push(localFormat(doc, anchors[3]!, "listType", "bulletList"));
    ops.push(localFormat(doc, anchors[4]!, "blockType", "codeBlock"));

    // Bold the word "bold" in block 1 ("This is bold text.").
    const block1 = blocks[1]!;
    const text1 = block1.map((c) => c.char).join("");
    const start = text1.indexOf("bold");
    for (let i = start; i < start + "bold".length; i++) {
      ops.push(localFormat(doc, block1[i]!.id, "bold", true));
    }

    await appendOperations(
      pool,
      documentId,
      ops.map((op) => ({ op, userId: ownerId })),
    );
    return { ownerId, documentId };
  }

  it("returns a valid PDF with the correct Content-Disposition for a formatted document", async () => {
    const { ownerId, documentId } = await seedFormattedDoc("Quarterly Report");

    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/export/pdf`)
      .set("Cookie", cookie(ownerId))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="Quarterly Report.pdf"; filename*=UTF-8''Quarterly%20Report.pdf`,
    );

    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    // Valid PDF magic bytes.
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  }, 30_000);

  it("lets a viewer export (read action) and serves the second request from cache", async () => {
    const { documentId } = await seedFormattedDoc("Shared Doc");
    const viewer = await seedUser();
    await pool.query(
      `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [documentId, viewer],
    );

    const first = await request(app)
      .get(`/api/v1/documents/${documentId}/export/pdf`)
      .set("Cookie", cookie(viewer))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(first.status).toBe(200);
    expect((first.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(renderPdf).toHaveBeenCalledTimes(1);

    // Unchanged document → same content version → cached PDF, no re-render.
    const second = await request(app)
      .get(`/api/v1/documents/${documentId}/export/pdf`)
      .set("Cookie", cookie(viewer))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(second.status).toBe(200);
    expect((second.body as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(renderPdf).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("404s a non-member", async () => {
    const { documentId } = await seedFormattedDoc("Private");
    const stranger = await seedUser();
    const res = await request(app)
      .get(`/api/v1/documents/${documentId}/export/pdf`)
      .set("Cookie", cookie(stranger));
    expect(res.status).toBe(404);
    expect(renderPdf).not.toHaveBeenCalled();
  });
});
