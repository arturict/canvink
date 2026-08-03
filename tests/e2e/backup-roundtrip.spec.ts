import { readFile } from 'node:fs/promises';
import {
  createQuickNote,
  editSelectedText,
  expect,
  gotoApp,
  test,
  waitForAutosave,
  waitForSaved,
} from './support';

test('workspace JSON export restores hierarchy and note content after replacement', async ({
  page,
}) => {
  await gotoApp(page);
  const originalTitle = 'Portable backup sentinel';
  const originalBody = 'The exported workspace must restore this exact note body.';
  await createQuickNote(page, { title: originalTitle, body: originalBody });

  await page.locator('details.action-menu--right > summary').click();
  const exportDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Workspace JSON', exact: true }).click();
  const exportDownload = await exportDownloadPromise;
  const exportPath = await exportDownload.path();
  expect(exportPath).not.toBeNull();
  const exportedWorkspace = await readFile(exportPath!);
  expect(JSON.parse(exportedWorkspace.toString('utf8')).schemaVersion).toBe(1);
  await exportDownload.delete();

  await page.getByLabel('Page title').fill('Changed after backup');
  await (await editSelectedText(page)).fill('This mutation must be replaced by import.');
  await waitForAutosave(page);

  const confirmationMessages: string[] = [];
  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined,
    });
  });
  page.on('dialog', async (dialog) => {
    confirmationMessages.push(dialog.message());
    await dialog.accept();
  });

  const backupDownloadPromise = page.waitForEvent('download');
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: 'canvink-roundtrip.json',
    mimeType: 'application/json',
    buffer: exportedWorkspace,
  });
  const replacementBackup = await backupDownloadPromise;
  await replacementBackup.delete();

  await expect.poll(() => confirmationMessages.length).toBe(2);
  expect(confirmationMessages[0]).toMatch(/Replace this entire workspace/i);
  expect(confirmationMessages[1]).toMatch(/backup download finished/i);
  await expect(page.getByLabel('Page title')).toHaveValue(originalTitle);
  await waitForAutosave(page);
  await expect(await editSelectedText(page)).toHaveValue(originalBody);
  await expect(page.getByRole('combobox', { name: 'Notebook' })).toHaveValue(
    /.+/,
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByLabel('Page title')).toHaveValue(originalTitle);
  await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
  await expect(await editSelectedText(page)).toHaveValue(originalBody);
});
