import {
  test,
  expect,
  createDocument,
  inviteUser,
  openDocument,
  waitForParticipantCount,
  editorLocator,
} from "../fixtures.ts";

test.describe("presence_cursors", () => {
  test("userB sees userA's cursor decoration appear within 1s of userA moving it", async ({
    userA,
    userB,
  }) => {
    const documentId = await createDocument(userA, "presence_cursors doc");
    await inviteUser(userA, documentId, userB, "editor");
    await openDocument(userA.page, documentId);
    await openDocument(userB.page, documentId);
    await waitForParticipantCount(userA.page, 2);
    await waitForParticipantCount(userB.page, 2);

    // userB shouldn't see a caret for a peer who hasn't moved yet.
    await expect(userB.page.locator(".remote-caret")).toHaveCount(0);

    await editorLocator(userA.page).click();
    await editorLocator(userA.page).pressSequentially("hi", { delay: 15 });

    // Not `.toBeVisible()`: the caret is a 0-width element that renders its visible 2px bar
    // via `border-left` (see globals.css), so Playwright's bounding-box visibility check
    // reads it as hidden even though it's really on screen. Presence is what matters here.
    await expect(userB.page.locator(".remote-caret")).toHaveCount(1, { timeout: 1000 });
  });
});
