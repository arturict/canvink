import { readFile } from 'node:fs/promises';
import {
  armOneShotIndexedDbWriteFailure,
  createQuickNote,
  editSelectedText,
  expect,
  gotoApp,
  installOneShotIndexedDbWriteFailure,
  saveStatus,
  test,
  waitForAutosave,
  waitForSaved,
} from './support';

interface E2eWorkspace {
  updatedAt: string;
  activeNotebookId: string;
  activeSectionId: string;
  activePageId: string;
  notebooks: Array<{
    id: string;
    sections: Array<{
      id: string;
      pages: Array<{
        id: string;
        title: string;
        updatedAt: string;
        elements: Array<{
          kind: string;
          text?: string;
          updatedAt: string;
        }>;
      }>;
    }>;
  }>;
}

test('one failed local save stays actionable and recovers without losing the edit', async ({
  page,
}) => {
  await installOneShotIndexedDbWriteFailure(page);
  await gotoApp(page);
  await page.getByRole('button', { name: 'Quick note', exact: true }).click();
  await waitForAutosave(page);
  await armOneShotIndexedDbWriteFailure(page);

  const title = 'Recovered after a local write error';
  const body = 'This exact unsaved body must be present in the rescue copy.';
  await page.getByLabel('Page title').fill(title);
  await (await editSelectedText(page)).fill(body);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'error');

  const saveAlert = page.getByRole('alert').filter({
    has: page.getByRole('button', { name: /Retry save/i }),
  });
  await expect(saveAlert).toBeVisible();
  await expect(
    saveAlert.getByRole('button', { name: /Download rescue copy/i }),
  ).toBeEnabled();

  const rescueDownload = page.waitForEvent('download');
  await saveAlert.getByRole('button', { name: /Download rescue copy/i }).click();
  const rescue = await rescueDownload;
  expect(rescue.suggestedFilename()).toMatch(/\.(?:canvink|json)$/i);
  const rescuePath = await rescue.path();
  expect(rescuePath).not.toBeNull();
  const rescuePayload = JSON.parse(await readFile(rescuePath!, 'utf8'));
  const serializedRescue = JSON.stringify(rescuePayload);
  expect(serializedRescue).toContain(title);
  expect(serializedRescue).toContain(body);
  await rescue.delete();
  await expect(saveAlert).toBeVisible();

  await page.evaluate(() => {
    URL.createObjectURL = () => {
      throw new Error('Canvink E2E blocked the rescue download.');
    };
  });
  await saveAlert.getByRole('button', { name: /Download rescue copy/i }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: /Rescue copy download failed.*blocked the rescue download/i,
    }),
  ).toBeVisible();
  await expect(saveAlert).toBeVisible();

  await saveAlert.getByRole('button', { name: /Retry save/i }).click();
  await waitForSaved(page);
  await expect(saveAlert).toBeHidden();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByLabel('Page title')).toHaveValue(title);
  await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
  await expect(await editSelectedText(page)).toHaveValue(body);
});

