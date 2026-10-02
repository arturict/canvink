import {
  activeNotebookTitle,
  contextCommand,
  createNotebook,
  expect,
  openNotebookSwitcher,
  openTopbarMore,
  saveStatus,
  switchNotebook,
  test,
  waitForSaved,
} from './support';
import type { Page } from '@playwright/test';

async function readIndexedDbValue(page: Page, options: {
  database: string;
  store: string;
  key: IDBValidKey;
}) {
  return page.evaluate(async ({ database, store, key }) => {
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = connection.transaction(store, 'readonly').objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      connection.close();
    }
  }, options);
}

test('first start verifies current-schema migration, edits live rich text, and reopens activation without v1 writes', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await expect(page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' })).toBeVisible();

  const activation = await readIndexedDbValue(page, {
    database: 'canvink-v2',
    store: 'documents-assets',
    key: 'activation:v2',
  });
  expect(activation).toMatchObject({
    schemaVersion: 3,
    format: 'canvink-automerge-v3',
    manifest: { schemaVersion: 3, format: 'canvink-schema-v3' },
  });
  const v1Before = JSON.stringify(await readIndexedDbValue(page, {
    database: 'keyval-store',
    store: 'keyval',
    key: 'canvink:workspace:v1',
  }));

  await openTopbarMore(page);
  await page.getByRole('menuitem', { name: 'Schnelle Notiz', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Gemeinsamer Text' }).last();
  await expect(editor).toBeFocused();
  await editor.fill('A canonical schema-v3 note');
  await page.getByLabel('Seitentitel').fill('Live vectors');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  const v1After = JSON.stringify(await readIndexedDbValue(page, {
    database: 'keyval-store',
    store: 'keyval',
    key: 'canvink:workspace:v1',
  }));
  expect(v1After).toBe(v1Before);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Live vectors');
  await expect(page.getByRole('textbox', { name: 'Gemeinsamer Text' }).filter({
    hasText: 'A canonical schema-v3 note',
  })).toBeVisible();
});

test('corrupt activation fails closed with recovery actions and no v1 fallback', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('canvink-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('documents-assets', 'readwrite');
        const store = transaction.objectStore('documents-assets');
        const request = store.get('activation:v2');
        request.onsuccess = () => {
          store.put({ ...request.result, format: 'corrupt' }, 'activation:v2');
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Wiederherstellung des Arbeitsbereichs erforderlich' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/activation is malformed/i);
  await expect(page.getByRole('button', { name: 'Geprüftes Öffnen wiederholen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wiederherstellungsbericht herunterladen' })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' })).toBeHidden();
});

test('live navigation and search return keyboard focus to the selected page title', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const title = page.getByLabel('Seitentitel');
  const currentTitle = await title.inputValue();
  const search = page.getByRole('combobox', { name: 'Arbeitsbereich lokal durchsuchen' });
  await search.fill(currentTitle);
  const result = page.getByRole('listbox', { name: 'Suchergebnisse' }).getByRole('option').first();
  await expect(result).toBeVisible();
  await result.focus();
  await result.press('Enter');
  await expect(title).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Notizbuchnavigation' })).toBeVisible();
});

test('schema-v3 hierarchy CRUD survives atomic activation revisions and reload', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });

  await createNotebook(page);
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch');

  await page.getByRole('button', { name: 'Erstellen', exact: true }).click();
  await page.getByRole('button', { name: 'Canvas-Seite', exact: true }).click();
  await expect(page.getByRole('button', { name: /Unbenannte Seite/ })).toHaveCount(2);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
  await contextCommand(page, page.locator('.page-row.is-active .page-row__target'), 'Duplizieren');
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite – Kopie');

  await contextCommand(page, page.locator('.page-row.is-active .page-row__target'), 'Löschen');
  await expect(page.getByLabel('Seitentitel')).not.toHaveValue('Unbenannte Seite – Kopie');

  await page.getByRole('button', { name: /^Papierkorb/ }).click();
  const trashDialog = page.getByRole('dialog', { name: 'Papierkorb' });
  await expect(trashDialog.getByRole('button', { name: 'Wiederherstellen' })).toBeVisible();
  await trashDialog.getByRole('button', { name: 'Wiederherstellen' }).click();
  // A restore commits only the notebook and the page it touches; it can
  // finish before a "saving" state is ever painted, so check its result.
  await expect(trashDialog.getByRole('button', { name: 'Wiederherstellen' })).toHaveCount(0);
  await waitForSaved(page);
  await trashDialog.getByRole('button', { name: 'Papierkorb schliessen' }).click();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const switcher = await openNotebookSwitcher(page);
  await expect(switcher.locator('.notebook-switcher__option-title', { hasText: /^Neues Notizbuch$/ })).toHaveCount(1);
  await switchNotebook(page, 'Neues Notizbuch');
  await expect(page.getByRole('button', { name: /Unbenannte Seite – Kopie/ })).toBeVisible();
});

test('the page list marks the page the title shows, and deleting a duplicate that is still opening removes it', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await createNotebook(page);
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');

  // Records every painted state in which the title and the marked row of the
  // page list name different pages.
  await page.evaluate(() => {
    const disagreements: string[] = [];
    (window as unknown as { __disagreements: string[] }).__disagreements = disagreements;
    new MutationObserver(() => {
      const title = document.querySelector<HTMLInputElement>('input[aria-label="Seitentitel"]')?.value;
      const marked = document.querySelector('.page-row.is-active .page-row__title')?.textContent;
      if (title !== undefined && marked !== undefined && marked !== null && title !== marked) {
        disagreements.push(`${title} | ${marked}`);
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });

  await contextCommand(page, page.locator('.page-row.is-active .page-row__target'), 'Duplizieren');
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite – Kopie');
  await expect(page.locator('.page-row.is-active .page-row__title')).toHaveText('Unbenannte Seite – Kopie');
  expect(await page.evaluate(() => (window as unknown as { __disagreements: string[] }).__disagreements)).toEqual([]);

  // Right-click and delete without waiting for the copy to finish opening.
  await contextCommand(page, page.locator('.page-row.is-active .page-row__target'), 'Löschen');
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');
  await expect(page.getByRole('button', { name: /Unbenannte Seite – Kopie/ })).toHaveCount(0);
});

test('page copy and move cross notebook boundaries atomically', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await createNotebook(page);
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');

  // Copy and move live in the page list's context menu, not in page settings.
  const activeRow = page.locator('.page-row.is-active .page-row__target');
  const dialog = page.getByRole('dialog', { name: 'Seite verschieben oder kopieren' });
  await contextCommand(page, activeRow, 'Verschieben oder kopieren…');
  await dialog.getByRole('combobox').fill('Beispiele');
  await dialog.getByRole('option', { name: /Beispiele/ }).click();
  await dialog.getByRole('button', { name: 'Kopieren', exact: true }).click();
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite – Kopie');
  await expect(activeNotebookTitle(page)).toHaveText('Notizbuch');

  await contextCommand(page, activeRow, 'Verschieben oder kopieren…');
  await dialog.getByRole('combobox').fill('Neuer Abschnitt');
  await dialog.getByRole('option', { name: /Neuer Abschnitt/ }).first().click();
  await dialog.getByRole('button', { name: 'Verschieben', exact: true }).click();
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch');
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite – Kopie');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite – Kopie');
});
