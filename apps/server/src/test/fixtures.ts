import type pg from "pg";

let counter = 0;

/**
 * Insert a user + a document directly (bypassing the HTTP auth flow) for
 * persistence-layer tests that just need valid FKs. Returns their ids.
 */
export async function seedUserAndDocument(
  pool: pg.Pool,
): Promise<{ userId: string; documentId: string }> {
  counter += 1;
  const n = counter;
  const {
    rows: [user],
  } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, username, presence_color)
     VALUES ($1, 'x', $2, $3, '#3182CE') RETURNING id`,
    [`crdt-fixture-${n}@example.com`, `Fixture ${n}`, `crdtfixture${n}`],
  );
  const {
    rows: [doc],
  } = await pool.query<{ id: string }>(
    `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
    [`Fixture Doc ${n}`, user!.id],
  );
  return { userId: user!.id, documentId: doc!.id };
}
