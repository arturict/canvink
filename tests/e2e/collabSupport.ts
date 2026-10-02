/**
 * Helpers shared by the notebook-sharing specs (`collab-presence.spec.ts`,
 * `collab-join.spec.ts`). They run under
 * `tests/e2e/collab-sync.playwright.config.ts`, whose app build carries the e2e
 * auth seam (`src/auth/e2eTestAuth.ts`): `?__canvinkSpaceTestSub=` signs a
 * context in as a test identity the Worker accepts.
 */

import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { activeNotebookTitle, expect, openNotebookSwitcher, openTopbarMore, ribbonTab, test as baseTest, waitForSaved } from "./support";

/**
 * The shared runtime guard fails a test on any console error. While a
 * context is offline Chromium logs every WebSocket reconnect attempt as one
 * (`net::ERR_INTERNET_DISCONNECTED`); only that expected message is allowed.
 */
export const collabTest = baseTest.extend<{ runtimeGuard: void }>({
  runtimeGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack ?? error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (/^WebSocket connection to .* failed: .*ERR_INTERNET_DISCONNECTED/.test(message.text())) return;
        // The list of invitations is fetched in the background; offline it fails, and is fetched again later.
        if (/ERR_INTERNET_DISCONNECTED/.test(message.text()) && /\/api\/v1\/me\/invitations$/.test(message.location().url)) return;
        errors.push(`console.error: ${message.text()} (${message.location().url})`);
      });
      await use();
      expect(errors, "The browser emitted unexpected console or page errors").toEqual([]);
    },
    { auto: true },
  ],
});

/** Unique per call, so that two runs never share an account or an invited address. */
let identityCounter = 0;

/** One test identity: the query string that signs a context in as it. */
export interface TestIdentity {
  query: string;
  name: string;
  /** The account id the Worker sees (`sub` of the test token). */
  sub: string;
  /** A verified address of the account: invitations to it are claimed by this identity. */
  email: string;
}

export function makeIdentity(sub: string, name: string): TestIdentity {
  identityCounter += 1;
  const stamped = `${sub}-${Date.now()}-${identityCounter}`;
  const email = `${stamped}@canvink.test`;
  return {
    sub: stamped,
    name,
    email,
    query: `?__canvinkSpaceTestSub=${encodeURIComponent(stamped)}&__canvinkTestName=${encodeURIComponent(name)}&__canvinkTestEmail=${encodeURIComponent(email)}`,
  };
}

export async function openAs(page: Page, who: TestIdentity, hash = ""): Promise<void> {
  await page.goto(`/app${who.query}${hash}`, { waitUntil: "domcontentloaded" });
  await waitForSaved(page);
}

export const ROLE = { read: "Lesen", edit: "Bearbeiten", admin: "Admin" } as const;
export type RoleLabel = (typeof ROLE)[keyof typeof ROLE];

/** Opens the share dialog of the open notebook and starts sharing when it is not shared yet. */
export async function openShareDialog(page: Page): Promise<Locator> {
  await openTopbarMore(page);
  await page.getByRole("menuitem", { name: "Notizbuch teilen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Notizbuch teilen" });
  await expect(dialog).toBeVisible();
  const start = dialog.getByRole("button", { name: "Freigabe starten", exact: true });
  const invite = dialog.getByRole("button", { name: "Einladen", exact: true });
  await expect(start.or(invite)).toBeVisible({ timeout: 30_000 });
  if (await start.isVisible()) await start.click();
  await expect(invite).toBeVisible({ timeout: 30_000 });
  return dialog;
}

export async function closeShareDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Teilen schliessen" }).click();
  await expect(page.getByRole("dialog", { name: "Notizbuch teilen" })).toHaveCount(0);
}

/** Invites `email` with a role in an open share dialog and waits until the invitation is listed. */
export async function inviteInDialog(dialog: Locator, email: string, role: RoleLabel): Promise<void> {
  await dialog.getByPlaceholder("E-Mail-Adresse").fill(email);
  await dialog.getByLabel("Rolle der eingeladenen Person").selectOption({ label: role });
  await dialog.getByRole("button", { name: "Einladen", exact: true }).click();
  await expect(dialog.locator(`[data-share-invite="${email}"]`)).toBeVisible({ timeout: 20_000 });
}

