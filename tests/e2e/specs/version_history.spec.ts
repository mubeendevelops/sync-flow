import {
  test,
  expect,
  createDocument,
  inviteUser,
  openDocument,
  waitForParticipantCount,
  waitForEditorText,
  waitForConvergence,
  waitForVersion,
  editorLocator,
  appendText,
  getEditorText,
} from "../fixtures.ts";

test.describe("version_history", () => {
  test("a triggered snapshot can be viewed and restored, converging both clients", async ({
    userA,
    userB,
  }) => {
    test.setTimeout(60_000);

    const documentId = await createDocument(userA, "version_history doc");
    await inviteUser(userA, documentId, userB, "editor");
    await openDocument(userA.page, documentId);
    await openDocument(userB.page, documentId);
    await waitForParticipantCount(userA.page, 2);
    await waitForParticipantCount(userB.page, 2);

    // Exactly 100 ops crosses the snapshot policy's `everyOps` threshold (see
    // snapshot-policy.ts), triggering an automatic snapshot that captures precisely this text.
    const snapshotText = Array.from({ length: 100 }, (_, i) => "0123456789"[i % 10]).join("");
    await editorLocator(userA.page).click();
    await editorLocator(userA.page).pressSequentially(snapshotText, { delay: 15 });
    await waitForEditorText(userB.page, snapshotText, 10_000);

    // Confirm the snapshot actually landed durably (persistence is batched up to ~250ms
    // behind the ack) before editing further and before touching the history UI.
    await waitForVersion(userA, documentId, (v) => v.textLength === snapshotText.length, 10_000);

    // Diverge from the snapshotted text so restoring is a real, observable change.
    await appendText(userA.page, "-EXTRA-");
    const currentText = snapshotText + "-EXTRA-";
    await waitForEditorText(userA.page, currentText, 10_000);
    await waitForEditorText(userB.page, currentText, 10_000);

    await userA.page.getByRole("button", { name: "History" }).click();
    const firstRow = userA.page.locator("ul > li").first();
    await firstRow.getByRole("button", { name: "View" }).click();

    await userA.page.getByRole("button", { name: /Restore this version/ }).click();
    await userA.page.getByRole("button", { name: "Restore", exact: true }).click();

    await expect(userA.page.getByText("Document restored")).toBeVisible({ timeout: 10_000 });

    const converged = await waitForConvergence(
      [() => getEditorText(userA.page), () => getEditorText(userB.page)],
      10_000,
    );
    expect(converged).toBe(snapshotText);
  });
});
