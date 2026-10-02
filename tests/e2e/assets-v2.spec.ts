import { jsPDF } from 'jspdf';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { acceptConfirm, expect, openFileMenu, openTopbarMore, saveStatus, test } from './support';

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

function fixturePng(width = 120, height = 80): Buffer {
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

function worksheetPdf(): Buffer {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  pdf.setFontSize(24);
  pdf.text('Mathematik Arbeitsblatt 1', 72, 96);
  pdf.setFontSize(14);
  pdf.text('7 + 5 =', 72, 150);
  pdf.addPage();
  pdf.setFontSize(24);
  pdf.text('Mathematik Arbeitsblatt 2', 72, 96);
  pdf.setFontSize(14);
  pdf.text('12 - 4 =', 72, 150);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function storedAssetCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('canvink-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction('documents-assets', 'readonly')
          .objectStore('documents-assets')
          .getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return keys.filter((key) => String(key).startsWith('asset:')).length;
    } finally {
      database.close();
    }
  });
}

test('verified images deduplicate, attachments reopen, and both persist after reload', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const before = await storedAssetCount(page);
  const imageInput = page.locator('input[type="file"][accept^="image/png"]');
  const image = { name: 'diagram.png', mimeType: 'image/png', buffer: PNG_BYTES };

  await imageInput.setInputFiles(image);
  await expect(page.getByRole('img', { name: 'diagram' })).toBeVisible();
  await imageInput.setInputFiles(image);
  await expect(page.getByRole('img', { name: 'diagram' })).toHaveCount(2);
  expect(await storedAssetCount(page)).toBe(before + 1);

  await page.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'lesson.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Local-first lesson handout'),
  });
  const attachment = page.getByLabel('Anhang lesson.txt');
  await expect(attachment).toBeVisible();
  await expect(attachment.getByRole('button', { name: 'Öffnen' })).toBeVisible();
  await expect(attachment.getByRole('button', { name: 'Laden' })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await expect(page.getByRole('img', { name: 'diagram' })).toHaveCount(2);
  await expect(page.getByLabel('Anhang lesson.txt')).toBeVisible();
});

test('multi-page PDF becomes an ordered printout on the active page and exports with annotations', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const originalTitle = await page.getByLabel('Seitentitel').inputValue();
  await page.locator('input[type="file"][accept*="application/pdf"]').setInputFiles({
    name: 'worksheet.pdf',
    mimeType: 'application/pdf',
    buffer: worksheetPdf(),
  });

  await expect(page.getByRole('img', { name: 'PDF Seite 1' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('img', { name: 'PDF Seite 2' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Seitentitel')).toHaveValue(originalTitle);
  const firstBox = await page.getByRole('img', { name: 'PDF Seite 1' }).first().boundingBox();
  const secondBox = await page.getByRole('img', { name: 'PDF Seite 2' }).first().boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.y).toBeGreaterThan(firstBox!.y + firstBox!.height);
  await openTopbarMore(page);
  await page.getByRole('menuitem', { name: 'Schnelle Notiz', exact: true }).click();
  await page.getByRole('textbox', { name: 'Gemeinsamer Text' }).last().fill('Lösung: 12');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  await openFileMenu(page);
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('menuitem', { name: 'Abschnitt PDF', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  expect(bytes.byteLength).toBeGreaterThan(worksheetPdf().byteLength);
  if (process.env.CANVINK_PDF_QA_PATH) await writeFile(process.env.CANVINK_PDF_QA_PATH, bytes);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('img', { name: 'PDF Seite 1' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('img', { name: 'PDF Seite 2' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('textbox', { name: 'Gemeinsamer Text' }).filter({ hasText: 'Lösung: 12' })).toBeVisible();
});

test('corrupt PDF is rejected without creating a page and bundle import is additive and reversible', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const originalTitle = await page.getByLabel('Seitentitel').inputValue();
  await page.locator('input[type="file"][accept*="application/pdf"]').setInputFiles({
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('not a PDF'),
  });
  await expect(page.locator('.v2-notice')).toContainText(/PDF header is invalid|supported byte limits/);
  await expect(page.getByLabel('Seitentitel')).toHaveValue(originalTitle);

  await page.getByLabel('Seitentitel').fill('Bundle source');
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'bundle-image.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  });
  await expect(page.getByRole('img', { name: 'bundle-image' })).toBeVisible();
  await openFileMenu(page);
  const bundleDownload = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('menuitem', { name: 'Notizbuch .canvink', exact: true }).click();
  const downloaded = await bundleDownload;
  const path = await downloaded.path();
  if (!path) throw new Error('Bundle download did not expose a local path.');

  await page.locator('input[type="file"][accept^=".canvink"]').setInputFiles(path);
  await acceptConfirm(page);
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Bundle source');
  await expect(page.getByRole('img', { name: 'bundle-image' })).toBeVisible();
  await expect(page.locator('.v2-notice')).toContainText('additiv importiert');
  await openFileMenu(page);
  await expect(page.getByRole('menuitem', { name: 'Bundle-Import zurückrollen', exact: true })).toBeVisible();

  await page.getByRole('menuitem', { name: 'Bundle-Import zurückrollen', exact: true }).click();
  await acceptConfirm(page);
  await openFileMenu(page);
  await expect(page.getByRole('menuitem', { name: 'Bundle-Import zurückrollen', exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.v2-notice')).toContainText('zurückgerollt');
});
