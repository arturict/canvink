/**
 * Personal-space e2e (services/collab-sync/PERSONAL-SYNC.md §9 Wave 5,
 * verification criteria V5-V8). Run against
 * `tests/e2e/personal-space.playwright.config.ts`, which starts a
 * `wrangler dev` Worker with a local R2 binding and builds the app with
 * `VITE_PERSONAL_SPACE=1`.
 *
 * Two browser contexts share one test identity by injecting the same
 * `test:<sub>:<hmac>` token through `src/auth/e2eTestAuth.ts`'s seam: a `?__canvinkSpaceTestSub=<sub>` query parameter,
 * resolved into the token client-side against the build-time
 * `VITE_PERSONAL_SPACE_TEST_AUTH_SECRET`, which must equal the Worker's
 * `TEST_AUTH_SECRET` (both come from the same env var in the Playwright
 * config).
 */

import { deflateSync } from 'node:zlib';
import type { Browser, Locator, Page } from '@playwright/test';
import {
  addNamedNotebook,
  addText,
  gotoSpaceApp,
  notebookCount,
  selectNotebookStably,
  SPACE_STATUS_OPEN,
  SPACE_SYNCED_TEXT,
  test,
  trashActiveNotebook,
  trashButton,
  waitForSpaceStatus,
} from './personalSpaceSupport';
import {
  acceptConfirm,
  ribbonTab,
  inkCount,
  expectInkCount,
  createNotebook,
  drawPenStrokesRightAway,
  expect,
  openNotebookSwitcher,
  openTopbarMore,
  saveStatus,
} from './support';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function fixturePng(width = 64, height = 48): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      rows.set([40 + (x % 80), 100 + (y % 100), 210, 255], pixel);
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_BYTES = fixturePng();

