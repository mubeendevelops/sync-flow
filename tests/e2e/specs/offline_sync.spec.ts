import {
  test,
  expect,
  createDocument,
  inviteUser,
  openDocument,
  waitForParticipantCount,
  waitForConvergence,
  waitForSaved,
  getConnectionPillText,
  getEditorText,
  editorLocator,
  trackWebSockets,
  forceDisconnect,
} from "../fixtures.ts";

test.describe("offline_sync", () => {
  test("userA edits offline, userB edits online, both converge once userA reconnects", async ({
    userA,
    userB,
  }) => {
    test.setTimeout(30_000);

    // Must be registered before userA's page ever navigates, so it's in place before the app
    // opens its socket.io WebSocket.
    await trackWebSockets(userA.page);

    const documentId = await createDocument(userA, "offline_sync doc");
    await inviteUser(userA, documentId, userB, "editor");
    await openDocument(userA.page, documentId);
    await openDocument(userB.page, documentId);
    await waitForParticipantCount(userA.page, 2);
    await waitForParticipantCount(userB.page, 2);

    await userA.page.locator(".ProseMirror").first().click();
    // `context.setOffline` alone blocks new connections but does not sever an already-open
    // WebSocket (verified against this app), so it never triggers a real disconnect on its
    // own — `forceDisconnect` closes the live socket for real; `setOffline` then keeps the
    // ensuing reconnect attempts failing until we flip it back.
    await userA.context.setOffline(true);
    await forceDisconnect(userA.page);
    await expect(async () => {
      expect(await getConnectionPillText(userA.page)).toContain("Offline");
    }).toPass({ timeout: 5000 });

    const textA = "1".repeat(20);
    const textB = "2".repeat(20);

    // userA's keystrokes apply optimistically to its own local CRDT/editor even while
    // offline (they just queue for send) — userB is still connected and its edits reach
    // the server (and userA, once it reconnects) normally.
    await Promise.all([
      editorLocator(userA.page).pressSequentially(textA, { delay: 15 }),
      editorLocator(userB.page).pressSequentially(textB, { delay: 15 }),
    ]);

    await userA.context.setOffline(false);
    // Confirms userA's queued offline edits actually reached and were persisted by the
    // server (the reconnect flow's flush-outbound step), not just that the pill flipped.
    await waitForSaved(userA.page, 15_000);

    // This server instance is shared by every spec running in this worker pool, and
    // `document_operations.seq` is a single global BIGSERIAL (CLAUDE.md's own design, not
    // per-document) — so an unrelated, concurrently-running spec's op volume can push the
    // "how far behind is userA" gap over the sync threshold purely by coincidence, which
    // routes the live reconnect down the app's documented (and intentionally out-of-v1-scope)
    // "snapshot fallback — reload to recover" path instead of a seamless in-place catch-up
    // (see the comment on `requestSync` in use-websocket.ts). A reload always does a plain
    // first-time join + hydrate from the current snapshot, sidestepping that branch entirely,
    // and is exactly the recovery action the app's own UI leaves available — so it's a
    // legitimate way to assert the underlying promise this test cares about (offline edits +
    // a peer's edits both survive and converge), independent of which reconnect path fired.
    await userA.page.reload();
    await waitForParticipantCount(userA.page, 2);

    const converged = await waitForConvergence(
      [() => getEditorText(userA.page), () => getEditorText(userB.page)],
      15_000,
    );

    expect(converged.length).toBe(40);
    expect(converged.split("").filter((c) => c === "1").length).toBe(20);
    expect(converged.split("").filter((c) => c === "2").length).toBe(20);
  });
});
