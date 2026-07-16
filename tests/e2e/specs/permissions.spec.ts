import {
  test,
  expect,
  createDocument,
  inviteUser,
  openDocument,
  typeIntoEditor,
  waitForSaved,
  editorLocator,
  connectRawSocket,
  rawJoin,
  rawEdit,
  makeInsertOp,
} from "../fixtures.ts";

test.describe("permissions", () => {
  test("a viewer's edit op is rejected by the server and the document stays unchanged", async ({
    userA,
    userB,
  }) => {
    const documentId = await createDocument(userA, "permissions doc");
    const original = "Editor content unchanged";
    await openDocument(userA.page, documentId);
    await typeIntoEditor(userA.page, original, 15);
    await waitForSaved(userA.page);

    await inviteUser(userA, documentId, userB, "viewer");
    await openDocument(userB.page, documentId);

    // The UI itself never offers an edit affordance to a viewer — the editor mounts
    // non-editable, so this isn't a race with async role resolution.
    await expect(editorLocator(userB.page)).toHaveAttribute("contenteditable", "false");

    // Prove the SERVER (not just the UI) enforces this: attempt an edit directly over the
    // wire as the viewer, bypassing the app entirely.
    const socket = await connectRawSocket(userB);
    try {
      const joined = await rawJoin(socket, documentId);
      expect(joined.ok).toBe(true);
      if (joined.ok) expect(joined.data.role).toBe("viewer");

      const result = await rawEdit(socket, [makeInsertOp(userB.userId)]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(403);
    } finally {
      socket.disconnect();
    }

    // Give a rejected-but-somehow-still-applied op every chance to show up before asserting
    // it didn't — this is a bounded settle window for a negative assertion, not a readiness
    // sleep standing in for a real signal (there's no "op was rejected" event to await).
    await userA.page.waitForTimeout(500);
    await expect(editorLocator(userA.page)).toHaveText(original);
  });
});
