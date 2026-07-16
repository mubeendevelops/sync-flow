/**
 * Shared Playwright fixtures + helpers for the multi-user collaboration suite.
 *
 * `userA`/`userB` are authenticated (real signup via the REST API, not the UI — see
 * signup_login.spec.ts for the one spec that drives the actual signup form) browser contexts,
 * each with their own `page`. Auth is via httpOnly cookies that `context.request` and any
 * `page` created from the same `BrowserContext` share automatically, so signing up through
 * `context.request` is enough to make subsequent `page.goto()` calls land authenticated.
 *
 * Every test gets its own fresh users AND its own fresh document — nothing here is shared
 * mutable state, so specs are safe to run fully parallel (see playwright.config.ts).
 */
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { ROOT, OP_VERSION, type Op } from "@sync-flow/crdt";
import { API_URL, WEB_URL } from "./env.ts";

export { expect };
export { API_URL, WEB_URL };

// ---- users ------------------------------------------------------------------------------

export interface AuthedUser {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly userId: string;
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
}

let uidCounter = 0;

/** Short, collision-safe suffix — unique per process (counter) and per run (timestamp). */
function uniqueSuffix(): string {
  uidCounter += 1;
  return `${Date.now().toString(36)}${uidCounter}${Math.random().toString(36).slice(2, 6)}`;
}

export function randomUserData(label: string): Omit<AuthedUser, "context" | "page" | "userId"> {
  const suffix = uniqueSuffix();
  const safeLabel = label.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "user";
  return {
    email: `e2e-${safeLabel}-${suffix}@example.com`,
    username: `e2e${safeLabel}${suffix}`.slice(0, 32),
    displayName: `E2E ${label} ${suffix}`,
    // Satisfies packages/schemas' passwordSchema: 10-128 chars, lower/upper/digit/symbol.
    password: "TestPass123!",
  };
}

/** Sign up a brand-new user directly via the REST API and hand back an authenticated context. */
export async function createAuthedUser(
  browser: Browser,
  label = "user",
): Promise<AuthedUser> {
  const data = randomUserData(label);
  const context = await browser.newContext();
  const res = await context.request.post(`${API_URL}/api/v1/auth/signup`, {
    data: {
      username: data.username,
      email: data.email,
      password: data.password,
      displayName: data.displayName,
    },
  });
  if (!res.ok()) {
    throw new Error(`signup failed for ${data.email}: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { user: { id: string } };
  const page = await context.newPage();
  return { context, page, userId: body.user.id, ...data };
}

export async function createManyUsers(
  browser: Browser,
  count: number,
  labelPrefix = "u",
): Promise<AuthedUser[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) => createAuthedUser(browser, `${labelPrefix}${i}`)),
  );
}

export async function closeUser(user: AuthedUser): Promise<void> {
  await user.context.close();
}

// ---- documents ----------------------------------------------------------------------------

export async function createDocument(owner: AuthedUser, title = "E2E Doc"): Promise<string> {
  const res = await owner.context.request.post(`${API_URL}/api/v1/documents`, {
    data: { title },
  });
  if (!res.ok()) {
    throw new Error(`create document failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

export async function inviteUser(
  owner: AuthedUser,
  documentId: string,
  invitee: AuthedUser,
  role: "editor" | "viewer" = "editor",
): Promise<void> {
  const res = await owner.context.request.post(
    `${API_URL}/api/v1/documents/${documentId}/invite`,
    { data: { email: invitee.email, role } },
  );
  if (!res.ok()) {
    throw new Error(`invite failed: ${res.status()} ${await res.text()}`);
  }
}

export async function openDocument(page: Page, documentId: string): Promise<void> {
  await page.goto(`${WEB_URL}/documents/${documentId}`);
  await page.locator(".ProseMirror").first().waitFor({ state: "visible" });
}

// ---- editor interaction ---------------------------------------------------------------------

/** The TipTap/ProseMirror contenteditable root — present (read-only) for viewers too. */
export function editorLocator(page: Page) {
  return page.locator(".ProseMirror").first();
}

/**
 * The editor's plain text — NOT a plain `.textContent()` read. Remote peers' cursor carets
 * (`lib/remote-cursors.ts`) render as inline ProseMirror widget decorations, including a
 * name-label span, directly inside `.ProseMirror`'s DOM; a naive `.textContent()` silently
 * picks up "PeerDisplayName" as if it were document text the moment any peer has a cursor
 * position (i.e. in nearly every multi-user spec). Strip `.remote-caret` nodes first.
 */
export async function getEditorText(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".remote-caret").forEach((node) => node.remove());
    return clone.textContent ?? "";
  });
}

