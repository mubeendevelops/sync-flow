import argon2 from "argon2";
import pg from "pg";

const DEV_PASSWORD = "devPassword123!";

const USERS = [
  { email: "alice@example.com", displayName: "Alice Anderson" },
  { email: "bob@example.com", displayName: "Bob Brown" },
  { email: "carol@example.com", displayName: "Carol Chen" },
] as const;

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Re-runnable: clear any previous seed data before inserting fresh rows.
    await client.query("DELETE FROM documents WHERE title = ANY($1)", [
      ["Product Roadmap Q3", "Engineering Onboarding Guide"],
    ]);
    await client.query("DELETE FROM users WHERE email = ANY($1)", [
      USERS.map((u) => u.email),
    ]);

    const passwordHash = await argon2.hash(DEV_PASSWORD);

    const userIds: Record<string, string> = {};
    for (const user of USERS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [user.email, passwordHash, user.displayName],
      );
      userIds[user.email] = rows[0].id;
    }

    const { rows: doc1Rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      ["Product Roadmap Q3", userIds["alice@example.com"]],
    );
    const { rows: doc2Rows } = await client.query<{ id: string }>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id`,
      ["Engineering Onboarding Guide", userIds["bob@example.com"]],
    );
    const doc1Id = doc1Rows[0].id;
    const doc2Id = doc2Rows[0].id;

    const memberships = [
      // Product Roadmap Q3 — owned by Alice
      { documentId: doc1Id, userId: userIds["bob@example.com"], role: "editor" },
      { documentId: doc1Id, userId: userIds["carol@example.com"], role: "viewer" },
      // Engineering Onboarding Guide — owned by Bob
      { documentId: doc2Id, userId: userIds["carol@example.com"], role: "editor" },
      { documentId: doc2Id, userId: userIds["alice@example.com"], role: "viewer" },
    ];

    for (const m of memberships) {
      await client.query(
        `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, $3)`,
        [m.documentId, m.userId, m.role],
      );
    }

    await client.query("COMMIT");

    console.log("Seeded 3 users, 2 documents, 4 membership rows.");
    console.log(`Dev password for all seed users: ${DEV_PASSWORD}`);
    for (const user of USERS) {
      console.log(`  ${user.displayName} <${user.email}> — id ${userIds[user.email]}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
