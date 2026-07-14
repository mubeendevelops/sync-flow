/** One-shot: reconnect a given user against a given instance and print the joined doc's text. */
import { io } from "socket.io-client";
import { RGADocument } from "@sync-flow/crdt";
import { signAccessToken } from "../src/auth/tokens.js";

const [, , userId, documentId, url] = process.argv;
const jwtAccessSecret = process.env.JWT_ACCESS_SECRET!;
const accessToken = signAccessToken(userId!, jwtAccessSecret, 3600);

const socket = io(url!, {
  transports: ["websocket"],
  extraHeaders: { Cookie: `access_token=${accessToken}` },
});
socket.on("connect", () => {
  socket.emit(
    "join",
    { documentId },
    (res: { ok: boolean; data?: { snapshot: unknown }; error?: unknown }) => {
      if (!res.ok) {
        console.error("join failed", res.error);
        process.exit(1);
      }
      const text = RGADocument.fromSnapshot(res.data!.snapshot as never, {
        replicaId: "verify",
        authorId: "verify",
      }).text();
      console.log(`RECONNECT_TEXT_LENGTH:${text.length}`);
      console.log(`RECONNECT_TEXT_SAMPLE:${text.slice(0, 60)}...${text.slice(-40)}`);
      const aCount = [...text].filter((c) => c === "A").length;
      const bCount = [...text].filter((c) => c === "B").length;
      console.log(`RECONNECT_A_COUNT:${aCount}`);
      console.log(`RECONNECT_B_COUNT:${bCount}`);
      process.exit(0);
    },
  );
});
socket.on("connect_error", (err) => {
  console.error("connect_error", err.message);
  process.exit(1);
});
