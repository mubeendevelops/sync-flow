import type { DbClient } from "../db/types.js";

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  presence_color: string;
  auth_provider: string;
}

const USER_COLUMNS =
  "id, username, email, password_hash, display_name, presence_color, auth_provider";

export async function findUserByEmailOrUsername(
  db: DbClient,
  email: string,
  username: string,
): Promise<UserRecord[]> {
  const { rows } = await db.query<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = $1 OR username = $2`,
    [email, username],
  );
  return rows;
}

export async function findUserByEmail(db: DbClient, email: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(db: DbClient, id: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

export interface CreateUserInput {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  presenceColor: string;
}

export async function insertUser(db: DbClient, input: CreateUserInput): Promise<UserRecord> {
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (id, username, email, password_hash, display_name, presence_color, auth_provider)
     VALUES ($1, $2, $3, $4, $5, $6, 'local')
     RETURNING ${USER_COLUMNS}`,
    [
      input.id,
      input.username,
      input.email,
      input.passwordHash,
      input.displayName,
      input.presenceColor,
    ],
  );
  return rows[0];
}

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  presenceColor: string;
}

/** Never includes password_hash — the only shape allowed to reach a response body. */
export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name,
    presenceColor: user.presence_color,
  };
}