/** Click into the editor (wherever the caret ends up) and type, e.g. appending to an
 * empty doc. For inserting at a specific index, use `placeCaretAt` + `page.keyboard.type`. */
export async function typeIntoEditor(page: Page, text: string, delay = 20): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially(text, { delay });
}

/**
 * Move the caret to a specific character index (0 = document start) via Home + ArrowRight,
 * which is a logical-position move as long as the content is a single unwrapped line — every
 * spec that needs positional editing keeps its seed text short enough not to wrap in the
 * ~700px editor column. Avoids depending on any internal ProseMirror/ CRDT API from outside
 * the app bundle.
 */
export async function placeCaretAt(page: Page, index: number): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowRight");
}

export async function selectRange(page: Page, from: number, to: number): Promise<void> {
  await placeCaretAt(page, from);
  for (let i = 0; i < to - from; i++) await page.keyboard.press("Shift+ArrowRight");
}

/** Delete the [from, to) character range via a real selection + Backspace. */
export async function deleteRange(page: Page, from: number, to: number): Promise<void> {
  await selectRange(page, from, to);
  await page.keyboard.press("Backspace");
}

/**
 * Insert `text` at a specific index as ONE atomic input event (`Keyboard.insertText` fires a
 * single `input` event, unlike `pressSequentially`'s one-event-per-key) — so it becomes exactly
 * one ProseMirror transaction, one CRDT `edit` batch, and (where it matters, e.g. undo) one
 * undo unit, regardless of string length. Bypasses the per-socket op-rate bucket and the
 * 256-ops-per-edit cap the same way a real paste would, so keep callers under that cap.
 */
export async function insertTextAt(page: Page, index: number, text: string): Promise<void> {
  await placeCaretAt(page, index);
  await page.keyboard.insertText(text);
}

/** Move the caret to the end of the (single-line) document and insert `text` atomically. */
export async function appendText(page: Page, text: string): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(text);
}

/**
 * Wait until the header's presence avatar stack reports exactly `count` participants — the
 * signal that this page's socket has finished `join` (and therefore CRDT hydrate). Typing
 * before join completes is a real race in the app (the join snapshot overwrites whatever was
 * typed in that window), so every multi-user spec waits on this before its first keystroke.
 */
export async function waitForParticipantCount(
  page: Page,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const label = `${count} ${count === 1 ? "person" : "people"} in this document`;
  await expect(page.getByRole("button", { name: label })).toBeVisible({ timeout: timeoutMs });
}

/**
 * `context.setOffline(true)` (CDP `Network.emulateNetworkConditions`) blocks NEW network
 * requests but — verified empirically against this app's socket.io connection — does NOT
 * sever an already-open WebSocket. Without a real close, the client has no way to notice
 * anything is wrong until engine.io's ping-timeout heartbeat eventually fires (tens of
 * seconds by default), so a short "go offline, edit, come back" test would never actually
 * exercise the reconnect/resync path. `trackWebSockets` must be called (via `page.addInitScript`,
 * so it's in place before the app's own JS runs) before the page navigates; `forceDisconnect`
 * then closes every tracked socket for real, immediately, from the test.
 */
export async function trackWebSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    (window as unknown as { __testSockets: WebSocket[] }).__testSockets = [];
    class Tracked extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as unknown as { __testSockets: WebSocket[] }).__testSockets.push(this);
      }
    }
    window.WebSocket = Tracked as unknown as typeof WebSocket;
  });
}

/** Immediately closes every WebSocket `trackWebSockets` has seen on this page — a real close
 * event, not the ambient-offline signal `context.setOffline` alone produces (see above). */
export async function forceDisconnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const ws of (window as unknown as { __testSockets: WebSocket[] }).__testSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  });
}

/** The header's connection/save pill text, e.g. "Saved", "Offline — edits saved locally". */
export async function getConnectionPillText(page: Page): Promise<string> {
  return (await page.locator('header [role="status"]').first().textContent()) ?? "";
}

// ---- convergence ---------------------------------------------------------------------------

/**
 * Poll every getter until they all return the same value (or the timeout elapses, in which
 * case the last-seen mismatch fails the assertion with a readable diff). This is the one
 * "wait" primitive every convergence test in this suite uses — no arbitrary sleeps.
 */
