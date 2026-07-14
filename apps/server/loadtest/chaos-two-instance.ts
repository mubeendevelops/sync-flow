/**
 * Two-instance chaos scenario: client A on instance 1 (port 4000), client B on instance 2
 * (port 4001), sharing the same Postgres+Redis. Both edit the same document continuously.
 * Run this, then kill instance 1's process externally and watch the log — client B should
 * keep working uninterrupted (Redis adapter fan-out is instance-to-instance, not
 * instance-to-client, so B never depended on instance 1 being alive), client A should
 * disconnect and be able to reconnect against instance 2 and see everything B typed,
 * including while instance 1 was down.
 *
 * Usage: dotenv -e ../../.env -- tsx loadtest/chaos-two-instance.ts
 */
import crypto from "node:crypto";
import pg from "pg";
import { io, type Socket } from "socket.io-client";
import { RGADocument, localInsert } from "@sync-flow/crdt";
import { hashPassword } from "../src/auth/passwords.js";
import { insertUser } from "../src/auth/users.repo.js";
import { assignPresenceColor } from "../src/auth/presence-color.js";
import { signAccessToken } from "../src/auth/tokens.js";

const INSTANCE_1 = "http://localhost:4000";
const INSTANCE_2 = "http://localhost:4001";
const RUN_ID = Date.now();

function log(who: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${who}] ${msg}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
  if (!databaseUrl || !jwtAccessSecret) throw new Error("missing DATABASE_URL/JWT_ACCESS_SECRET");
  const db = new pg.Pool({ connectionString: databaseUrl });

  async function provisionUser(username: string) {
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword("Chaos-Two-9!");
    const user = await insertUser(db, {
      id,
      username,
      email: `${username}@loadtest.local`,
      passwordHash,
      displayName: username,
      presenceColor: assignPresenceColor(id),
    });
    const accessToken = signAccessToken(user.id, jwtAccessSecret, 3600);
    return { userId: user.id, accessToken };
  }

  const owner = await provisionUser(`ti-owner-${RUN_ID}`);
  const collaborator = await provisionUser(`ti-collab-${RUN_ID}`);

  const docRes = await fetch(`${INSTANCE_1}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `access_token=${owner.accessToken}` },
    body: JSON.stringify({ title: `Two Instance ${RUN_ID}` }),
  });
  const { document } = (await docRes.json()) as { document: { id: string } };
  log("setup", `created document ${document.id}`);

  await fetch(`${INSTANCE_1}/api/v1/documents/${document.id}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `access_token=${owner.accessToken}` },
    body: JSON.stringify({ email: `ti-collab-${RUN_ID}@loadtest.local`, role: "editor" }),
  });

  function connectAndJoin(
    who: string,
    url: string,
    session: { userId: string; accessToken: string },
  ): Promise<{ socket: Socket; doc: RGADocument }> {
    const socket = io(url, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `access_token=${session.accessToken}` },
      reconnection: false,
    });
    socket.on("disconnect", (reason) => log(who, `disconnected: ${reason}`));
    return new Promise((resolve, reject) => {
      socket.on("connect_error", (err) => reject(err));
      socket.on("connect", () => {
        socket.emit(
          "join",
          { documentId: document.id },
          (res: { ok: boolean; data?: { snapshot: unknown }; error?: unknown }) => {
            if (!res.ok) {
              reject(new Error(JSON.stringify(res.error)));
              return;
            }
            log(who, "joined");
            resolve({
              socket,
              doc: RGADocument.fromSnapshot(res.data!.snapshot as never, {
                replicaId: crypto.randomUUID(),
                authorId: session.userId,
              }),
            });
          },
        );
      });
    });
  }

  const a = await connectAndJoin("A@inst1", INSTANCE_1, owner);
  const b = await connectAndJoin("B@inst2", INSTANCE_2, collaborator);

  b.socket.on("operation", (payload: { ops: unknown[] }) => {
    log("B@inst2", `received ${payload.ops.length} op(s) relayed from instance 1`);
  });
  a.socket.on("operation", (payload: { ops: unknown[] }) => {
    log("A@inst1", `received ${payload.ops.length} op(s) relayed from instance 2`);
  });

  function startTyping(
    who: string,
    conn: { socket: Socket; doc: RGADocument },
    char: string,
  ): void {
    setInterval(() => {
      const op = localInsert(conn.doc, conn.doc.length, char);
      conn.socket.emit("edit", { ops: [op] }, (res: { ok: boolean }) => {
        if (!res.ok) log(who, "edit FAILED");
      });
    }, 1000);
  }

  startTyping("A@inst1", a, "A");
  startTyping("B@inst2", b, "B");

  log("setup", "steady state — both instances typing. Kill instance 1 externally now.");

  // Run indefinitely; the operator kills instance 1's process and watches the log, then
  // this script is stopped once the scenario has been observed.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