/** Invites `who` to the open notebook from the owner's (or an admin's) page. */
export async function inviteAs(page: Page, who: TestIdentity, role: RoleLabel): Promise<void> {
  const dialog = await openShareDialog(page);
  await inviteInDialog(dialog, who.email, role);
  await closeShareDialog(page);
}

/** Sets "Allgemeiner Zugriff" in an open share dialog. */
export async function setGeneralAccess(dialog: Locator, access: "Nur eingeladene Personen" | "Alle mit dem Link — Lesen"): Promise<void> {
  await dialog.getByLabel("Allgemeiner Zugriff", { exact: true }).selectOption({ label: access });
}

/** Turns the read-only link on and returns its fragment (`#join=…`). */
export async function shareActiveNotebook(page: Page): Promise<string> {
  const dialog = await openShareDialog(page);
  await setGeneralAccess(dialog, "Alle mit dem Link — Lesen");
  const input = dialog.locator("#collab-share-url");
  await expect(input).toHaveValue(/#join=/, { timeout: 15_000 });
  const url = await input.inputValue();
  await closeShareDialog(page);
  return url.slice(url.indexOf("#"));
}

/**
 * Opens the app as `who`, opens the invitation to `notebookTitle` under "Mit dir geteilt" and waits
 * until the notebook is open in the normal app.
 */
export async function openInvitation(
  browser: Browser,
  who: TestIdentity,
  notebookTitle: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/app${who.query}`, { waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await acceptInvitation(page, notebookTitle);
  return { context, page };
}

/** Opens the invitation to `notebookTitle` in the notebook switcher of an open app. */
export async function acceptInvitation(page: Page, notebookTitle: string): Promise<void> {
  await expect(page.locator("[data-pending-invitations]")).toBeVisible({ timeout: 30_000 });
  const switcher = await openNotebookSwitcher(page);
  await expect(switcher.getByText("Mit dir geteilt", { exact: true })).toBeVisible();
  await switcher.getByRole("button", { name: `Einladung «${notebookTitle}» öffnen` }).click();
  await expect(activeNotebookTitle(page)).toHaveText(notebookTitle, { timeout: 45_000 });
  await waitForSaved(page);
}

/** Invites `who` from the owner's page, then opens the invitation as them in a fresh browser context. */
export async function joinAsInvited(
  browser: Browser,
  owner: Page,
  who: TestIdentity,
  notebookTitle: string,
  role: RoleLabel = ROLE.edit,
): Promise<{ context: BrowserContext; page: Page }> {
  await inviteAs(owner, who, role);
  return openInvitation(browser, who, notebookTitle);
}

/** The "Nur lesen" badge of a read-only notebook. */
export function readOnlyBadge(page: Page): Locator {
  return page.locator("[data-read-only-badge]");
}

// ---- Talking to the Worker the way a hostile client would ---------------------------------

const TEST_AUTH_SECRET = process.env.COLLAB_E2E_TEST_AUTH_SECRET ?? process.env.SPACE_E2E_TEST_AUTH_SECRET ?? "canvink-e2e-test-auth-secret";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The token the e2e auth seam gives `who` (the Worker's `testv2:` shim), for requests made outside the page. */
export async function tokenFor(who: TestIdentity): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ sub: who.sub, emails: [who.email], name: who.name })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TEST_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `testv2:${payload}:${toBase64Url(mac)}`;
}

/** The room a page joined or owns, read from its own storage. */
export async function roomIdOf(page: Page): Promise<string> {
  const roomId = await page.evaluate(() => {
    const read = (key: string): Record<string, { roomId?: string }> => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { roomId?: string }>;
      } catch {
        return {};
      }
    };
    const records = [...Object.values(read("canvink:collab:rooms:v1")), ...Object.values(read("canvink:collab:joined:v1"))];
    return records.find((record) => typeof record.roomId === "string")?.roomId ?? null;
  });
  if (!roomId) throw new Error("The page holds no room.");
  return roomId;
}

export function workerOrigin(): string {
  return `http://127.0.0.1:${process.env.PLAYWRIGHT_COLLAB_WORKER_PORT ?? process.env.PLAYWRIGHT_SPACE_WORKER_PORT ?? "8799"}`;
}

export interface RawSocket {
  role: string;
  errors: string[];
  closed: Promise<number>;
  send(frame: Record<string, unknown>): void;
  close(): void;
}

/** Opens a socket to a room with an arbitrary credential and resolves after the welcome (or rejects when refused). */
export async function rawSocket(roomId: string, auth: Record<string, unknown>): Promise<RawSocket> {
  const url = `${workerOrigin().replace("http", "ws")}/api/v1/rooms/${roomId}/ws`;
  const socket = new WebSocket(url);
  const errors: string[] = [];
  let resolveClosed: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => { resolveClosed = resolve; });
  socket.addEventListener("close", (event) => resolveClosed(event.code));
  return new Promise<RawSocket>((resolve, reject) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ t: "hello", auth, since: {} })));
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { t: string; role?: string; code?: string };
      if (frame.t === "error" && frame.code) errors.push(frame.code);
      if (frame.t === "welcome") {
        resolve({
          role: String(frame.role),
          errors,
          closed,
          send: (next) => socket.send(JSON.stringify(next)),
          close: () => socket.close(),
        });
      }
    });
    socket.addEventListener("close", (event) => reject(new Error(`The room refused the socket (code ${event.code}).`)));
    setTimeout(() => reject(new Error("The room did not answer in time.")), 15_000);
  });
}

