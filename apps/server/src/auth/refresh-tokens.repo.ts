import type { DbClient } from "../db/types.js";

export interface RefreshTokenRecord {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface InsertRefreshTokenInput {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function insertRefreshToken(
  db: DbClient,
  input: InsertRefreshTokenInput,
): Promise<void> {
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.userId, input.familyId, input.tokenHash, input.expiresAt],
  );
}

export async function findRefreshTokenByHash(
  db: DbClient,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  const { rows } = await db.query<RefreshTokenRecord>(
    `SELECT id, user_id, family_id, token_hash, expires_at, revoked_at
     FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeRefreshToken(db: DbClient, id: string): Promise<void> {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
}

/** Revokes every token in a rotation chain — used on reuse detection (theft) and full logout. */
export async function revokeRefreshTokenFamily(db: DbClient, familyId: string): Promise<void> {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}