test('a crash draft is reviewed explicitly, restored, and then saved durably', async ({
  page,
}) => {
  await gotoApp(page);
  await createQuickNote(page, {
    title: 'Last saved copy',
    body: 'This content is safely in the primary workspace.',
  });

  const savedWorkspace = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = database
          .transaction('keyval', 'readonly')
          .objectStore('keyval')
          .get('canvink:workspace:v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }) as E2eWorkspace;

  const recoveredTitle = 'Recovered crash draft';
  const recoveredBody = 'This edit existed only in the temporary recovery journal.';
  const recoveredWorkspace = structuredClone(savedWorkspace);
  const activeNotebook = recoveredWorkspace.notebooks.find(
    (notebook) => notebook.id === recoveredWorkspace.activeNotebookId,
  );
  const activeSection = activeNotebook?.sections.find(
    (section) => section.id === recoveredWorkspace.activeSectionId,
  );
  const activePage = activeSection?.pages.find(
    (candidate) => candidate.id === recoveredWorkspace.activePageId,
  );
  const activeText = activePage?.elements.find((element) => element.kind === 'text');
  expect(activePage).toBeDefined();
  expect(activeText).toBeDefined();
  const recoveredAt = new Date(Date.now() + 1_000).toISOString();
  recoveredWorkspace.updatedAt = recoveredAt;
  activePage!.title = recoveredTitle;
  activePage!.updatedAt = recoveredAt;
  activeText!.text = recoveredBody;
  activeText!.updatedAt = recoveredAt;

  await page.evaluate(async ({ workspace, capturedAt }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('keyval', 'readwrite');
        transaction
          .objectStore('keyval')
          .put(
            {
              version: 1,
              sessionId: 'e2e-interrupted-session',
              revision: 5,
              capturedAt,
              workspace,
            },
            'canvink:recovery:v1',
          );
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { workspace: recoveredWorkspace, capturedAt: recoveredAt });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const recoveryDialog = page.getByRole('dialog', {
    name: /Resume your last editing draft/i,
  });
  await expect(recoveryDialog).toBeVisible();
  await expect(recoveryDialog).toContainText(/has not replaced your last saved workspace/i);

  const draftDownload = page.waitForEvent('download');
  await recoveryDialog.getByRole('button', { name: /Download draft first/i }).click();
  const downloadedDraft = await draftDownload;
  const draftPath = await downloadedDraft.path();
  expect(draftPath).not.toBeNull();
  expect(await readFile(draftPath!, 'utf8')).toContain(recoveredBody);
  await downloadedDraft.delete();

  await recoveryDialog.getByRole('button', { name: /Restore unsaved draft/i }).click();
  await waitForAutosave(page);
  await expect(page.getByLabel('Page title')).toHaveValue(recoveredTitle);
  await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
  await expect(await editSelectedText(page)).toHaveValue(recoveredBody);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByRole('dialog', { name: /Resume your last editing draft/i })).toBeHidden();
  await expect(page.getByLabel('Page title')).toHaveValue(recoveredTitle);
  await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
  await expect(await editSelectedText(page)).toHaveValue(recoveredBody);
});

test('offline after load still permits local capture and reports connectivity honestly', async ({
  context,
  page,
}) => {
  await gotoApp(page);

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const offlineStatus = page.getByTestId('offline-status');
  await expect(offlineStatus).toBeVisible();
  await expect(offlineStatus).toContainText(/offline|local/i);

  await createQuickNote(page, {
    title: 'Offline field note',
    body: 'This note was saved to IndexedDB while the network was unavailable.',
  });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  await expect(offlineStatus).toBeHidden();
});

test('an invalid portable import is explained and leaves the open note intact', async ({
  page,
}) => {
  await gotoApp(page);
  const originalTitle = 'Import protection sentinel';
  const originalBody = 'Malformed imports must not replace this distinctive local note.';
  await createQuickNote(page, {
    title: originalTitle,
    body: originalBody,
  });

  const portableInput = page.locator(
    'input[type="file"][accept*="application/json"]',
  );
  await portableInput.setInputFiles({
    name: 'broken-workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":'),
  });

  const importError = page
    .locator('[role="alert"], [role="status"]')
    .filter({ hasText: /invalid|malformed|JSON|import/i })
    .last();
  await expect(importError).toBeVisible();
  await expect(page.getByLabel('Page title')).toHaveValue(originalTitle);
  await expect(page.getByPlaceholder('Write your note')).toHaveValue(originalBody);
  await waitForSaved(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByLabel('Page title')).toHaveValue(originalTitle);
  await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
  await expect(await editSelectedText(page)).toHaveValue(originalBody);
});

test('empty page, search, and trash states expose an immediate next action', async ({
  page,
}) => {
  await gotoApp(page);

  await page.getByRole('button', { name: 'New page', exact: true }).first().click();
  const pageEmpty = page.locator('[data-empty-kind="page"]');
  await expect(pageEmpty).toBeVisible();
  await expect(pageEmpty).toContainText(/\S/);
  const pageAction = pageEmpty.getByRole('button').first();
  await expect(pageAction).toBeEnabled();
  await pageAction.click();
  await expect(page.getByPlaceholder('Write your note')).toBeFocused();

  const impossibleQuery = 'no-result-7f80f248';
  const search = page.getByRole('searchbox', { name: 'Search workspace' });
  await search.fill(impossibleQuery);
  const searchEmpty = page.locator('[data-empty-kind="search"]');
  await expect(searchEmpty).toBeVisible();
  await expect(searchEmpty).toContainText(/\S/);
  const searchAction = searchEmpty.getByRole('button').first();
  await expect(searchAction).toBeEnabled();
  await searchAction.click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.getByRole('region', { name: /Search results/i })).toBeHidden();

  await search.fill(impossibleQuery);
  await expect(searchEmpty).toBeVisible();
  await searchEmpty.getByRole('button', { name: /Quick note/i }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('region', { name: /Search results/i })).toBeHidden();
  await expect(page.getByPlaceholder('Write your note')).toBeFocused();

  await page.getByRole('button', { name: /^Trash/i }).click();
  const trashEmpty = page.locator('[data-empty-kind="trash"]');
  await expect(trashEmpty).toBeVisible();
  await expect(trashEmpty).toContainText(/\S/);
  const trashAction = trashEmpty.getByRole('button').first();
  await expect(trashAction).toBeEnabled();
  await trashAction.click();
  await expect(page.getByRole('dialog', { name: /Trash/i })).toBeHidden();
});

test('canvas accessibility summaries stay bounded without truncating note content', async ({
  page,
}) => {
  await gotoApp(page);
  const tailSentinel = 'TAIL-SENTINEL-MUST-STAY-IN-THE-EDITOR';
  const body = `${'Long accessible note content. '.repeat(220)}${tailSentinel}`;
  const editor = await createQuickNote(page, {
    title: 'Bounded accessibility summary',
    body,
  });

  const objectSummary = page
    .getByRole('list', { name: /Canvas objects/i })
    .getByRole('listitem');
  const summaryText = (await objectSummary.textContent()) ?? '';

  expect(summaryText).toMatch(/^Text: /);
  expect(summaryText.length).toBeLessThan(180);
  expect(summaryText).not.toContain(tailSentinel);
  await expect(editor).toHaveValue(body);
});
