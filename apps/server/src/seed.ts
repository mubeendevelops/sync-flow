import crypto from "node:crypto";
import argon2 from "argon2";
import pg from "pg";
import { assignPresenceColor } from "./auth/presence-color.js";

const DEV_PASSWORD = "devPassword123!";

const USERS = [
  { username: "alice", email: "alice@example.com", displayName: "Alice Anderson" },
  { username: "bob", email: "bob@example.com", displayName: "Bob Brown" },
  { username: "carol", email: "carol@example.com", displayName: "Carol Chen" },
] as const;

// Must match apps/web/src/lib/demo-credentials.ts — the "Try the demo" button on /login.
// Doesn't need to satisfy signupBodySchema's password-strength rules: it's inserted directly,
// never through POST /signup.
const DEMO_USER = {
  username: "demo",
  email: "demo@syncflow.io",
  displayName: "Demo User",
} as const;
const DEMO_PASSWORD = "demo1234";

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
      [...USERS.map((u) => u.email), DEMO_USER.email],
    ]);

    const passwordHash = await argon2.hash(DEV_PASSWORD);

    const userIds: Record<string, string> = {};
    for (const user of USERS) {
      const id = crypto.randomUUID();
      const presenceColor = assignPresenceColor(id);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (id, username, email, password_hash, display_name, presence_color)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [id, user.username, user.email, passwordHash, user.displayName, presenceColor],
      );
      userIds[user.email] = rows[0].id;
    }

    {
      const demoPasswordHash = await argon2.hash(DEMO_PASSWORD);
      const id = crypto.randomUUID();
      const presenceColor = assignPresenceColor(id);
      await client.query(
        `INSERT INTO users (id, username, email, password_hash, display_name, presence_color)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          DEMO_USER.username,
          DEMO_USER.email,
          demoPasswordHash,
          DEMO_USER.displayName,
          presenceColor,
        ],
      );
      userIds[DEMO_USER.email] = id;
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

    console.log("Seeded 4 users, 2 documents, 4 membership rows.");
    console.log(`Dev password for alice/bob/carol: ${DEV_PASSWORD}`);
    for (const user of USERS) {
      console.log(`  ${user.displayName} <${user.email}> — id ${userIds[user.email]}`);
    }
    console.log(
      `Demo login (also wired to the "Try the demo" button): ${DEMO_USER.email} / ${DEMO_PASSWORD}`,
    );
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
