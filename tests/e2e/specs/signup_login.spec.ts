import { test, expect, randomUserData, getEditorText, waitForSaved } from "../fixtures.ts";

test.describe("signup_login", () => {
  test("sign up drives to a protected route and document content persists across reload", async ({
    page,
  }) => {
    const data = randomUserData("signup");

    await page.goto("/register");
    await page.getByLabel("Display name").fill(data.displayName);
    await page.getByLabel("Username").fill(data.username);
    await page.getByLabel("Email").fill(data.email);
    await page.getByLabel("Password").fill(data.password);
    await page.getByRole("button", { name: "Create account" }).click();

    // Signup logs in and lands on the protected dashboard — proves both the account was
    // created AND the session cookie actually authorizes the protected route.
    await expect(page).toHaveURL(/\/documents$/);

    // A brand-new account has zero documents, so the dashboard shows its empty-state CTA
    // ("Create your first document") rather than the grid's "New document" card.
    await page.getByRole("button", { name: "Create your first document" }).click();
    await expect(page).toHaveURL(/\/documents\/[^/]+$/);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    const content = "Persisted after reload — signup_login spec";
    await editor.pressSequentially(content, { delay: 15 });
    await waitForSaved(page);

    await page.reload();
    await expect(page.locator(".ProseMirror").first()).toBeVisible();
    await expect(async () => {
      expect(await getEditorText(page)).toBe(content);
    }).toPass({ timeout: 5000 });
  });

  test("an unauthenticated visitor hitting a protected route is redirected to login", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto("/documents");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fdocuments/);
  });
});
