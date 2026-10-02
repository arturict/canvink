/**
 * Who may do what in a shared notebook: invite by e-mail address with a role, change a role live,
 * remove a person, and what everybody with the link may do (read, never write). The room enforces
 * every rule; these tests drive the UI of two or three signed-in accounts and also talk to the
 * Worker the way a modified client would. Run under `collab-sync.playwright.config.ts`.
 */

import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  activeNotebookTitle,
  addTextFromRibbon,
  contextCommand,
  expect,
  notebookOption,
  openNotebookSwitcher,
  openTopbarMore,
  ribbonTab,
  submitInlineRename,
  waitForSaved,
} from "./support";
import {
  canvas,
  closeShareDialog,
  collabTest as test,
  drawWave,
  inviteAs,
  inviteInDialog,
  joinAs,
  makeIdentity,
  openAs,
  openInvitation,
  openShareDialog,
  pickPen,
  readOnlyBadge,
  rawSocket,
  roomIdOf,
  roomRequest,
  ROLE,
  setGeneralAccess,
  strokeCount,
  tokenFor,
  type TestIdentity,
} from "./collabSupport";

const SHOTS = "test-results/collab-shots";
const TEXT = "Inhalt für die Rollen.";

async function renameActiveNotebook(page: Page, title: string): Promise<void> {
  const current = ((await activeNotebookTitle(page).textContent()) ?? "").trim();
  const switcher = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, switcher, current), "Umbenennen");
  await submitInlineRename(page, title);
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText(title);
  if (await switcher.isVisible()) await page.keyboard.press("Escape");
}

/** Signs the owner in, names the notebook and puts one text on its page. */
async function prepareNotebook(page: Page, owner: TestIdentity, title: string): Promise<void> {
  await openAs(page, owner);
  await renameActiveNotebook(page, title);
  await addTextFromRibbon(page);
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeFocused();
  await editor.fill(TEXT);
  await page.getByLabel("Seitentitel").fill("Erste Seite");
  await waitForSaved(page);
}

function sharedText(page: Page) {
  return canvas(page).getByRole("textbox", { name: "Gemeinsamer Text" }).last();
}

/** The dialog row of a person, by the address or name it shows. */
function roleMenu(dialog: ReturnType<Page["locator"]>, name: string) {
  return dialog.getByLabel(`Rolle von ${name}`, { exact: true });
}

async function closeContexts(...contexts: Array<BrowserContext | undefined>): Promise<void> {
  for (const context of contexts) await context?.close().catch(() => undefined);
}

