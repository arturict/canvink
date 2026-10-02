import { jsPDF } from 'jspdf';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect, openFileMenu, saveStatus, test } from './support';
import { polyglotPng, TINY_PNG } from '../fixtures/security/synthetic';

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
          .objectStore('documents-assets').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return keys.filter((key) => String(key).startsWith('asset:')).length;
    } finally {
      database.close();
    }
  });
}

function pdfWithExecutableSuffix(): Buffer {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  pdf.text('safe worksheet', 40, 60);
  return Buffer.concat([
    Buffer.from(pdf.output('arraybuffer')),
    Buffer.from('<script>window.__CANVINK_XSS__=true</script>'),
  ]);
}

test('polyglot PDF and PNG uploads fail atomically without exposing payload text', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const pageTitle = page.getByLabel(/Page title|Seitentitel/);
  const title = await pageTitle.inputValue();
  const assets = await storedAssetCount(page);

  await page.locator('input[type="file"][accept*="application/pdf"]').setInputFiles({
    name: 'polyglot.pdf', mimeType: 'application/pdf', buffer: pdfWithExecutableSuffix(),
  });
  await expect(page.locator('.v2-notice')).toContainText(/trailing data|corrupt|truncated/i);
  await expect(pageTitle).toHaveValue(title);
  expect(await storedAssetCount(page)).toBe(assets);

  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'polyglot.png', mimeType: 'image/png', buffer: Buffer.from(polyglotPng()),
  });
  await expect(page.locator('.v2-notice')).toContainText(/PNG.*trailing data|corrupt|truncated/i);
  await expect(pageTitle).toHaveValue(title);
  expect(await storedAssetCount(page)).toBe(assets);
  await expect(page.locator('body')).not.toContainText('__CANVINK_XSS__');
  expect(await page.evaluate(() => '__CANVINK_XSS__' in window)).toBe(false);
});

test('checksum-tampered .canvink import leaves the active workspace unchanged', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const pageTitle = page.getByLabel(/Page title|Seitentitel/);
  await pageTitle.fill('Security bundle authority');
  const assetsBefore = await storedAssetCount(page);
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG),
  });
  await expect.poll(() => storedAssetCount(page)).toBe(assetsBefore + 1);
  const assets = await storedAssetCount(page);

  await openFileMenu(page);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('menuitem', { name: 'Notizbuch .canvink', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Bundle download did not expose a local path.');
  const tampered = await readFile(path);
  const assetOffset = tampered.indexOf(Buffer.from(TINY_PNG));
  if (assetOffset < 0) throw new Error('Expected fixture asset bytes in canonical stored ZIP.');
  tampered[assetOffset + 32] ^= 1;

  await page.locator('input[type="file"][accept^=".canvink"]').setInputFiles({
    name: 'tampered.canvink', mimeType: 'application/zip', buffer: tampered,
  });
  await expect(page.locator('.v2-notice')).toContainText(/CRC-32|SHA-256|integrity|checksum/i);
  await expect(pageTitle).toHaveValue('Security bundle authority');
  await expect(page.getByRole('button', { name: 'Bundle-Import zurückrollen' })).toBeHidden();
  expect(await storedAssetCount(page)).toBe(assets);
});

