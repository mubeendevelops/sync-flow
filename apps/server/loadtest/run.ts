/**
 * Standalone WS load harness for the doc-editing hot path (join → edit → ack → broadcast).
 * autocannon is HTTP-request-focused and can't drive Socket.io's protocol, so this simulates
 * the actual "N concurrent editors, 1 edit/sec each" scenario the hardening pass asked for,
 * using the real `@sync-flow/crdt` package to mint valid ops exactly like a browser tab would.
 *
 * Usage: tsx loadtest/run.ts <editors> <durationSeconds> [serverUrl]
 * Requires the server already running (see loadtest/README or PLAN.md "Load Test Results").
 */

import crypto from "node:crypto";
import pg from "pg";
import { io, type Socket } from "socket.io-client";
import { RGADocument, localInsert } from "@sync-flow/crdt";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/users.repo.js";
import { assignPresenceColor } from "../src/auth/presence-color.js";
import { signAccessToken } from "../src/auth/tokens.js";

const EDITORS = Number(process.argv[2] ?? 10);
const DURATION_SECONDS = Number(process.argv[3] ?? 30);
const SERVER_URL = process.argv[4] ?? "http://localhost:4000";
const RUN_ID = Date.now();

interface Session {
  userId: string;
  accessToken: string;
}

// Bypasses POST /auth/signup deliberately: that endpoint is rate-limited (20/15min/IP, see
// middleware/rate-limit.ts) by design, and this script mints dozens of accounts from one IP
// as pure test setup, not the thing under test. Writes straight through the same repo
// functions the route itself uses, so the resulting rows/hashes are identical to a real signup.
async function provisionUser(
  db: pg.Pool,
  username: string,
  jwtAccessSecret: string,
): Promise<Session> {
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword("Load-Test-9!");
  const presenceColor = assignPresenceColor(id);
  const user = await insertUser(db, {
    id,
    username,
    email: `${username}@loadtest.local`,
    passwordHash,
    displayName: username,
    presenceColor,
  });
  const accessToken = signAccessToken(user.id, jwtAccessSecret, 900);
  return { userId: user.id, accessToken };
}

async function createDocument(owner: Session, title: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `access_token=${owner.accessToken}` },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`create document failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

async function inviteEditor(owner: Session, documentId: string, email: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/v1/documents/${documentId}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `access_token=${owner.accessToken}` },
    body: JSON.stringify({ email, role: "editor" }),
  });
  if (!res.ok) throw new Error(`invite ${email} failed: ${res.status} ${await res.text()}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function connectAndJoin(
  session: Session,
  documentId: string,
): Promise<{ socket: Socket; doc: RGADocument }> {
  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    extraHeaders: { Cookie: `access_token=${session.accessToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect_error", (err) => reject(err));
    socket.on("connect", () => resolve());
  });
  const joinResult = await new Promise<{
    ok: true;
    data: { snapshot: unknown; seq: number };
  }>((resolve, reject) => {
    socket.emit("join", { documentId }, (res: { ok: boolean; data?: unknown; error?: unknown }) => {
      if (!res.ok) reject(new Error(JSON.stringify(res.error)));
      else resolve(res as { ok: true; data: { snapshot: unknown; seq: number } });
    });
  });
  const replicaId = crypto.randomUUID();
  const doc = RGADocument.fromSnapshot(joinResult.data.snapshot as never, {
    replicaId,
    authorId: session.userId,
  });
  return { socket, doc };
}

async function main(): Promise<void> {
  console.log(`Load test: ${EDITORS} editors, ${DURATION_SECONDS}s, ${SERVER_URL}`);

  const databaseUrl = process.env.DATABASE_URL;
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  if (!databaseUrl || !jwtAccessSecret) {
    throw new Error(
      "DATABASE_URL and JWT_ACCESS_SECRET must be set (run via dotenv -e ../../.env)",
    );
  }
  const db = new pg.Pool({ connectionString: databaseUrl });

  const owner = await provisionUser(db, `loadowner-${RUN_ID}`, jwtAccessSecret);
  const documentId = await createDocument(owner, `Load Test ${RUN_ID}`);

  const editorNames: string[] = [];
  const editors: Session[] = [owner];
  for (let i = 1; i < EDITORS; i++) {
    const name = `loadeditor-${RUN_ID}-${i}`;
    editorNames.push(name);
    editors.push(await provisionUser(db, name, jwtAccessSecret));
  }
  await Promise.all(
    editorNames.map((name) => inviteEditor(owner, documentId, `${name}@loadtest.local`)),
  );
  await db.end();

  const connections = await Promise.all(editors.map((s) => connectAndJoin(s, documentId)));
  console.log(`All ${connections.length} editors joined document ${documentId}`);

  const latencies: number[] = [];
  let errors = 0;
  let sent = 0;

  const chars = "abcdefghijklmnopqrstuvwxyz";
  const ticks: ReturnType<typeof setInterval>[] = connections.map(({ socket, doc }, i) => {
    return setInterval(() => {
      const char = chars[Math.floor(Math.random() * chars.length)]!;
      const op = localInsert(doc, doc.length, char);
      const t0 = performance.now();
      sent++;
      socket.emit("edit", { ops: [op] }, (res: { ok: boolean }) => {
        if (!res.ok) {
          errors++;
          return;
        }
        latencies.push(performance.now() - t0);
      });
    }, 1000 + i); // jitter start offsets by a few ms so N editors don't all fire on the same tick
  });

  await new Promise((resolve) => setTimeout(resolve, DURATION_SECONDS * 1000));
  ticks.forEach(clearInterval);
  // Let in-flight acks settle.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  connections.forEach(({ socket }) => socket.disconnect());

  const sorted = [...latencies].sort((a, b) => a - b);
  const summary = {
    editors: EDITORS,
    durationSeconds: DURATION_SECONDS,
    opsSent: sent,
    opsAcked: latencies.length,
    errors,
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 99).toFixed(2)),
    maxMs: Number((sorted[sorted.length - 1] ?? NaN).toFixed(2)),
  };
  console.log("RESULT_JSON:" + JSON.stringify(summary));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
