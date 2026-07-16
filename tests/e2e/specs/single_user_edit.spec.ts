import { test, createDocument, openDocument, waitForSaved, waitForEditorText } from "../fixtures.ts";

test.describe("single_user_edit", () => {
  test("typing 500 characters survives a reload identically", async ({ userA }) => {
    test.setTimeout(60_000);

    const documentId = await createDocument(userA, "single_user_edit doc");
    await openDocument(userA.page, documentId);

    // Deterministic 500-char payload — easy to eyeball a mismatch in a diff.
    const content = Array.from({ length: 500 }, (_, i) => "abcdefghij"[i % 10]).join("");

    const editor = userA.page.locator(".ProseMirror").first();
    await editor.click();
    // delay:20ms (~50 chars/sec) matches the per-socket op bucket's sustained refill rate
    // (see rate-limit.ts) — real keystroke pacing, not an artificial slowdown for the test.
    await editor.pressSequentially(content, { delay: 20 });

    await waitForSaved(userA.page);
    await waitForEditorText(userA.page, content, 10_000);

    await userA.page.reload();
    await waitForEditorText(userA.page, content, 10_000);
  });
});
