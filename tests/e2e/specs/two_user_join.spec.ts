import {
  test,
  createDocument,
  inviteUser,
  openDocument,
  typeIntoEditor,
  waitForSaved,
  waitForEditorText,
} from "../fixtures.ts";

test.describe("two_user_join", () => {
  test("userB joins after being invited and sees userA's existing text", async ({
    userA,
    userB,
  }) => {
    const documentId = await createDocument(userA, "two_user_join doc");
    await openDocument(userA.page, documentId);

    const content = "Written by userA before userB ever joins.";
    await typeIntoEditor(userA.page, content, 15);
    await waitForSaved(userA.page);

    await inviteUser(userA, documentId, userB, "editor");
    await openDocument(userB.page, documentId);

    await waitForEditorText(userB.page, content, 10_000);
  });
});
