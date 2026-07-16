import {
  test,
  createDocument,
  inviteUser,
  openDocument,
  waitForParticipantCount,
  waitForEditorText,
  editorLocator,
  appendText,
} from "../fixtures.ts";

test.describe("undo_collaborative", () => {
  test("A's undo removes only A's own last edit, leaving B's edit intact on both clients", async ({
    userA,
    userB,
  }) => {
    const documentId = await createDocument(userA, "undo_collaborative doc");
    await inviteUser(userA, documentId, userB, "editor");
    await openDocument(userA.page, documentId);
    await openDocument(userB.page, documentId);
    await waitForParticipantCount(userA.page, 2);
    await waitForParticipantCount(userB.page, 2);

    // `Keyboard.insertText` fires a single input event, so "foo" becomes exactly one CRDT
    // edit batch and therefore exactly one undo unit — one Ctrl+Z removes the whole word,
    // not just its last character (which is what per-keystroke typing would produce).
    await editorLocator(userA.page).click();
    await userA.page.keyboard.insertText("foo");
    await waitForEditorText(userB.page, "foo", 5000);

    await appendText(userB.page, "bar");
    await waitForEditorText(userA.page, "foobar", 5000);
    await waitForEditorText(userB.page, "foobar", 5000);

    await editorLocator(userA.page).click();
    await userA.page.keyboard.press("Control+z");

    // Undo is server-authoritative and broadcast to the WHOLE room including the caller
    // (unlike a normal edit), so both clients converge to "bar" via the same code path.
    await waitForEditorText(userA.page, "bar", 5000);
    await waitForEditorText(userB.page, "bar", 5000);
  });
});