/** An HTTP call to the room as `who`, outside the page. */
export async function roomRequest(
  roomId: string,
  who: TestIdentity,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${workerOrigin()}/api/v1/rooms/${roomId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await tokenFor(who)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Opens the share link in a fresh context as `who` and waits until the shared notebook is open in the normal app. */
export async function joinAs(
  browser: Browser,
  hash: string,
  who: TestIdentity,
  notebookTitle: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/app${who.query}${hash}`, { waitUntil: "domcontentloaded" });
  await expect(activeNotebookTitle(page)).toHaveText(notebookTitle, { timeout: 45_000 });
  await waitForSaved(page);
  return { context, page };
}

export function canvas(page: Page) {
  return page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });
}

export async function strokeCount(page: Page): Promise<number> {
  return Number(await canvas(page).getAttribute("data-ink-stroke-count"));
}

/** Presses, draws a wave and, unless `hold`, lifts the pen. */
export async function drawWave(page: Page, origin: { x: number; y: number }, hold = false): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("The canvas has no bounds.");
  await page.mouse.move(box.x + origin.x, box.y + origin.y);
  await page.mouse.down();
  for (let step = 1; step <= 24; step += 1) {
    await page.mouse.move(box.x + origin.x + step * 8, box.y + origin.y + Math.sin(step / 4) * 30);
  }
  if (!hold) await page.mouse.up();
}

export async function pickPen(page: Page): Promise<void> {
  const draw = await ribbonTab(page, "Zeichnen");
  await draw.getByRole("button", { name: "Stift", exact: true }).click();
}

export async function pageView(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const raw = await canvas(page).getAttribute("data-page-view");
  const [x, y, width, height] = (raw ?? "0,0,0,0").split(",").map(Number);
  return { x, y, width, height };
}

export async function pageTitle(page: Page): Promise<string> {
  return page.getByLabel("Seitentitel").inputValue();
}

/** Opens a page of the open section by its title in the page list. */
export async function openPageByTitle(page: Page, title: string): Promise<void> {
  await page.locator(".page-row__target").filter({ has: page.locator(".page-row__title", { hasText: new RegExp(`^${title}$`) }) }).first().click();
  await expect.poll(() => pageTitle(page)).toBe(title);
}
