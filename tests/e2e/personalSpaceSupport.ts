/** Helpers shared by the personal-space specs; see personal-space.spec.ts for the setup they need. */
import type { Page } from '@playwright/test';
import {
  activeNotebookTitle,
  addTextFromRibbon,
  contextCommand,
  createNotebook,
  expect,
  notebookOption,
  openNotebookSwitcher,
  saveStatus,
  submitInlineRename,
  test as baseTest,
} from './support';

/**
 * `runtimeGuard` (`./support.ts`) fails a test on ANY console error, which is
 * the right default for the rest of this suite. The personal-space asset
 * HEAD-dedupe check (`src/personal-space/assets/assetSyncQueue.ts`, §5.7)
 * deliberately issues a `HEAD /api/v1/me/assets/:id` that is *expected* to
 * 404 for a brand-new asset — normal control flow, not a bug — but Chromium
 * logs every non-2xx `fetch()` response as a `console.error` regardless of
 * whether the caller handles it. This spec overrides the shared fixture to
 * ignore only that one expected pattern; every other console error still
 * fails the test exactly as it does everywhere else.
 */
export const test = baseTest.extend<{ runtimeGuard: void }>({
  runtimeGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(`pageerror: ${error.stack ?? error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        // Chromium logs a `console.error` for every non-2xx `fetch()`/resource load regardless of
        // whether the caller handles it — for the HEAD-dedupe 404 (see this file's module doc
        // comment), the *text* varies by call site: a `fetch()`-originated error embeds the URL
        // (`/api/v1/me/assets/.*404`), but the browser's own native "failed to load resource"
        // message (also seen for this exact HEAD request) never puts the URL in the text at all —
        // only in `location().url` — so both must be checked to reliably allowlist just this one
        // expected pattern without also swallowing an unrelated real 404.
        if (/\/api\/v1\/me\/assets\/.*404/.test(message.text())) return;
        if (/^Failed to load resource:.*404/.test(message.text()) && /\/api\/v1\/me\/assets\//.test(message.location().url)) return;
        // The offline tests cut the network on purpose; the failed requests and sockets are expected.
        if (/ERR_INTERNET_DISCONNECTED/.test(message.text())) return;
        errors.push(`console.error: ${message.text()}`);
      });
      await use();
      expect(errors, 'The browser emitted unexpected console or page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export const SPACE_STATUS_OPEN = 'Synchronisierungsstatus';
export const SPACE_SYNCED_TEXT = 'Synchronisiert';

export async function gotoSpaceApp(page: Page, sub: string, timeout = 20_000): Promise<void> {
  await page.goto(`/app?__canvinkSpaceTestSub=${encodeURIComponent(sub)}`, { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout });
}

export async function waitForSpaceStatus(page: Page, text: string, timeout = 30_000): Promise<void> {
  await expect(page.getByRole('button', { name: SPACE_STATUS_OPEN })).toContainText(text, { timeout });
}

/**
 * Opens `label` through the notebook switcher and confirms it *stays* open for a short window.
 * A personal-space catch-up commit landing right after a user topology commit could briefly
 * re-render the previous selection; re-asserting after a short wait keeps the steps below on
 * the notebook they mean.
 */
export async function selectNotebookStably(page: Page, label: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if ((await activeNotebookTitle(page).textContent())?.trim() !== label) {
      const dialog = await openNotebookSwitcher(page);
      await notebookOption(page, dialog, label).click();
    }
    await expect(activeNotebookTitle(page)).toHaveText(label);
    await page.waitForTimeout(300);
    if ((await activeNotebookTitle(page).textContent())?.trim() === label) {
      // An inline rename keeps the switcher open; close it so the page is usable.
      await closeNotebookSwitcher(page);
      return;
    }
  }
  await expect(activeNotebookTitle(page)).toHaveText(label);
}

/** Number of notebooks titled `label` in the switcher (0 or 1). */
export async function notebookCount(page: Page, label: string): Promise<number> {
  const dialog = await openNotebookSwitcher(page);
  const count = await notebookOption(page, dialog, label).count();
  await page.keyboard.press('Escape');
  return count;
}

export async function renameActiveNotebook(page: Page, title: string): Promise<void> {
  const current = (await activeNotebookTitle(page).textContent())?.trim() ?? '';
  const dialog = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, dialog, current), 'Umbenennen');
  await submitInlineRename(page, title);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  await selectNotebookStably(page, title);
}

/** Creates a notebook and renames it once it is open. */
export async function addNamedNotebook(page: Page, title: string): Promise<void> {
  await createNotebook(page);
  await selectNotebookStably(page, 'Neues Notizbuch');
  await renameActiveNotebook(page, title);
}

/** Moves the open notebook to the trash through the switcher's context menu. */
export async function trashActiveNotebook(page: Page): Promise<void> {
  const current = (await activeNotebookTitle(page).textContent())?.trim() ?? '';
  const dialog = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, dialog, current), 'Löschen');
}

export function trashButton(page: Page) {
  return page.getByRole('button', { name: /^Papierkorb/ }).first();
}

export async function addText(page: Page, text: string): Promise<void> {
  // A personal-space catch-up can re-render the page right between tab
  // selection and click; retry the sequence instead of failing on that race.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await addTextFromRibbon(page);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  const editor = page.getByRole('textbox', { name: 'Gemeinsamer Text' }).last();
  await expect(editor).toBeFocused();
  await editor.fill(text);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
}

/** Closes the notebook switcher if it is open. */
export async function closeNotebookSwitcher(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /^(Notizbuch wechseln|Switch notebook)$/ });
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
}
