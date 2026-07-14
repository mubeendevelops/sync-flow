/**
 * Chaos-testing client: connects once, joins a document, and keeps sending one edit/sec
 * indefinitely while logging each outcome (ok/error/timeout) with a wall-clock timestamp, so
 * the log can be correlated against exactly when an infra dependency was killed/restored.
 * Also attempts a fresh `join` (simulating a second/reconnecting client) once every 5s.
 *
 * Usage: dotenv -e ../../.env -- tsx loadtest/chaos-client.ts [serverUrl]
 */
import crypto from "node:crypto";
import pg from "pg";
import { io } from "socket.io-client";
import { RGADocument, localInsert } from "@sync-flow/crdt";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/users.repo.js";
import { assignPresenceColor } from "../src/auth/presence-color.js";
import { signAccessToken } from "../src/auth/tokens.js";

const SERVER_URL = process.argv[2] ?? "http://localhost:4000";
const RUN_ID = Date.now();

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  if (!databaseUrl || !jwtAccessSecret) throw new Error("missing DATABASE_URL/JWT_ACCESS_SECRET");
  const db = new pg.Pool({ connectionString: databaseUrl });

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword("Chaos-Test-9!");
  const user = await insertUser(db, {
    id,
    username: `chaos-${RUN_ID}`,
    email: `chaos-${RUN_ID}@loadtest.local`,
    passwordHash,
    displayName: "Chaos Tester",
    presenceColor: assignPresenceColor(id),
  });
  const accessToken = signAccessToken(user.id, jwtAccessSecret, 3600);

  const docRes = await fetch(`${SERVER_URL}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `access_token=${accessToken}` },
    body: JSON.stringify({ title: `Chaos ${RUN_ID}` }),
  });
  const { document } = (await docRes.json()) as { document: { id: string } };
  log(`created document ${document.id}`);

  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    extraHeaders: { Cookie: `access_token=${accessToken}` },
    reconnection: true,
  });
  socket.on("connect", () => log("socket connected"));
  socket.on("disconnect", (reason) => log(`socket disconnected: ${reason}`));
  socket.on("connect_error", (err) => log(`connect_error: ${err.message}`));

  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });

  const doc = await new Promise<RGADocument>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("join timed out")), 8000);
    socket.emit(
      "join",
      { documentId: document.id },
      (res: { ok: boolean; data?: { snapshot: unknown }; error?: unknown }) => {
        clearTimeout(timeout);
        if (!res.ok) {
          reject(new Error(JSON.stringify(res.error)));
          return;
        }
        resolve(
          RGADocument.fromSnapshot(res.data!.snapshot as never, {
            replicaId: crypto.randomUUID(),
            authorId: user.id,
          }),
        );
      },
    );
  });
  log("joined document — starting steady-state 1 edit/sec");

  setInterval(() => {
    const op = localInsert(doc, doc.length, "x");
    const t0 = Date.now();
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        log(`edit TIMEOUT after ${Date.now() - t0}ms (no ack in 5s)`);
      }
    }, 5000);
    socket.emit("edit", { ops: [op] }, (res: { ok: boolean; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (res.ok) log(`edit ok (${Date.now() - t0}ms)`);
      else log(`edit ERROR (${Date.now() - t0}ms): ${JSON.stringify(res.error)}`);
    });
  }, 1000);

  // Every 5s, simulate a second client trying to freshly join the same document — this is
  // the operation most likely to be blocked entirely by a dependency outage (auth DB lookup +
  // presence Redis write both happen inline in the join handshake).
  setInterval(() => {
    const probe = io(SERVER_URL, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `access_token=${accessToken}` },
    });
    const t0 = Date.now();
    probe.on("connect", () => {
      const timeout = setTimeout(() => {
        log(`fresh JOIN TIMEOUT after ${Date.now() - t0}ms (no ack in 5s)`);
        probe.disconnect();
      }, 5000);
      probe.emit("join", { documentId: document.id }, (res: { ok: boolean; error?: unknown }) => {
        clearTimeout(timeout);
        if (res.ok) log(`fresh join ok (${Date.now() - t0}ms)`);
        else log(`fresh join ERROR (${Date.now() - t0}ms): ${JSON.stringify(res.error)}`);
        probe.disconnect();
      });
    });
    probe.on("connect_error", (err) =>
      log(`fresh join connect_error (${Date.now() - t0}ms): ${err.message}`),
    );
  }, 5000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
