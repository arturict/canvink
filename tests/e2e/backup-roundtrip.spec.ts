import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { readCanvinkBundle } from '../../src/io/canvinkBundle';
import { acceptConfirm, expect, gotoApp, openFileMenu, openTopbarMore, saveStatus, test, waitForAutosave } from './support';

function crc32(bytes: Buffer): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function fixturePng(width = 96, height = 64): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      rows.set([40, 110 + (y % 80), 210, 255], row + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function activation(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('canvink-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{
        schemaVersion: number;
        format: string;
        manifest: {
          schemaVersion: number;
          format: string;
          notebookDocumentIds: string[];
          pageDocumentIds: string[];
        };
      }>((resolve, reject) => {
        const request = database.transaction('documents-assets', 'readonly')
          .objectStore('documents-assets').get('activation:v2');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
}

async function importBundle(page: Page, bytes: Buffer): Promise<string> {
  const notice = page.locator('.v2-notice');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator('input[type="file"][accept^=".canvink"]').setInputFiles({
      name: 'current-schema-backup.canvink',
      mimeType: 'application/vnd.canvink.bundle+zip',
      buffer: bytes,
    });
    const confirmation = await acceptConfirm(page);
    await expect(notice).toContainText(
      /Bundle additiv importiert|Bundle imported additively|active workspace changed after the import preview/i,
    );
    const result = await notice.textContent() ?? '';
    if (/importiert|imported/i.test(result)) return confirmation;
    if (!/active workspace changed after the import preview/i.test(result)) {
      throw new Error(`Unexpected bundle import result: ${result}`);
    }
  }
  throw new Error('Bundle import stayed stale after one guarded retry.');
}

test('current-schema .canvink backup verifies, mounts, reloads CRDT/assets, and rolls back guardedly', async ({ page }) => {
  await gotoApp(page);
  const pageTitle = page.getByLabel(/Page title|Seitentitel/);
  const originalTitle = 'Schema-v3 backup sentinel';
  const originalBody = 'Automerge content must survive the verified bundle round-trip.';
  const sourceMutation = 'Source changed after the backup';
  const image = fixturePng();

  await pageTitle.fill(originalTitle);
  await openTopbarMore(page);
  await page.getByRole('menuitem', { name: /^(Quick note|Schnelle Notiz)$/ }).click();
  const sourceEditor = page.getByRole('textbox', { name: /Shared text|Gemeinsamer Text/ }).last();
  await sourceEditor.fill(originalBody);
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'backup-asset.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByRole('img', { name: 'backup-asset' })).toBeVisible();
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  await openFileMenu(page);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('menuitem', { name: /Notebook \.canvink|Notizbuch \.canvink/ }).click();
  const download = await downloadPromise;
  const exportPath = await download.path();
  if (!exportPath) throw new Error('Current-schema bundle download did not expose a local path.');
  const bundleBytes = await readFile(exportPath);
  await download.delete();

  const verified = await readCanvinkBundle(new Uint8Array(bundleBytes));
  expect(verified.manifest).toMatchObject({
    format: 'canvink',
    formatVersion: 3,
    schemaVersion: 3,
    generator: 'canvink-v3',
  });
  expect(verified.pages.length).toBeGreaterThan(0);
  expect(verified.assets).toHaveLength(1);
  expect(Buffer.from(verified.assets[0].bytes)).toEqual(image);
  expect(verified.notebook.bytes.byteLength).toBeGreaterThan(100);
  expect(verified.pages.every((document) => document.bytes.byteLength > 100)).toBe(true);

  await pageTitle.fill(sourceMutation);
  await sourceEditor.fill('Mutation that must remain isolated in the source notebook.');
  await waitForAutosave(page);
  const sourceActivation = await activation(page);

  const firstImportConfirmation = await importBundle(page, bundleBytes);
  expect(firstImportConfirmation).toMatch(/new notebook|neues Notizbuch|additiv/i);
  await expect(pageTitle).toHaveValue(originalTitle);
  await expect(page.getByRole('img', { name: 'backup-asset' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Shared text|Gemeinsamer Text/ }).filter({ hasText: originalBody })).toBeVisible();
  const mounted = await activation(page);
  expect(mounted).toMatchObject({
    schemaVersion: 3,
    format: 'canvink-automerge-v3',
    manifest: { schemaVersion: 3, format: 'canvink-schema-v3' },
  });
  expect(mounted.manifest.notebookDocumentIds.length).toBeGreaterThan(1);
  expect(mounted.manifest.pageDocumentIds.length).toBeGreaterThan(verified.pages.length);

  await openFileMenu(page);
  const rollbackButton = page.getByRole('menuitem', { name: /Roll back bundle import|Bundle-Import zurückrollen/ });
  await rollbackButton.click();
  expect(await acceptConfirm(page)).toMatch(/fully roll back|vollständig zurückrollen/i);
  await expect(rollbackButton).toBeHidden();
  await expect(page.locator('.v2-notice')).toContainText(/rolled back|zurückgerollt/i);
  const rolledBack = await activation(page);
  expect(rolledBack.manifest.notebookDocumentIds).toEqual(sourceActivation.manifest.notebookDocumentIds);
  expect(rolledBack.manifest.pageDocumentIds).toEqual(sourceActivation.manifest.pageDocumentIds);

  const secondImportConfirmation = await importBundle(page, bundleBytes);
  expect(secondImportConfirmation).toMatch(/new notebook|neues Notizbuch|additiv/i);
  await expect(pageTitle).toHaveValue(originalTitle);
  await expect(page.getByRole('img', { name: 'backup-asset' })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await expect(pageTitle).toHaveValue(originalTitle);
  await expect(page.getByRole('img', { name: 'backup-asset' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Shared text|Gemeinsamer Text/ }).filter({ hasText: originalBody })).toBeVisible();
  const reopened = await activation(page);
  expect(reopened).toMatchObject({
    schemaVersion: 3,
    format: 'canvink-automerge-v3',
    manifest: { schemaVersion: 3, format: 'canvink-schema-v3' },
  });
  expect(reopened.manifest.notebookDocumentIds.length).toBeGreaterThan(1);
});
