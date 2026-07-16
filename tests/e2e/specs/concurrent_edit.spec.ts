import {
  test,
  expect,
  createDocument,
  inviteUser,
  openDocument,
  waitForParticipantCount,
  waitForConvergence,
  getEditorText,
  editorLocator,
} from "../fixtures.ts";

test.describe("concurrent_edit", () => {
  test("both users typing 50 chars at once converges to byte-identical text on both clients", async ({
    userA,
    userB,
  }) => {
    const documentId = await createDocument(userA, "concurrent_edit doc");
    await inviteUser(userA, documentId, userB, "editor");

    await openDocument(userA.page, documentId);
    await openDocument(userB.page, documentId);
    // Wait for both sockets to have finished `join` before either types — typing before
    // hydrate completes is a real race (the join snapshot would overwrite it), not a test
    // artifact, so this is the correct readiness gate, not an arbitrary sleep.
    await waitForParticipantCount(userA.page, 2);
    await waitForParticipantCount(userB.page, 2);

    const aEditor = editorLocator(userA.page);
    const bEditor = editorLocator(userB.page);
    await aEditor.click();
    await bEditor.click();

    const textA = "A".repeat(50);
    const textB = "B".repeat(50);

    await Promise.all([
      aEditor.pressSequentially(textA, { delay: 15 }),
      bEditor.pressSequentially(textB, { delay: 15 }),
    ]);

    const converged = await waitForConvergence(
      [() => getEditorText(userA.page), () => getEditorText(userB.page)],
      5000,
    );

    expect(converged.length).toBe(100);
    expect(converged.split("").filter((c) => c === "A").length).toBe(50);
    expect(converged.split("").filter((c) => c === "B").length).toBe(50);
  });
});