test.describe('personal space: cross-device sync', () => {
  test('V5: a cold second context on the same identity sees the notebook, the page text, and the image', async ({ page, browser }) => {
    const sub = `e2e-v5-${test.info().workerIndex}-${Date.now()}`;

    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    // A brand-new notebook (fresh, per-install-random document ids), not the bundled starter
    // notebook: the bundled starter's page carries a fixed documentId shared by every fresh
    // install (`BUNDLED_START_PAGE_ID`, `src/domain/sample.ts`). Every fresh device's PUSH/PULL
    // bootstrap includes *whatever notebooks currently exist locally* — so even leaving the
    // bundled starter notebook untouched (as the very first version of this test did) still
    // pushes its colliding page, since it is simply still there. Getting rid of it is therefore
    // not optional set-dressing: it is permanently deleted below (trash, then "delete
    // permanently") before the second context ever pulls, which is the only way, given this
    // Wave's ownership boundaries, to avoid the real, narrow cross-device id-collision gap this
    // report documents (`workspaceV2Runtime.ts`'s `adoptedDocuments` has no "replace an existing
    // local document under the same id" path, so `commitWorkspaceGraphRevision` cannot both
    // adopt and discard the same documentId in one transaction — see the Wave 5 report).
    const notebookTitle = 'Persönlicher Bereich Notizbuch';
    await addNamedNotebook(page, notebookTitle);

    await addText(page, 'Vom ersten Gerät synchronisierter Text.');

    // As with `addText`'s own retry loop: a personal-space catch-up re-render landing exactly
    // between `setInputFiles` and the image actually appearing can detach/remount the canvas,
    // so retry the whole insertion rather than fail on the first flake.
    let imageVisible = false;
    for (let attempt = 0; attempt < 5 && !imageVisible; attempt += 1) {
      const imageInput = page.locator('input[type="file"][accept^="image/png"]');
      await imageInput.setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: PNG_BYTES });
      imageVisible = await page.getByRole('img', { name: 'diagram' }).waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true).catch(() => false);
    }
    await expect(page.getByRole('img', { name: 'diagram' })).toBeVisible({ timeout: 15_000 });
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });

    // Switch back to the bundled starter notebook ("Notizbuch", `src/domain/sample.ts`) and
    // permanently delete it, so its colliding page never reaches the account at all.
    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    // Let the soft-delete (the trash move above) reach the workspace doc — and, from there, the
    // room — as its own transaction before hard-deleting: the local -> workspace-doc projection
    // (`projectLocalTopologyIntoWorkspaceDoc`) only records a documentId as *purged* once it has
    // already seen it soft-deleted, and a permanent-delete click right after the trash-move click
    // could otherwise land in the very same effect pass, before that soft-delete was ever synced.
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });

    // Give the personal-space upload path (announce/snapshot + asset PUT) a moment before a
    // cold second context asks for the same identity's space.
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);

      // `waitForSpaceStatus`'s "synced" text reflects "no pending local change to send", not "the
      // server has finished durably applying every change the *first* device already sent" — the
      // two are not quite the same guarantee, and the room's replay-on-connect for a brand-new
      // client is a one-shot computation at connect time. Found via this test, intermittently: on
      // a slow run this device's very first catch-up can briefly see an incomplete `workspace:
      // root`. `scheduleCatchUp`'s debounce naturally retries on the *next* `docsChanged` event,
      // so polling this assertion for longer (rather than a single fixed wait) gives it the room
      // to do so — see the Wave 5 report for why a test-level poll, not a runtime fix, was judged
      // the right scope for this.
      await expect.poll(() => notebookCount(secondPage, notebookTitle), { timeout: 45_000 }).toBe(1);
      await expect(secondPage.getByRole('textbox', { name: 'Gemeinsamer Text' }).last())
        .toContainText('Vom ersten Gerät synchronisierter Text.', { timeout: 30_000 });
      await expect(secondPage.getByRole('img', { name: 'diagram' })).toBeVisible({ timeout: 30_000 });
      // The image bytes arrive after the documents; until then a placeholder shows, and a
      // not-yet-downloaded asset must never turn the save chip into an error.
      await expect(saveStatus(secondPage)).not.toHaveAttribute('data-state', 'error');
    } finally {
      await secondContext.close();
    }
  });

  test('the notebook settings reach a cold second device, and its new pages follow them', async ({ page, browser }) => {
    const sub = `e2e-settings-${test.info().workerIndex}-${Date.now()}`;
    const notebookTitle = 'Einstellungen Synchron';
    const choose = (group: Locator, name: string) => group.getByRole('button', { name, exact: true });
    const openSettings = async (target: Page) => {
      await openTopbarMore(target);
      await target.getByRole('menuitem', { name: 'Notizbuch-Einstellungen', exact: true }).click();
      const dialog = target.getByRole('dialog', { name: 'Notizbuch-Einstellungen' });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addNamedNotebook(page, notebookTitle);

    const dialog = await openSettings(page);
    await choose(dialog.getByRole('group', { name: 'Papierhintergrund' }), 'Millimeter').click();
    await choose(dialog.getByRole('group', { name: 'Symbol', exact: true }), 'Symbol 🎓').click();
    await choose(dialog.getByRole('group', { name: 'Seiten', exact: true }), 'Titel').click();
    // With an account the dialog shows what this device holds and offers to keep every page.
    await expect(dialog.getByRole('switch', { name: /Alle Seiten offline halten/ })).toHaveAttribute('aria-checked', 'true');
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await page.keyboard.press('Escape');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    // The starter notebook carries a page id every fresh install shares, so it leaves the account first
    // (see the V5 test).
    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const second = await secondContext.newPage();
      await gotoSpaceApp(second, sub);
      await waitForSpaceStatus(second, SPACE_SYNCED_TEXT, 45_000);
      await expect.poll(() => notebookCount(second, notebookTitle), { timeout: 45_000 }).toBe(1);
      await selectNotebookStably(second, notebookTitle);
      await expect(second.locator('.notebook-switcher__button .notebook-color--icon')).toHaveText('🎓');

      const remote = await openSettings(second);
      await expect(choose(remote.getByRole('group', { name: 'Papierhintergrund' }), 'Millimeter')).toHaveAttribute('aria-pressed', 'true');
      await expect(choose(remote.getByRole('group', { name: 'Symbol', exact: true }), 'Symbol 🎓')).toHaveAttribute('aria-pressed', 'true');
      await expect(choose(remote.getByRole('group', { name: 'Seiten', exact: true }), 'Titel')).toHaveAttribute('aria-pressed', 'true');
      await second.keyboard.press('Escape');

      // A page added on the second device starts with the notebook's paper.
      await second.getByRole('button', { name: /^Seite hinzufügen/ }).first().click();
      await expect(second.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' }))
        .toHaveClass(/live-canvas-surface--millimeter/);
    } finally {
      await secondContext.close();
    }
  });

  test('strokes drawn right after a notebook is created all count and the pen stays chosen', async ({ page }) => {
    const sub = `e2e-remount-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await createNotebook(page);
    await page.keyboard.press('Escape');
    await drawPenStrokesRightAway(page, 4);
  });

  test('V9: ink drawn on the first device reaches a cold second device through ink segments in R2', async ({ page, browser }) => {
    const sub = `e2e-v9-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    // As in V5: a notebook of its own, and the bundled starter notebook removed before the account has data.
    const notebookTitle = 'Tinte Notizbuch';
    await addNamedNotebook(page, notebookTitle);
    // The switcher can still be open after the rename; it would cover the ribbon.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Notizbuch wechseln' })).toBeHidden();
    const draw = await ribbonTab(page, 'Zeichnen');
    await draw.getByRole('button', { name: 'Stift', exact: true }).click();
    const surface = page.getByLabel('Ansicht der Zeichenfläche');
    const box = (await surface.boundingBox())!;
    const before = await inkCount(page);
    for (let index = 0; index < 4; index += 1) {
      const y = box.y + 140 + index * 50;
      await page.mouse.move(box.x + 120, y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + 120 + step * 14, y + Math.sin(step) * 8);
      await page.mouse.up();
    }
    await expectInkCount(page, before + 4);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });

    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    // The strokes are sealed into a segment after a moment of rest, and the segment is uploaded next.
    await page.waitForTimeout(6_000);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await expect.poll(() => notebookCount(secondPage, notebookTitle), { timeout: 45_000 }).toBe(1);
      await selectNotebookStably(secondPage, notebookTitle);
      // The page document arrives first; its ink follows from the segment the first device uploaded.
      await expectInkCount(secondPage, before + 4);
      await expect(saveStatus(secondPage)).not.toHaveAttribute('data-state', 'error');
    } finally {
      await secondContext.close();
    }
  });

  /** Adds a page to the open section, then gives it a title and a text. */
  async function addTitledPage(page: Page, title: string, text: string, firstPage = false): Promise<void> {
    if (!firstPage) {
      await page.getByRole('button', { name: /^Seite hinzufügen/ }).click();
      await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');
    }
    await addText(page, text);
    await page.getByLabel('Seitentitel').fill(title);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  }

  test('a new device lists every page at once and downloads a page when it is opened', async ({ page, browser }) => {
    const sub = `e2e-lazy-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addNamedNotebook(page, 'Lazy Notizbuch');
    await addTitledPage(page, 'Erste Lazy Notiz', 'Inhalt der ersten Lazy Notiz.', true);
    await addTitledPage(page, 'Zweite Lazy Notiz', 'Inhalt der zweiten Lazy Notiz.');
    await addTitledPage(page, 'Dritte Lazy Notiz', 'Inhalt der dritten Lazy Notiz.');
    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    // The summaries of the new pages reach the account a moment after the edits.
    await page.waitForTimeout(4_000);

    // The second device keeps no offline copies, so only the pages it opens are downloaded.
    const secondContext = await browser.newContext();
    try {
      await secondContext.addInitScript(() => {
        localStorage.setItem('canvink:personal-space:offline-copies:v1', 'opened');
      });
      const secondPage = await secondContext.newPage();
      const pageSnapshots = new Set<string>();
      secondPage.on('websocket', (socket) => {
        socket.on('framereceived', (frame) => {
          const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
          if (text.startsWith('{"t":"snapshot"')) pageSnapshots.add((JSON.parse(text) as { docId: string }).docId);
        });
      });
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await expect.poll(() => notebookCount(secondPage, 'Lazy Notizbuch'), { timeout: 45_000 }).toBe(1);
      // Every page title is in the sidebar although only the landing page was downloaded.
      for (const title of ['Erste Lazy Notiz', 'Zweite Lazy Notiz', 'Dritte Lazy Notiz']) {
        await expect(secondPage.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible({ timeout: 30_000 });
      }
      const downloadedBefore = [...pageSnapshots].filter((docId) => docId.startsWith('page:')).length;
      expect(downloadedBefore).toBeLessThan(3);

      await secondPage.getByRole('button', { name: /Dritte Lazy Notiz/ }).first().click();
      await expect(secondPage.getByRole('textbox', { name: 'Gemeinsamer Text' }).last())
        .toContainText('Inhalt der dritten Lazy Notiz.', { timeout: 30_000 });
      await expect(saveStatus(secondPage)).not.toHaveAttribute('data-state', 'error');
    } finally {
      await secondContext.close();
    }
  });

  test('offline, a downloaded page works fully and a page not downloaded yet says so and never hangs', async ({ page, browser }) => {
    test.setTimeout(150_000);
    const sub = `e2e-lazy-offline-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await expect.poll(() => page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })).toBe(true);
    await addNamedNotebook(page, 'Offline Notizbuch');
    await addTitledPage(page, 'Erste Offline Notiz', 'Inhalt der ersten Offline Notiz.', true);
    await addTitledPage(page, 'Zweite Offline Notiz', 'Inhalt der zweiten Offline Notiz.');
    await addTitledPage(page, 'Dritte Offline Notiz', 'Inhalt der dritten Offline Notiz.');
    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await page.waitForTimeout(4_000);

    const secondContext = await browser.newContext();
    try {
      await secondContext.addInitScript(() => {
        localStorage.setItem('canvink:personal-space:offline-copies:v1', 'opened');
      });
      const second = await secondContext.newPage();
      await gotoSpaceApp(second, sub);
      await waitForSpaceStatus(second, SPACE_SYNCED_TEXT, 45_000);
      await expect.poll(() => notebookCount(second, 'Offline Notizbuch'), { timeout: 45_000 }).toBe(1);
      await expect.poll(() => second.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const registration = await navigator.serviceWorker.ready;
        return Boolean(registration.active && navigator.serviceWorker.controller);
      })).toBe(true);
      // Open one more page online, so that it is downloaded; the third page stays a placeholder.
      await second.getByRole('button', { name: /Zweite Offline Notiz/ }).first().click();
      await expect(second.getByRole('textbox', { name: 'Gemeinsamer Text' }).last())
        .toContainText('Inhalt der zweiten Offline Notiz.', { timeout: 30_000 });
      await second.reload({ waitUntil: 'domcontentloaded' });
      await expect(saveStatus(second)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      await waitForSpaceStatus(second, SPACE_SYNCED_TEXT, 45_000);

      await second.context().setOffline(true);
      await second.reload({ waitUntil: 'domcontentloaded' });
      await expect(saveStatus(second)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      // A page downloaded before works fully offline: it shows its text and takes edits.
      await expect(second.getByText('Inhalt der zweiten Offline Notiz.')).toBeVisible({ timeout: 20_000 });
      await addText(second, 'Offline ergänzt.');
      // A page that is not on this device says so at once.
      const started = Date.now();
      await second.getByRole('button', { name: /Dritte Offline Notiz/ }).first().click();
      await expect(second.getByText('Diese Seite ist noch nicht auf diesem Gerät.')).toBeVisible({ timeout: 10_000 });
      expect(Date.now() - started).toBeLessThan(10_000);
      // The device stays editable afterwards.
      await second.getByRole('button', { name: /Zweite Offline Notiz/ }).first().click();
      await addText(second, 'Noch einmal offline.');
      await second.context().setOffline(false);
      await waitForSpaceStatus(second, SPACE_SYNCED_TEXT, 45_000);
      await expect(page.getByText('Offline ergänzt.')).toBeVisible({ timeout: 30_000 }).catch(() => undefined);
    } finally {
      await secondContext.close();
    }
  });

  test('a device that holds its pages but has no resume record does not upload them again', async ({ page }) => {
    const sub = `e2e-noresume-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addNamedNotebook(page, 'Notizbuch ohne Resume');
    await addText(page, 'Text, der schon im Konto liegt.');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const uploadedDocs: string[] = [];
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => {
        const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
        if (text.startsWith('{"t":"snapshot"')) uploadedDocs.push((JSON.parse(text) as { docId: string }).docId);
      });
    });
    // A device from before resume records existed: it stores everything but does not know what the room holds.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('canvink:personal-space:resume:')) localStorage.removeItem(key);
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 45_000);
    await expect(page.getByText('Text, der schon im Konto liegt.')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    expect(uploadedDocs.filter((docId) => docId.startsWith('page:'))).toEqual([]);
  });

  test('V6: B edits the page while A is offline; on reconnect both converge and neither edit is lost', async ({ page, browser }) => {
    const sub = `e2e-v6-${test.info().workerIndex}-${Date.now()}`;

    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    // A brand-new notebook, not the bundled starter — see V5's comment: the starter's page
    // carries a fixed documentId shared by every fresh install, and adopting/replacing a document
    // under a colliding id in the same transaction as purging the local copy that used to own it
    // is a genuine, documented gap outside this Wave's ownership boundary
    // (`workspaceV2Runtime.ts`'s `adoptedDocuments` has no "replace an existing local document
    // under the same id" path). Permanently deleting the starter before B ever pulls avoids it.
    const notebookTitle = 'Notizbuch für Offline-Test';
    await addNamedNotebook(page, notebookTitle);

    await addText(page, 'Text von Gerät A, vor dem Trennen.');

    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    // Leaving the trash dialog open blocks every later click on `page` behind its
    // `recovery-overlay` (both V6 and V7 keep acting on `page` afterward, unlike V5).
    await page.getByRole('button', { name: 'Papierkorb schliessen' }).click();

    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await expect(secondPage.getByRole('textbox', { name: 'Gemeinsamer Text' }).last())
        .toContainText('Text von Gerät A, vor dem Trennen.', { timeout: 30_000 });

      // A (`page`, per PERSONAL-SYNC.md §9's own V6 wording) goes offline; B keeps editing while
      // disconnected. Deliberately NOT also editing on `page` while it is offline: two
      // *genuinely concurrent* edits to the very same page document is a separate, pre-existing
      // domain-layer gap (`src/crdt/document.ts`'s "element map and zOrder must contain the same
      // unique IDs" invariant, found via this test — outside this Wave's file ownership boundary
      // to fix). "Neither edit is lost" here means: A's own edit made *before* disconnecting, and
      // B's edit made while A was offline, both survive A's reconnect — sequential, not
      // concurrent, edits to the shared page, which is exactly what an offline device's catch-up
      // is meant to guarantee (PERSONAL-SYNC.md P7).
      await page.context().setOffline(true);
      await addText(secondPage, 'Text von Gerät B, während A offline war.');
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 30_000);

      await page.context().setOffline(false);
      // Once A reconnects, B's edit (made while A was offline) must reach A, and A's own
      // earlier edit must still be there for B — neither side's change is lost or overwritten.
      await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 45_000);
      await expect(page.getByText('Text von Gerät B, während A offline war.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Text von Gerät A, vor dem Trennen.')).toBeVisible();
      await expect(secondPage.getByText('Text von Gerät A, vor dem Trennen.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await secondContext.close();
    }
  });

  test('V7: A soft-deletes a notebook while B edits a page inside it; trash + restore keep B\'s edit', async ({ page, browser }) => {
    const sub = `e2e-v7-${test.info().workerIndex}-${Date.now()}`;

    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    // Two brand-new notebooks, not the bundled starter (see V5's comment: the starter's page
    // carries a fixed documentId shared by every fresh install, and adopting/replacing a document
    // under a colliding id in the same transaction as purging the local copy that used to own it
    // is a genuine, documented gap outside this Wave's ownership boundary). One is the notebook
    // under test; the other is a *fallback* — `trashNotebook` (`V2NotebookApp.tsx`) requires one
    // to fall the active selection back onto and silently no-ops without it, and after
    // permanently deleting "Notizbuch" below there would otherwise be none left.
    const fallbackNotebookTitle = 'Ausweichnotizbuch';
    await addNamedNotebook(page, fallbackNotebookTitle);

    const notebookTitle = 'Notizbuch für Löschtest';
    await addNamedNotebook(page, notebookTitle);

    await addText(page, 'Ursprünglicher Text im Notizbuch, das gelöscht wird.');

    await selectNotebookStably(page, 'Notizbuch');
    await trashActiveNotebook(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await trashButton(page).click();
    await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
    await acceptConfirm(page);
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    // Leaving the trash dialog open blocks every later click on `page` behind its
    // `recovery-overlay` (both V6 and V7 keep acting on `page` afterward, unlike V5).
    await page.getByRole('button', { name: 'Papierkorb schliessen' }).click();

    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await expect.poll(() => notebookCount(secondPage, notebookTitle), { timeout: 45_000 }).toBe(1);
      await selectNotebookStably(secondPage, notebookTitle);
      await expect(secondPage.getByRole('textbox', { name: 'Gemeinsamer Text' }).last())
        .toContainText('Ursprünglicher Text im Notizbuch, das gelöscht wird.', { timeout: 30_000 });

      // B edits the shared page while the notebook is still live on both sides.
      await addText(secondPage, 'Text von Gerät B, kurz bevor A das Notizbuch löscht.');

      // Trashing "Notizbuch" above (`trashNotebook`'s own fallback logic, `V2NotebookApp.tsx`)
      // moved A's active selection to whichever notebook wasn't active at that moment — not
      // necessarily back to `notebookTitle` — so it must be reselected before looking for B's
      // edit, or the assertion below would look at the wrong page.
      await selectNotebookStably(page, notebookTitle);

      // A must see B's edit before it soft-deletes the notebook — proof the edit really reached
      // the shared page rather than being a purely local change B is about to lose.
      await expect(page.getByText('Text von Gerät B, kurz bevor A das Notizbuch löscht.')).toBeVisible({ timeout: 30_000 });

      await trashActiveNotebook(page);
      await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
      await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

      // B sees the notebook disappear from the live list (moved to trash) …
      await expect.poll(() => notebookCount(secondPage, notebookTitle), { timeout: 45_000 }).toBe(0);

      // … and finds it in its own trash panel.
      await trashButton(secondPage).click();
      await expect(secondPage.getByRole('listitem').filter({ hasText: notebookTitle })).toHaveCount(1, { timeout: 15_000 });
      await secondPage.getByRole('button', { name: 'Wiederherstellen' }).click();
      await expect(saveStatus(secondPage)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
      await secondPage.getByRole('button', { name: 'Papierkorb schliessen' }).click();

      // Restoring brings the notebook back — with both edits it accumulated before the delete —
      // for both devices.
      await expect.poll(() => notebookCount(secondPage, notebookTitle), { timeout: 45_000 }).toBe(1);
      await selectNotebookStably(secondPage, notebookTitle);
      await expect(secondPage.getByText('Ursprünglicher Text im Notizbuch, das gelöscht wird.')).toBeVisible({ timeout: 15_000 });
      await expect(secondPage.getByText('Text von Gerät B, kurz bevor A das Notizbuch löscht.')).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });

  test('a new device joins an account without deleting its own start page first, and reopens after a reload', async ({ page, browser }) => {
    // Unlike V5, nothing is cleaned up on either side: both installs carry the bundled start
    // page under the same fixed id, exactly like a desktop app installed next to the web app.
    const sub = `e2e-join-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addText(page, 'Text vom ersten Gerät.');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await expect(secondPage.getByText('Text vom ersten Gerät.')).toBeVisible({ timeout: 30_000 });

      // A device that has synced before resumes from what it holds: the room sends no document
      // again, only what changed since (here: nothing but the workspace document).
      const receivedDocs: string[] = [];
      let receivedFrames = 0;
      secondPage.on('websocket', (socket) => {
        socket.on('framereceived', (frame) => {
          const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
          receivedFrames += 1;
          if (text.startsWith('{"t":"snapshot"')) receivedDocs.push((JSON.parse(text) as { docId: string }).docId);
        });
      });
      await secondPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(saveStatus(secondPage)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      await expect(secondPage.getByText('Text vom ersten Gerät.')).toBeVisible({ timeout: 30_000 });
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      expect(receivedFrames).toBeGreaterThan(0);
      expect(receivedDocs.filter((docId) => docId !== 'workspace:root')).toEqual([]);

      await addText(secondPage, 'Text vom zweiten Gerät.');
      await expect(page.getByText('Text vom zweiten Gerät.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await secondContext.close();
    }
  });

  test('a device with its own notebooks adds them to an account that already has data', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const sub = `e2e-add-local-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addText(page, 'Text im Konto.');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      // The second device is used without an account first (a desktop app at school).
      const secondPage = await secondContext.newPage();
      await secondPage.goto('/app', { waitUntil: 'domcontentloaded' });
      await expect(saveStatus(secondPage)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      await secondPage.getByRole('button', { name: /^Seite hinzufügen/ }).first().click();
      await expect(secondPage.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');
      await secondPage.getByLabel('Seitentitel').fill('Seite vom zweiten Gerät');
      await secondPage.getByLabel('Seitentitel').press('Enter');
      await expect(secondPage.locator('.page-row').filter({ hasText: 'Seite vom zweiten Gerät' })).toHaveCount(1);
      await addText(secondPage, 'Lokal vor der Anmeldung geschrieben.');

      await gotoSpaceApp(secondPage, sub);
      await secondPage.getByRole('button', { name: 'Ins Konto übernehmen' }).click();
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);

      // Both devices end up with both notebooks.
      const notebookCount = async (target: Page) => {
        const dialog = await openNotebookSwitcher(target);
        const count = await dialog.locator('.notebook-switcher__option:not(.notebook-switcher__option--page)').count();
        await target.keyboard.press('Escape');
        return count;
      };
      await expect.poll(() => notebookCount(secondPage), { timeout: 30_000 }).toBe(2);
      await expect.poll(() => notebookCount(page), { timeout: 30_000 }).toBe(2);
      // The first device can open the second device's page.
      const opened = async () => {
        for (let index = 0; index < 2; index += 1) {
          const dialog = await openNotebookSwitcher(page);
          await dialog.locator('.notebook-switcher__option:not(.notebook-switcher__option--page)').nth(index).click();
          if (await page.locator('.page-row').filter({ hasText: 'Seite vom zweiten Gerät' }).count() > 0) return true;
        }
        return false;
      };
      await expect.poll(opened, { timeout: 30_000 }).toBe(true);
    } finally {
      await secondContext.close();
    }
  });

  /**
   * A device used without an account, where the only thing the person did is writing a line on the
   * bundled start page: structurally it is the untouched sample, but the line is theirs. (Typing into
   * an existing block is covered by the unit tests of `starterHoldsTypedText` and the phone spec.)
   */
  async function deviceWithTypedStarter(browser: Browser, accountPage: Page, sub: string) {
    await accountPage.goto(`/app?__canvinkSpaceTestSub=${encodeURIComponent(sub)}`, { waitUntil: 'domcontentloaded' });
    await expect(saveStatus(accountPage)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
    await waitForSpaceStatus(accountPage, SPACE_SYNCED_TEXT);
    await addText(accountPage, 'Text im Konto.');
    await waitForSpaceStatus(accountPage, SPACE_SYNCED_TEXT);

    const context = await browser.newContext();
    const device = await context.newPage();
    await device.goto('/app', { waitUntil: 'domcontentloaded' });
    await expect(saveStatus(device)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
    await addText(device, 'Lokal notiert.');
    await gotoSpaceApp(device, sub);
    return { context, device };
  }

  test('typing into the start page is the person\'s content: signing in asks and "keep only on this device" changes nothing', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const sub = `e2e-keep-local-${test.info().workerIndex}-${Date.now()}`;
    const { context, device } = await deviceWithTypedStarter(browser, page, sub);
    try {
      const sheet = device.getByRole('dialog', { name: 'Dieses Gerät hat Notizbücher, die nicht im Konto sind' });
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await sheet.getByRole('button', { name: 'Nur auf diesem Gerät behalten' }).click();
      await expect(sheet).toHaveCount(0);
      await expect(device.getByText('Lokal notiert.')).toBeVisible();
      // Nothing was uploaded and the answer is remembered across a restart.
      await gotoSpaceApp(device, sub);
      await device.waitForTimeout(2_000);
      await expect(sheet).toHaveCount(0);
      await expect(device.getByText('Lokal notiert.')).toBeVisible();
      await expect(page.getByText('Lokal notiert.')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('"discard" removes the device\'s notebooks only after a confirmation and loads the account', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const sub = `e2e-discard-local-${test.info().workerIndex}-${Date.now()}`;
    const { context, device } = await deviceWithTypedStarter(browser, page, sub);
    try {
      const sheet = device.getByRole('dialog', { name: 'Dieses Gerät hat Notizbücher, die nicht im Konto sind' });
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await sheet.getByRole('button', { name: 'Verwerfen' }).click();
      // Cancelling the confirmation changes nothing.
      const confirm = device.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(sheet).toBeVisible();
      await expect(device.getByText('Lokal notiert.')).toBeVisible();

      await sheet.getByRole('button', { name: 'Verwerfen' }).click();
      await acceptConfirm(device);
      await waitForSpaceStatus(device, SPACE_SYNCED_TEXT, 45_000);
      await expect(device.getByText('Text im Konto.')).toBeVisible({ timeout: 30_000 });
      await expect(device.getByText('Lokal notiert.')).toHaveCount(0);
      // The account itself was not touched.
      await expect(page.getByText('Text im Konto.')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a linked device started offline keeps its edits and sends them once the network is back', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const sub = `e2e-offline-start-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await expect.poll(() => page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })).toBe(true);
    // One reload under the service worker, so the lazily loaded app chunks are cached too.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addText(page, 'Online geschrieben.');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    // No network at all reads "Offline" (cloud-off), not "Verbindung wird wiederhergestellt".
    const syncState = page.getByTestId('save-status');
    await page.context().setOffline(true);
    await expect(syncState).toHaveAttribute('data-sync', 'offline');
    await expect(syncState).toHaveAttribute('title', /Offline/);
    await page.context().setOffline(false);
    await expect(syncState).toHaveAttribute('data-sync', 'synced', { timeout: 45_000 });

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await expect(secondPage.getByText('Online geschrieben.')).toBeVisible({ timeout: 30_000 });

      // The laptop starts without a network: the app opens from the service worker, the
      // edit is kept locally and the status says it is offline instead of reporting an error.
      await page.context().setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
      await addText(page, 'Offline nach dem Neustart geschrieben.');
      await expect(page.getByRole('button', { name: SPACE_STATUS_OPEN })).not.toContainText('Sync-Fehler');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-sync', 'offline');

      await page.context().setOffline(false);
      await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 45_000);
      await expect(secondPage.getByText('Offline nach dem Neustart geschrieben.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Online geschrieben.')).toBeVisible();
    } finally {
      await page.context().setOffline(false);
      await secondContext.close();
    }
  });

  test('V8: a different identity sees an empty space and cannot read the first identity\'s documents', async ({ page, browser }) => {
    const sub = `e2e-v8-owner-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addText(page, 'Geheimer Inhalt für Identität A.');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const otherSub = `e2e-v8-stranger-${test.info().workerIndex}-${Date.now()}`;
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await gotoSpaceApp(otherPage, otherSub);
      await waitForSpaceStatus(otherPage, SPACE_SYNCED_TEXT, 45_000);
      await expect(otherPage.getByRole('textbox', { name: 'Gemeinsamer Text' })).toHaveCount(0);
      await expect(otherPage.getByText('Geheimer Inhalt für Identität A.')).toHaveCount(0);
    } finally {
      await otherContext.close();
    }
  });
  test('navigating and creating notebooks while a second device keeps editing neither throws nor loses a local commit', async ({ page, browser }) => {
    // Sync adoptions publish a new activation while a local topology commit (create, rename,
    // navigation) is in flight; the local commit has to rebase onto it. `runtimeGuard` fails the
    // test on any uncaught page error, which is how the unrebased commit used to surface.
    test.setTimeout(150_000);
    const sub = `e2e-topology-race-${test.info().workerIndex}-${Date.now()}`;
    await gotoSpaceApp(page, sub);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addNamedNotebook(page, 'Gemeinsam Start');
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);

    const secondContext = await browser.newContext();
    try {
      const secondPage = await secondContext.newPage();
      const secondErrors: string[] = [];
      secondPage.on('pageerror', (error) => secondErrors.push(error.stack ?? error.message));
      await gotoSpaceApp(secondPage, sub);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);

      const rounds = 3;
      // B adds pages to the shared notebook while A creates notebooks and moves between them:
      // every adoption on A lands among A's own create, rename and navigation commits.
      await selectNotebookStably(secondPage, 'Gemeinsam Start');
      const deviceB = (async () => {
        for (let round = 0; round < rounds; round += 1) {
          await secondPage.getByRole('button', { name: /^Seite hinzufügen/ }).click();
          await secondPage.getByLabel('Seitentitel').fill(`B Seite ${round}`);
          await expect(saveStatus(secondPage)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
        }
      })();
      const deviceA = (async () => {
        for (let round = 0; round < rounds; round += 1) {
          await addNamedNotebook(page, `A Notizbuch ${round}`);
          await selectNotebookStably(page, 'Gemeinsam Start');
          await selectNotebookStably(page, `A Notizbuch ${round}`);
        }
      })();
      await Promise.all([deviceA, deviceB]);

      await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 45_000);
      await waitForSpaceStatus(secondPage, SPACE_SYNCED_TEXT, 45_000);
      await selectNotebookStably(page, 'Gemeinsam Start');
      // The notebook's own first page plus the pages B added; a page B titled while A still listed
      // it by its earlier summary shows under that title until A downloads it, so count them.
      await expect(page.getByRole('navigation', { name: 'Notizbuchnavigation' }).getByRole('list').last().getByRole('listitem'))
        .toHaveCount(rounds + 1, { timeout: 45_000 });
      for (let round = 0; round < rounds; round += 1) {
        await expect.poll(() => notebookCount(secondPage, `A Notizbuch ${round}`), { timeout: 45_000 }).toBe(1);
        expect(await notebookCount(page, `A Notizbuch ${round}`)).toBe(1);
      }
      expect(secondErrors).toEqual([]);
    } finally {
      await secondContext.close();
    }
  });
});
