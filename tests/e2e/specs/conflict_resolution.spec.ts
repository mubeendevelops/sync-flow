import {
  test,
  expect,
  createDocument,
  inviteUser,
  openDocument,
  typeIntoEditor,
  waitForSaved,
  waitForParticipantCount,
  waitForConvergence,
  waitForEditorText,
  selectRange,
  placeCaretAt,
  getEditorText,
} from "../fixtures.ts";

test.describe("conflict_resolution", () => {
  test("concurrent delete of chars 10-20 and insert of 'hello' at 15 converge identically", async ({
    userA,
    userB,
  }) => {
    const documentId = await createDocument(userA, "conflict_resolution doc");
    await inviteUser(userA, documentId, userB, "editor");
    await openDocument(userA.page, documentId);

    // Single unwrapped line, 30 chars, distinct positions — deleteRange/insertTextAt navigate
    // by logical index via Home + ArrowRight, which only stays reliable on one visual line.
    const base = Array.from({ length: 30 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    await typeIntoEditor(userA.page, base, 10);
    await waitForSaved(userA.page);

    await openDocument(userB.page, documentId);
    await waitForParticipantCount(userA.page, 2);
    await waitForParticipantCount(userB.page, 2);
    // Participant count only proves the join round-trip finished — the join snapshot can
    // still be hydrating into userB's editor a beat later (see use-document-editor.ts's
    // pendingSnapshotRef path). deleteRange/insertTextAt navigate by logical character index,
    // so they need userB's copy of `base` on screen first, not just "joined".
    await waitForEditorText(userB.page, base, 5000);

    // Position both carets BEFORE racing the actual edits — placing a caret is several
    // keystrokes (Home + N × ArrowRight), and if that navigation itself straddles the window
    // where the other side's concurrent op lands, a mid-navigation remote edit reshuffles
    // positions out from under it (ArrowRight is a relative nudge, not an absolute jump). The
    // concurrency this test cares about is A's delete op racing B's insert op, not Playwright's
    // keystroke timing racing itself.
    await selectRange(userA.page, 10, 20); // A selects the 10 chars at [10, 20)
    await placeCaretAt(userB.page, 15); // B's caret at position 15

    await Promise.all([
      userA.page.keyboard.press("Backspace"), // A deletes its selection
      userB.page.keyboard.insertText("hello"), // B inserts "hello"
    ]);

    const converged = await waitForConvergence(
      [() => getEditorText(userA.page), () => getEditorText(userB.page)],
      5000,
    );

    // 30 base - 10 deleted + 5 inserted = 25, regardless of how the CRDT interleaved the
    // concurrent delete/insert — both counts are independent of delivery order.
    expect(converged.length).toBe(25);
    expect(converged).toContain("hello");
  });
});