test.describe("who may do what in a shared notebook", () => {
  test("a person invited as reader sees the notebook read-only, and the room refuses what a modified client sends", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const title = "Rollen Lesen";
    await prepareNotebook(page, anna, title);

    // Anna invites Ben by address: nothing is sent, the invitation waits in the dialog.
    const dialog = await openShareDialog(page);
    await expect(dialog.getByRole("combobox", { name: "Allgemeiner Zugriff" })).toHaveValue("restricted");
    await page.screenshot({ path: `${SHOTS}/sharing-dialog-start.png` });
    await inviteInDialog(dialog, ben.email, ROLE.read);
    await expect(dialog.getByRole("list", { name: "Ausstehende Einladungen" })).toContainText(ben.email);
    await expect(dialog.locator("[data-share-owner]")).toContainText("Inhaber");
    await closeShareDialog(page);

    // Ben signs in with that address and finds the invitation in the notebook switcher.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guest = await context.newPage();
    try {
      await guest.goto(`/app${ben.query}`, { waitUntil: "domcontentloaded" });
      await waitForSaved(guest);
      await expect(guest.locator("[data-pending-invitations]")).toBeVisible({ timeout: 30_000 });
      const switcher = await openNotebookSwitcher(guest);
      await expect(switcher.getByText("Mit dir geteilt", { exact: true })).toBeVisible();
      await expect(switcher).toContainText("Von Anna Keller");
      await guest.screenshot({ path: `${SHOTS}/sharing-invitation-in-switcher.png` });
      await switcher.getByRole("button", { name: `Einladung «${title}» öffnen` }).click();
      await expect(activeNotebookTitle(guest)).toHaveText(title, { timeout: 45_000 });
      await waitForSaved(guest);

      // Read-only: the badge, text that cannot be edited, no pen, a page title that stays as it is.
      await expect(readOnlyBadge(guest)).toBeVisible();
      await expect(readOnlyBadge(guest)).toContainText("Nur lesen");
      await expect(sharedText(guest)).toContainText(TEXT, { timeout: 20_000 });
      await expect(sharedText(guest)).toHaveAttribute("aria-readonly", "true");
      await expect(guest.getByLabel("Seitentitel")).toBeDisabled();
      const drawTab = await ribbonTab(guest, "Zeichnen");
      await expect(drawTab.getByRole("button", { name: "Stift", exact: true })).toBeDisabled();
      await guest.screenshot({ path: `${SHOTS}/sharing-reader-shell.png` });

      // Typing and drawing change nothing, here or at Anna's end.
      await sharedText(guest).click();
      await guest.keyboard.type("Fremder Text");
      await drawWave(guest, { x: 160, y: 380 });
      await guest.waitForTimeout(1_500);
      await expect(sharedText(guest)).not.toContainText("Fremder Text");
      expect(await strokeCount(guest)).toBe(0);
      await expect(sharedText(page)).not.toContainText("Fremder Text");
      expect(await strokeCount(page)).toBe(0);

      // A page Anna adds reaches the reader too: the room's changes still apply to a read-only notebook.
      await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
      await page.getByLabel("Seitentitel").fill("Seite von Anna");
      await waitForSaved(page);
      await expect(guest.locator(".page-row__title", { hasText: "Seite von Anna" })).toBeVisible({ timeout: 30_000 });

      // Search, view and copy still work.
      const search = guest.getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" });
      await search.fill("Rollen");
      await expect(guest.getByRole("option", { name: /Erste Seite/ })).toBeVisible();
      await search.fill("");
      await guest.keyboard.press("Escape");
      await sharedText(guest).click();
      await guest.keyboard.press("Control+A");
      const selected = await guest.evaluate(() => window.getSelection()?.toString() ?? "");
      expect(selected).toContain("Inhalt");

      // The people list now shows Ben as a reader, no longer as pending.
      const reopened = await openShareDialog(page);
      await expect(roleMenu(reopened, "Ben Rossi")).toHaveValue("viewer");
      await expect(reopened.getByRole("list", { name: "Ausstehende Einladungen" })).toHaveCount(0);
      await closeShareDialog(page);

      // A modified client with Ben's credentials is refused by the room, not only by the UI.
      const roomId = await roomIdOf(guest);
      const socket = await rawSocket(roomId, { kind: "user", jwt: await tokenFor(ben) });
      expect(socket.role).toBe("viewer");
      socket.send({ t: "append", docId: "page:forged", payload: "AAAA" });
      socket.send({ t: "snapshot", docId: "page:forged", payload: "AAAA", covers: 0 });
      socket.send({ t: "announce", docId: "page:forged", kind: "page" });
      socket.send({ t: "remove", docId: "page:forged" });
      await expect.poll(() => socket.errors.filter((code) => code === "read-only").length).toBe(4);
      socket.close();
      // (A forged ink-segment upload is refused with 403 too; the Worker's own tests cover it, since a
      // refused upload crashes the local wrangler dev runtime used here.)
      // Sharing is not his to manage.
      for (const attempt of [
        roomRequest(roomId, ben, "POST", "/invites", { email: `x-${Date.now()}@canvink.test`, role: "admin" }),
        roomRequest(roomId, ben, "PATCH", `/members/${encodeURIComponent(ben.sub)}`, { role: "admin" }),
        roomRequest(roomId, ben, "PUT", "/link", { enabled: true }),
      ]) expect((await attempt).status).toBe(403);
    } finally {
      await closeContexts(context);
    }
  });

  test("promoting a reader to editor lets edits sync at once, demoting makes the open session read-only again", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const title = "Rollen Wechsel";
    await prepareNotebook(page, anna, title);
    await inviteAs(page, ben, ROLE.read);
    const joined = await openInvitation(browser, ben, title);
    const guest = joined.page;
    try {
      await expect(readOnlyBadge(guest)).toBeVisible();
      await pickPenIfEnabled(guest, false);

      // Anna promotes Ben. His open session follows without a reload.
      const dialog = await openShareDialog(page);
      await roleMenu(dialog, "Ben Rossi").selectOption({ label: ROLE.edit });
      await expect(roleMenu(dialog, "Ben Rossi")).toHaveValue("editor");
      await closeShareDialog(page);
      await expect(readOnlyBadge(guest)).toHaveCount(0, { timeout: 20_000 });
      await expect(guest.locator(".v2-notice")).toContainText(`Du kannst «${title}» jetzt bearbeiten.`);
      await expect(sharedText(guest)).not.toHaveAttribute("aria-readonly", "true");
      await guest.screenshot({ path: `${SHOTS}/sharing-promoted-editor.png` });

      await pickPen(guest);
      await drawWave(guest, { x: 160, y: 380 });
      await expect.poll(() => strokeCount(page), { timeout: 30_000 }).toBe(1);

      // Anna takes the right away again: Ben's session is read-only on the spot and his next stroke goes nowhere.
      const demote = await openShareDialog(page);
      await roleMenu(demote, "Ben Rossi").selectOption({ label: ROLE.read });
      await expect(roleMenu(demote, "Ben Rossi")).toHaveValue("viewer");
      await closeShareDialog(page);
      await expect(readOnlyBadge(guest)).toBeVisible({ timeout: 20_000 });
      await expect(guest.locator(".v2-notice")).toContainText(`Du kannst «${title}» jetzt nur noch lesen.`);
      await expect(sharedText(guest)).toHaveAttribute("aria-readonly", "true");
      await drawWave(guest, { x: 160, y: 460 });
      await guest.waitForTimeout(1_500);
      expect(await strokeCount(guest)).toBe(1);
      expect(await strokeCount(page)).toBe(1);

      // The room agrees: a forged write from the same account is refused.
      const socket = await rawSocket(await roomIdOf(guest), { kind: "user", jwt: await tokenFor(ben) });
      expect(socket.role).toBe("viewer");
      socket.send({ t: "append", docId: "page:forged", payload: "AAAA" });
      await expect.poll(() => socket.errors).toContain("read-only");
      socket.close();
    } finally {
      await closeContexts(joined.context);
    }
  });

  test("an admin can invite and manage people; an editor cannot, and nobody can touch the owner", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const cem = makeIdentity("cem", "Cem Aydin");
    const title = "Rollen Admin";
    await prepareNotebook(page, anna, title);
    await inviteAs(page, ben, ROLE.edit);
    const benSession = await openInvitation(browser, ben, title);
    const guest = benSession.page;
    let cemSession: { context: BrowserContext; page: Page } | undefined;
    try {
      const roomId = await roomIdOf(guest);
      // An editor has no sharing menu, and the room refuses his attempts to escalate.
      await openTopbarMore(guest);
      await expect(guest.getByRole("menuitem", { name: "Notizbuch teilen", exact: true })).toHaveCount(0);
      for (const attempt of [
        roomRequest(roomId, ben, "POST", "/invites", { email: cem.email, role: "viewer" }),
        roomRequest(roomId, ben, "PATCH", `/members/${encodeURIComponent(ben.sub)}`, { role: "admin" }),
        roomRequest(roomId, ben, "PUT", "/link", { enabled: true }),
        roomRequest(roomId, ben, "POST", "/link/regenerate"),
        roomRequest(roomId, ben, "DELETE", `/members/${encodeURIComponent(anna.sub)}`),
      ]) expect((await attempt).status).toBe(403);
      await guest.keyboard.press("Escape");

      // Anna makes Ben an admin: the sharing menu appears in his open session.
      const dialog = await openShareDialog(page);
      await roleMenu(dialog, "Ben Rossi").selectOption({ label: ROLE.admin });
      await expect(roleMenu(dialog, "Ben Rossi")).toHaveValue("admin");
      await closeShareDialog(page);

      await expect(async () => {
        await openTopbarMore(guest);
        await expect(guest.getByRole("menuitem", { name: "Notizbuch teilen", exact: true })).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await guest.getByRole("menuitem", { name: "Notizbuch teilen", exact: true }).click();
      const adminDialog = guest.getByRole("dialog", { name: "Notizbuch teilen" });
      await expect(adminDialog.getByRole("button", { name: "Einladen", exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(adminDialog.getByRole("list", { name: "Personen mit Zugriff" })).toContainText("Anna Keller");
      // The owner is fixed; an admin cannot end the share for everybody.
      await expect(adminDialog.getByRole("button", { name: "Freigabe beenden" })).toHaveCount(0);
      await inviteInDialog(adminDialog, cem.email, ROLE.read);
      await guest.screenshot({ path: `${SHOTS}/sharing-admin-dialog.png` });
      await closeShareDialog(guest);

      // Anna sees who invited Cem; Cem opens the invitation as a reader.
      const annaView = await openShareDialog(page);
      await expect(annaView.locator(`[data-share-invite="${cem.email}"]`)).toContainText("Eingeladen von Ben Rossi");
      await closeShareDialog(page);
      cemSession = await openInvitation(browser, cem, title);
      await expect(readOnlyBadge(cemSession.page)).toBeVisible();

      // Nobody removes or demotes the owner, not even an admin.
      expect((await roomRequest(roomId, ben, "DELETE", `/members/${encodeURIComponent(anna.sub)}`)).status).toBe(403);
      expect((await roomRequest(roomId, ben, "PATCH", `/members/${encodeURIComponent(anna.sub)}`, { role: "viewer" })).status).toBe(403);
    } finally {
      await closeContexts(benSession.context, cemSession?.context);
    }
  });

  test("removing a person ends their access at once, and their copy stops syncing", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const title = "Rollen Entfernen";
    await prepareNotebook(page, anna, title);
    const joined = await joinAsEditor(browser, page, ben, title);
    const guest = joined.page;
    try {
      await pickPen(page);
      await drawWave(page, { x: 160, y: 300 });
      await expect.poll(() => strokeCount(guest), { timeout: 30_000 }).toBe(1);

      const roomId = await roomIdOf(guest);
      const socket = await rawSocket(roomId, { kind: "user", jwt: await tokenFor(ben) });
      expect(socket.role).toBe("editor");

      const dialog = await openShareDialog(page);
      await roleMenu(dialog, "Ben Rossi").selectOption({ label: "Entfernen" });
      await page.getByRole("alertdialog").getByRole("button", { name: "Entfernen", exact: true }).click();
      await expect(roleMenu(dialog, "Ben Rossi")).toHaveCount(0, { timeout: 20_000 });
      await page.screenshot({ path: `${SHOTS}/sharing-dialog-after-remove.png` });
      await closeShareDialog(page);

      // His open sockets are closed by the room; he is told, keeps his copy and can no longer connect.
      expect(await socket.closed).toBe(4401);
      await expect(guest.locator(".v2-notice")).toContainText("Der Zugriff auf ein geteiltes Notizbuch wurde beendet", { timeout: 20_000 });
      await expect(readOnlyBadge(guest)).toHaveCount(0);
      await expect(rawSocket(roomId, { kind: "user", jwt: await tokenFor(ben) })).rejects.toThrow(/4401/);

      // Anna keeps drawing; Ben's copy no longer follows.
      const before = await strokeCount(guest);
      await drawWave(page, { x: 160, y: 380 });
      await expect.poll(() => strokeCount(page)).toBe(2);
      await guest.waitForTimeout(2_500);
      expect(await strokeCount(guest)).toBe(before);
    } finally {
      await closeContexts(joined.context);
    }
  });

  test("everybody with the link reads and cannot write; ending the link ends their access, never an invited person's", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const cem = makeIdentity("cem", "Cem Aydin");
    const title = "Rollen Link";
    await prepareNotebook(page, anna, title);

    // Ben is named as a reader; Cem only has the link.
    await inviteAs(page, ben, ROLE.read);
    const dialog = await openShareDialog(page);
    await setGeneralAccess(dialog, "Alle mit dem Link — Lesen");
    const url = await dialog.locator("#collab-share-url").inputValue();
    expect(url).toContain("#join=");
    await page.screenshot({ path: `${SHOTS}/sharing-dialog-link-on.png` });
    const hash = url.slice(url.indexOf("#"));
    await closeShareDialog(page);

    const benSession = await openInvitation(browser, ben, title);
    const cemSession = await joinAs(browser, hash, cem, title);
    try {
      const reader = cemSession.page;
      await expect(readOnlyBadge(reader)).toBeVisible();
      await expect(sharedText(reader)).toContainText(TEXT, { timeout: 20_000 });
      await expect(sharedText(reader)).toHaveAttribute("aria-readonly", "true");

      // The link never grants a write, whatever a client says: neither with the account nor without one.
      const roomId = await roomIdOf(page);
      const secret = hash.slice(hash.lastIndexOf(".") + 1);
      const anonymous = await rawSocket(roomId, { kind: "link", linkSecret: secret });
      expect(anonymous.role).toBe("viewer");
      anonymous.send({ t: "append", docId: "page:forged", payload: "AAAA" });
      await expect.poll(() => anonymous.errors).toContain("read-only");
      const withAccount = await rawSocket(roomId, { kind: "user", jwt: await tokenFor(cem), linkSecret: secret, role: "editor" });
      expect(withAccount.role).toBe("viewer");
      withAccount.send({ t: "snapshot", docId: "page:forged", payload: "AAAA", covers: 0 });
      await expect.poll(() => withAccount.errors).toContain("read-only");
      const manage = await fetch(`http://127.0.0.1:${process.env.PLAYWRIGHT_COLLAB_WORKER_PORT ?? "8799"}/api/v1/rooms/${roomId}/members`, {
        headers: { "X-Link-Secret": secret },
      });
      expect(manage.status).toBe(403);

      await pickPen(page);
      await drawWave(page, { x: 160, y: 300 });
      await expect.poll(() => strokeCount(reader), { timeout: 30_000 }).toBe(1);
      await expect.poll(() => strokeCount(benSession.page), { timeout: 30_000 }).toBe(1);

      // Anna ends the link: the link-only reader loses access, the invited reader keeps it.
      const off = await openShareDialog(page);
      await setGeneralAccess(off, "Nur eingeladene Personen");
      await page.getByRole("alertdialog").getByRole("button", { name: "Beenden", exact: true }).click();
      await expect(off.getByLabel("Allgemeiner Zugriff", { exact: true })).toHaveValue("restricted");
      await closeShareDialog(page);

      expect(await anonymous.closed).toBe(4401);
      expect(await withAccount.closed).toBe(4401);
      await expect(reader.locator(".v2-notice")).toContainText("Der Zugriff auf ein geteiltes Notizbuch wurde beendet", { timeout: 20_000 });
      await expect(rawSocket(roomId, { kind: "link", linkSecret: secret })).rejects.toThrow(/4401/);
      await expect(rawSocket(roomId, { kind: "user", jwt: await tokenFor(cem), linkSecret: secret })).rejects.toThrow(/4401/);

      await drawWave(page, { x: 160, y: 380 });
      await expect.poll(() => strokeCount(benSession.page), { timeout: 30_000 }).toBe(2);
      await reader.waitForTimeout(2_500);
      expect(await strokeCount(reader)).toBe(1);
      await expect(readOnlyBadge(benSession.page)).toBeVisible();
    } finally {
      await closeContexts(benSession.context, cemSession.context);
    }
  });
});

/** Invites `who` as an editor from the owner's page and opens the invitation as them. */
async function joinAsEditor(browser: Browser, owner: Page, who: TestIdentity, title: string) {
  await inviteAs(owner, who, ROLE.edit);
  return openInvitation(browser, who, title);
}

/** Whether the pen of the Zeichnen tab is usable; a reader has it off. */
async function pickPenIfEnabled(page: Page, enabled: boolean): Promise<void> {
  const draw = await ribbonTab(page, "Zeichnen");
  const pen = draw.getByRole("button", { name: "Stift", exact: true });
  if (enabled) await expect(pen).toBeEnabled();
  else await expect(pen).toBeDisabled();
}

