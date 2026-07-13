import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type pg from "pg";
import { setupTestDb, truncateAll } from "../test/test-db.js";
import { insertUser } from "../auth/users.repo.js";
import { assignPresenceColor } from "../auth/presence-color.js";
import {
  createDocumentWithInitialSnapshot,
  upsertMember,
  softDeleteDocument,
} from "./documents.repo.js";
import { assertCanAccess } from "./permissions.js";
import { AppError } from "../errors/app-error.js";

let pool: pg.Pool;
let userCounter = 0;

async function makeUser() {
  userCounter += 1;
  const id = crypto.randomUUID();
  return insertUser(pool, {
    id,
    username: `user${userCounter}`,
    email: `user${userCounter}@example.com`,
    passwordHash: "unused-hash",
    displayName: `User ${userCounter}`,
    presenceColor: assignPresenceColor(id),
  });
}

describe("assertCanAccess", () => {
  beforeAll(async () => {
    pool = await setupTestDb();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("grants the owner 'owner' role, satisfying every minRole", async () => {
    const owner = await makeUser();
    const doc = await createDocumentWithInitialSnapshot(pool, { title: "Doc", ownerId: owner.id });

    for (const minRole of ["viewer", "editor", "owner"] as const) {
      const result = await assertCanAccess(pool, owner.id, doc.id, minRole);
      expect(result.role).toBe("owner");
    }
  });

  it("grants an editor member editor-and-below, but not owner", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const doc = await createDocumentWithInitialSnapshot(pool, { title: "Doc", ownerId: owner.id });
    await upsertMember(pool, doc.id, editor.id, "editor");

    await expect(assertCanAccess(pool, editor.id, doc.id, "viewer")).resolves.toMatchObject({
      role: "editor",
    });
    await expect(assertCanAccess(pool, editor.id, doc.id, "editor")).resolves.toMatchObject({
      role: "editor",
    });
    await expect(assertCanAccess(pool, editor.id, doc.id, "owner")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("grants a viewer member viewer-only", async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const doc = await createDocumentWithInitialSnapshot(pool, { title: "Doc", ownerId: owner.id });
    await upsertMember(pool, doc.id, viewer.id, "viewer");

    await expect(assertCanAccess(pool, viewer.id, doc.id, "viewer")).resolves.toMatchObject({
      role: "viewer",
    });
    await expect(assertCanAccess(pool, viewer.id, doc.id, "editor")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("returns 404 (not 403) for a non-member on a private document, at any minRole", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const doc = await createDocumentWithInitialSnapshot(pool, { title: "Doc", ownerId: owner.id });

    await expect(assertCanAccess(pool, stranger.id, doc.id, "viewer")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("grants any authenticated non-member viewer access on a public document", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const doc = await createDocumentWithInitialSnapshot(pool, { title: "Doc", ownerId: owner.id });
    await pool.query("UPDATE documents SET is_public = true WHERE id = $1", [doc.id]);

    await expect(assertCanAccess(pool, stranger.id, doc.id, "viewer")).resolves.toMatchObject({
      role: "viewer",
    });
    await expect(assertCanAccess(pool, stranger.id, doc.id, "editor")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("treats a soft-deleted document as not found, even for the owner", async () => {
    const owner = await makeUser();
    const doc = await createDocumentWithInitialSnapshot(pool, { title: "Doc", ownerId: owner.id });
    await softDeleteDocument(pool, doc.id);

    await expect(assertCanAccess(pool, owner.id, doc.id, "viewer")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("returns 404 for a document id that never existed", async () => {
    const owner = await makeUser();
    await expect(
      assertCanAccess(pool, owner.id, crypto.randomUUID(), "viewer"),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws AppError instances so the same helper is usable by HTTP and (later) the WS layer", async () => {
    const owner = await makeUser();
    try {
      await assertCanAccess(pool, owner.id, crypto.randomUUID(), "viewer");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
    }
  });
});