test('hostile OneNote strings remain inert text during preview', async ({ page }) => {
  await page.addInitScript(() => {
    const title = '<img src=x onerror="window.__CANVINK_XSS__=true">';
    const preview = {
      kind: 'onenote-import-preview', version: 1, createdAt: '2026-08-03T10:00:00.000Z',
      notebooks: [{ sourceId: 'hostile-notebook', displayName: '<script>notebook-secret</script>', sections: [{
        sourceId: 'hostile-section', displayName: '<iframe srcdoc="frame-secret"></iframe>', order: 0,
        pages: [{ sourceId: 'hostile-page', title, order: 0, level: 0,
          blocks: [{ type: 'paragraph', content: [{ text: '<script>window.__CANVINK_XSS__=true</script>', marks: [] }] }],
          fidelity: { pageId: 'hostile-page', status: 'complete', issues: [], convertedBlockCount: 1 } }],
      }]}], resources: [],
      pageReports: [{ pageId: 'hostile-page', status: 'complete', issues: [], convertedBlockCount: 1 }],
      summary: { complete: 1, visual: 0, simplified: 0, unsupported: 0 },
    };
    (window as typeof window & { __CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__?: unknown })
      .__CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__ = {
        now: () => '2026-08-03T10:00:00.000Z',
        createAuth: () => ({
          initialize: async () => undefined,
          authorize: async () => ({ status: 'authorized', session: {
            accountId: 'fixture-account', username: 'security@example.test', expiresAt: '2026-08-03T18:00:00.000Z',
          } }),
          completeRedirect: async () => null, getAccessToken: async () => 'fixture-token',
          logout: async () => undefined, cancelPendingAuthorization: () => undefined, getSession: () => null,
        }),
        createGraphClient: () => ({ acquire: async () => { throw new Error('not used'); }, acquirePreview: async () => ({
          input: { notebooks: [], resources: [] }, preview, resourceBodies: [],
          stats: { requests: 1, retries: 0, metadataBytes: 128, pageHtmlBytes: 128, resourceBytes: 0 },
        }) }),
        createTarget: (runtime: { getState(): {
          activation: { artifactFingerprint: string; manifest: {
            notebookDocumentIds: string[]; pageDocumentIds: string[];
          } };
        } }) => ({ inspect: async () => {
          const state = runtime.getState();
          return {
            activationArtifactFingerprint: state.activation.artifactFingerprint,
            notebookDocumentIds: [...state.activation.manifest.notebookDocumentIds],
            pageDocumentIds: [...state.activation.manifest.pageDocumentIds],
          };
        } }),
      };
  });

  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: 'OneNote importieren' }).click();
  const dialog = page.getByRole('dialog', { name: 'OneNote sicher importieren' });
  await dialog.getByLabel('Anwendungs-ID (Client ID)').fill('11111111-1111-4111-8111-111111111111');
  await dialog.getByRole('button', { name: /Mit Microsoft anmelden/ }).click();
  await dialog.getByRole('button', { name: 'Notizbücher suchen' }).click();
  await expect(dialog).toContainText('<script>notebook-secret</script>');
  await expect(dialog).toContainText('<iframe srcdoc="frame-secret"></iframe>');
  await dialog.getByRole('button', { name: 'Auswahl prüfen' }).click();
  // The review lists page titles; the hostile title stays inert text.
  await expect(dialog).toContainText('<img src=x onerror="window.__CANVINK_XSS__=true">');
  await expect(dialog.locator('script, iframe, img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => '__CANVINK_XSS__' in window)).toBe(false);
});

test('corrupt v2 activation never falls back to plaintext v1 authority', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const marker = 'V1-PLAINTEXT-MUST-NOT-OPEN';
  await page.evaluate(async (secretMarker) => {
    async function open(databaseName: string): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async function put(database: IDBDatabase, storeName: string, key: IDBValidKey, value: unknown) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
    async function get(database: IDBDatabase, storeName: string, key: IDBValidKey) {
      return new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    const legacy = await open('keyval-store');
    await put(legacy, 'keyval', 'canvink:workspace:v1', { secretMarker });
    legacy.close();
    const v2 = await open('canvink-v2');
    const activation = await get(v2, 'documents-assets', 'activation:v2');
    await put(v2, 'documents-assets', 'activation:v2', { ...(activation as object), format: 'corrupt' });
    v2.close();
  }, marker);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', {
    name: /Workspace recovery required|Wiederherstellung des Arbeitsbereichs erforderlich/,
  })).toBeVisible();
  await expect(page.getByRole('application', { name: /Gemeinsame Seitenzeichenfläche|Shared page canvas/ })).toBeHidden();
  await expect(page.locator('body')).not.toContainText(marker);
  const legacyMarker = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('keyval-store');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = database.transaction('keyval', 'readonly').objectStore('keyval').get('canvink:workspace:v1');
        request.onsuccess = () => resolve((request.result as { secretMarker?: string } | undefined)?.secretMarker);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  });
  expect(legacyMarker).toBe(marker);
});