export async function waitForConvergence(
  getters: Array<() => Promise<string>>,
  timeoutMs = 5000,
): Promise<string> {
  let values: string[] = [];
  await expect(async () => {
    values = await Promise.all(getters.map((g) => g()));
    const [first, ...rest] = values;
    for (const v of rest) expect(v).toBe(first);
  }).toPass({ timeout: timeoutMs });
  return values[0]!;
}

export async function waitForText(getter: () => Promise<string>, expected: string, timeoutMs = 5000): Promise<void> {
  await expect(async () => {
    expect(await getter()).toBe(expected);
  }).toPass({ timeout: timeoutMs });
}

/** Poll one page's editor until its text matches `expected` exactly. */
export async function waitForEditorText(page: Page, expected: string, timeoutMs = 5000): Promise<void> {
  await waitForText(() => getEditorText(page), expected, timeoutMs);
}

/** The header pill reads "Saved" only once every outstanding edit ack has resolved — NOT proof
 * the durable write/snapshot landed (persistence is batched up to 250ms behind the ack, see
 * OpWriter's maxDelayMs), just that the client believes it has nothing left in flight. */
export async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect(async () => {
    expect(await getConnectionPillText(page)).toContain("Saved");
  }).toPass({ timeout: timeoutMs });
}

// ---- version history (REST) ---------------------------------------------------------------

export interface VersionListItem {
  readonly version: number;
  readonly kind: string;
  readonly textLength: number;
  readonly preview: string;
}

export async function listVersions(user: AuthedUser, documentId: string): Promise<VersionListItem[]> {
  const res = await user.context.request.get(`${API_URL}/api/v1/documents/${documentId}/versions`);
  if (!res.ok()) throw new Error(`list versions failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { versions: VersionListItem[] };
  return body.versions;
}

/**
 * Poll the REST versions list (not the UI panel) until `predicate` matches one. Snapshot
 * writes are batched up to ~250ms behind the edit ack (see OpWriter), so this is the reliable
 * way to know a triggered snapshot has actually landed durably before opening the history UI.
 */
export async function waitForVersion(
  user: AuthedUser,
  documentId: string,
  predicate: (v: VersionListItem) => boolean,
  timeoutMs = 10_000,
): Promise<VersionListItem> {
  let found: VersionListItem | undefined;
  await expect(async () => {
    const versions = await listVersions(user, documentId);
    found = versions.find(predicate);
    expect(found).toBeTruthy();
  }).toPass({ timeout: timeoutMs });
  return found!;
}

// ---- raw socket access (for testing server-side enforcement the UI can't even attempt) -----

type RawAck<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: number; readonly message: string } };

/**
 * A bare `socket.io-client` connection authenticated as `user`, bypassing the web app
 * entirely. Needed for permissions.spec.ts: a viewer's editor is never even rendered as
 * contenteditable (see documents/[id]/page.tsx), so the only way to prove the SERVER (not
 * just the UI) rejects a viewer's edit is to attempt one directly over the wire.
 */
export async function connectRawSocket(user: AuthedUser): Promise<Socket> {
  const cookies = await user.context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const socket = io(API_URL, {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookieHeader },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (err) => reject(err));
  });
  return socket;
}

function rawRequest<T>(socket: Socket, event: string, payload: unknown): Promise<RawAck<T>> {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err: Error | null, result: RawAck<T>) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export function rawJoin(
  socket: Socket,
  documentId: string,
): Promise<RawAck<{ role: string; seq: number }>> {
  return rawRequest(socket, "join", { documentId });
}

export function rawEdit(socket: Socket, ops: Op[]): Promise<RawAck<{ seq: number; count: number }>> {
  return rawRequest(socket, "edit", { ops });
}

/** A well-formed (schema-valid) insert op — used to prove the server's ROLE check rejects a
 * viewer's edit, as opposed to rejecting it for being malformed. */
export function makeInsertOp(authorId: string, value = "X"): Op {
  return {
    type: "insert",
    charId: { clock: 1, replicaId: crypto.randomUUID() },
    afterId: ROOT,
    value,
    authorId,
    timestamp: Date.now(),
    opVersion: OP_VERSION,
  };
}

// ---- fixtures ------------------------------------------------------------------------------

interface Fixtures {
  userA: AuthedUser;
  userB: AuthedUser;
}

export const test = base.extend<Fixtures>({
  userA: async ({ browser }, use) => {
    const user = await createAuthedUser(browser, "a");
    await use(user);
    await closeUser(user);
  },
  userB: async ({ browser }, use) => {
    const user = await createAuthedUser(browser, "b");
    await use(user);
    await closeUser(user);
  },
});
