import { expect, gotoApp, test } from './support';
import { PDFDocument } from 'pdf-lib';

test('reviews, retries, applies, navigates, and rolls back a mocked OneNote import', async ({ page }) => {
  await page.addInitScript(() => {
    const graphInput = {
      notebooks: [{
        id: 'school-notebook', displayName: 'Schule 2026', sections: [{
          id: 'physics-section', displayName: 'Physik', order: 0, pages: [{
            id: 'forces-page', title: 'Eingeführte Kräfte', order: 0,
            html: '<p data-tag="important, to-do">Kraft gleich Masse mal Beschleunigung.</p>',
          }],
        }, {
          id: 'archive-section', displayName: 'Archiv', order: 1, pages: [{
            id: 'archive-page', title: 'Alte Skizze', order: 0,
            html: '<p style="color:red">Skizze</p>',
          }],
        }],
      }],
      resources: [],
    };
    const preview = {
      kind: 'onenote-import-preview',
      version: 1,
      createdAt: '2026-08-03T10:00:00.000Z',
      notebooks: [{
        sourceId: 'school-notebook',
        displayName: 'Schule 2026',
        sections: [{
          sourceId: 'physics-section',
          displayName: 'Physik',
          order: 0,
          pages: [{
            sourceId: 'forces-page',
            title: 'Eingeführte Kräfte',
            order: 0,
            level: 0,
            blocks: [{
              type: 'paragraph',
              content: [{ text: 'Kraft gleich Masse mal Beschleunigung.', marks: [{ type: 'bold' }] }],
            }],
            fidelity: {
              pageId: 'forces-page',
              status: 'complete',
              issues: [],
              convertedBlockCount: 1,
            },
          }],
        }, {
          sourceId: 'archive-section',
          displayName: 'Archiv',
          order: 1,
          pages: [{
            sourceId: 'archive-page',
            title: 'Alte Skizze',
            order: 0,
            level: 0,
            blocks: [{ type: 'paragraph', content: [{ text: 'Skizze', marks: [] }] }],
            fidelity: {
              pageId: 'archive-page',
              status: 'simplified',
              issues: [{ code: 'style-dropped', severity: 'simplified', message: 'Schatten wurde vereinfacht.' }],
              convertedBlockCount: 1,
            },
          }],
        }],
      }],
      resources: [],
      pageReports: [
        { pageId: 'forces-page', status: 'complete', issues: [], convertedBlockCount: 1 },
        {
          pageId: 'archive-page', status: 'simplified', convertedBlockCount: 1,
          issues: [{ code: 'style-dropped', severity: 'simplified', message: 'Schatten wurde vereinfacht.' }],
        },
      ],
      summary: { complete: 1, visual: 0, simplified: 1, unsupported: 0 },
    };
    let failFirstCommit = true;
    (window as typeof window & { __CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__?: unknown })
      .__CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__ = {
        now: () => '2026-08-03T10:00:00.000Z',
        createAuth: () => ({
          initialize: async () => undefined,
          authorize: async () => ({
            status: 'authorized',
            session: {
              accountId: 'fixture-account',
              username: 'schueler@example.test',
              expiresAt: '2026-08-03T18:00:00.000Z',
            },
          }),
          completeRedirect: async () => null,
          getAccessToken: async () => 'fixture-token',
          logout: async () => undefined,
          cancelPendingAuthorization: () => undefined,
          getSession: () => null,
        }),
        createGraphClient: () => ({
          acquire: async () => { throw new Error('not used'); },
          acquirePreview: async () => ({
            input: graphInput,
            preview,
            resourceBodies: [],
            stats: { requests: 8, retries: 0, metadataBytes: 512, pageHtmlBytes: 256, resourceBytes: 0 },
          }),
        }),
        createPdfPreviewRenderer: () => ({
          renderPage: async () => ({
            bytes: Uint8Array.from(
              atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
              (character) => character.charCodeAt(0),
            ),
            mimeType: 'image/png',
            width: 1,
            height: 1,
          }),
        }),
        createTarget: (runtime: {
          getState(): {
            schemaVersion: number;
            activation: { artifactFingerprint: string; manifest: { notebookDocumentIds: string[]; pageDocumentIds: string[] }; assetIds: string[] };
          };
          beginAdditiveImport(request: unknown): Promise<{
            addAssets(assets: unknown[]): Promise<void>;
            addPage(page: unknown): Promise<void>;
            progress(): unknown;
            commit(fingerprint: string): Promise<unknown>;
            abort(): Promise<void>;
          }>;
          rollbackWorkspaceImport(importId: string): Promise<unknown>;
        }) => ({
          inspect: async () => {
            const state = runtime.getState();
            return {
              schemaVersion: 3,
              activationArtifactFingerprint: state.activation.artifactFingerprint,
              notebookDocumentIds: [...state.activation.manifest.notebookDocumentIds],
              pageDocumentIds: [...state.activation.manifest.pageDocumentIds],
            };
          },
          begin: async (request: { importId: string; preparedAt: string; notebook: unknown }) => {
            const writer = await runtime.beginAdditiveImport(request);
            return {
              addAssets: (assets: unknown[]) => writer.addAssets(assets),
              addPage: (page: unknown) => writer.addPage(page),
              progress: () => writer.progress(),
              commit: async (fingerprint: string) => {
                if (failFirstCommit) {
                  failFirstCommit = false;
                  await writer.abort();
                  throw new Error('Simulierter Verbindungsabbruch vor dem Beleg.');
                }
                return writer.commit(fingerprint);
              },
              abort: () => writer.abort(),
            };
          },
          verify: async (result: { artifactFingerprint: string; notebookDocumentId: string; pageDocumentIds: string[]; assetIds: string[] }) => {
            const state = runtime.getState();
            if (state.activation.artifactFingerprint !== result.artifactFingerprint) throw new Error('fixture verify failed');
          },
          rollback: (importId: string) => runtime.rollbackWorkspaceImport(importId),
        }),
      };
  });

  await gotoApp(page);
  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: 'OneNote importieren' }).click();
  const dialog = page.getByRole('dialog', { name: 'OneNote sicher importieren' });
  await expect(dialog).toContainText('Notes.Read');
  await expect(dialog).toContainText('niemals Notes.ReadWrite');
  await dialog.getByLabel('Anwendungs-ID (Client ID)').fill('11111111-1111-4111-8111-111111111111');
  await dialog.getByRole('button', { name: /Mit Microsoft anmelden/ }).click();
  await expect(dialog).toContainText('schueler@example.test');

  await dialog.getByRole('button', { name: 'Notizbücher suchen' }).click();
  await expect(dialog.getByLabel('Schule 2026')).toBeChecked();
  await dialog.getByLabel(/Archiv/).uncheck();
  await dialog.getByLabel(/Archiv/).check();
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const pdfBytes = await pdf.save();
  const fallbackInput = dialog.getByLabel('PDF-Ersatz für Eingeführte Kräfte auswählen');
  await fallbackInput.setInputFiles({ name: 'forces.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) });
  await expect(dialog.getByRole('button', { name: 'PDF entfernen' }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'PDF entfernen' }).first().click();
  await expect(fallbackInput).toBeVisible();
  await fallbackInput.setInputFiles({ name: 'forces.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) });
  await expect(dialog.getByRole('button', { name: 'PDF entfernen' }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Auswahl prüfen' }).click();

  await expect(dialog).toContainText('Geprüfter Fingerabdruck');
  await dialog.getByRole('button', { name: 'Visuell erhalten' }).click();
  await expect(dialog).toContainText('Gesperrter PDF-Hintergrund wird verwendet.');
  await dialog.getByRole('button', { name: 'Vereinfacht' }).click();
  await expect(dialog).toContainText('Eine Formatierung wurde vereinfacht.');
  await dialog.getByRole('checkbox', { name: /Ich bestätige genau diesen Fingerabdruck/ }).check();
  await dialog.getByRole('button', { name: 'Additiv importieren' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Simulierter Verbindungsabbruch');

  await dialog.getByRole('button', { name: 'Additiv importieren' }).click();
  await expect(dialog).toContainText('Import abgeschlossen');
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Eingeführte Kräfte');
  await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: /Import zurücknehmen/ }).click();
  await expect(dialog).toContainText('Notizbuch und Abschnitte auswählen');
  await page.reload();
  await expect(page.getByLabel('Seitentitel')).not.toHaveValue('Eingeführte Kräfte');
  await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(0);
});
