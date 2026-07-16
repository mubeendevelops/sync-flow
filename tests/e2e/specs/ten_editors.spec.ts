import {
  test,
  expect,
  createManyUsers,
  createDocument,
  inviteUser,
  openDocument,
  waitForParticipantCount,
  waitForConvergence,
  getEditorText,
  editorLocator,
  closeUser,
} from "../fixtures.ts";

test.describe("ten_editors", () => {
  test("ten simultaneous editors each typing 10 chars all converge", async ({ browser }) => {
    test.setTimeout(90_000);

    const users = await createManyUsers(browser, 10, "ed");
    try {
      const owner = users[0]!;
      const documentId = await createDocument(owner, "ten_editors doc");
      await Promise.all(
        users.slice(1).map((u) => inviteUser(owner, documentId, u, "editor")),
      );

      await Promise.all(users.map((u) => openDocument(u.page, documentId)));
      await Promise.all(users.map((u) => waitForParticipantCount(u.page, 10, 20_000)));

      await Promise.all(
        users.map(async (u, i) => {
          const chunk = String.fromCharCode(65 + i).repeat(10); // 'A'..'J', 10 chars each
          const editor = editorLocator(u.page);
          await editor.click();
          await editor.pressSequentially(chunk, { delay: 15 });
        }),
      );

      const converged = await waitForConvergence(
        users.map((u) => () => getEditorText(u.page)),
        10_000,
      );

      expect(converged.length).toBe(100);
      for (let i = 0; i < 10; i++) {
        const letter = String.fromCharCode(65 + i);
        expect(converged.split("").filter((c) => c === letter).length).toBe(10);
      }
    } finally {
      await Promise.all(users.map(closeUser));
    }
  });
});
