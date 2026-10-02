import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, gotoApp, test } from './support';

const ONE = 'http://schemas.microsoft.com/office/onenote/2013/onenote';

/** A OneNote page whose only text box sits `y` points below the page origin and `x` points from its left edge. */
function pageXml(id: string, title: string, text: string, x: number, y: number): string {
  return `<?xml version="1.0"?>
<one:Page xmlns:one="${ONE}" ID="${id}" name="${title}" pageLevel="1">
  <one:QuickStyleDef index="0" name="PageTitle" font="Calibri Light" fontSize="20.0" spaceBefore="0.0" spaceAfter="0.0"/>
  <one:QuickStyleDef index="1" name="p" font="Calibri" fontSize="11.0" spaceBefore="0.0" spaceAfter="0.0"/>
  <one:Title><one:OE quickStyleIndex="0"><one:T><![CDATA[${title}]]></one:T></one:OE></one:Title>
  <one:Outline>
    <one:Position x="${x}" y="${y}" z="0"/><one:Size width="300.0" height="40.0"/>
    <one:OEChildren><one:OE quickStyleIndex="1"><one:T><![CDATA[${text}]]></one:T></one:OE></one:OEChildren>
  </one:Outline>
</one:Page>`;
}

async function writeExport(folder: string): Promise<void> {
  const pages = [
    { id: '{N1}{1}{B0}', title: 'Oben', text: 'Text am Seitenanfang', x: 36, y: 86.4 },
    { id: '{N2}{1}{B0}', title: 'Weit unten', text: 'Text tief unten auf der Seite', x: 36, y: 2400 },
    { id: '{N3}{1}{B0}', title: 'Weit rechts', text: 'Text weit rechts auf der Seite', x: 1800, y: 900 },
  ];
  const manifest = {
    format: 'canvink-onenote-desktop-export',
    version: 1,
    exportedAt: '2026-09-30T10:00:00.000Z',
    generator: 'fixture',
    notebook: { id: '{NB}{1}{B0}', name: 'Weit verstreut' },
    sections: [{
      id: '{S1}{1}{B0}',
      name: 'Alles',
      groupPath: [],
      pages: pages.map((page, index) => ({ id: page.id, name: page.title, level: 1, file: `pages/000${index + 1}.xml` })),
    }],
    assets: [],
  };
  const files = new Map<string, string>([['manifest.json', JSON.stringify(manifest)]]);
  pages.forEach((page, index) => files.set(`pages/000${index + 1}.xml`, pageXml(page.id, page.title, page.text, page.x, page.y)));
  for (const [path, content] of files) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), content);
  }
}

async function importFolder(page: Page, folder: string): Promise<void> {
  await gotoApp(page);
  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: 'OneNote importieren' }).click();
  const dialog = page.getByRole('dialog', { name: 'OneNote sicher importieren' });
  await dialog.getByRole('radio', { name: 'OneNote Desktop-Export (Ordner)' }).click();
  await dialog.getByLabel('Exportordner wählen').setInputFiles(folder);
  await expect(dialog).toContainText('3 Seiten in 1 Abschnitt');
  await dialog.getByRole('button', { name: 'Auswahl prüfen' }).click();
  await dialog.getByRole('checkbox', { name: /Ich bestätige genau diesen Fingerabdruck/ }).check();
  await dialog.getByRole('button', { name: 'Additiv importieren' }).click();
  await expect(dialog).toContainText('Import abgeschlossen');
  await dialog.getByRole('button', { name: 'Zum neuen Notizbuch' }).click();
}

/** Whether any part of the element lies inside the canvas viewport. */
async function isInView(page: Page, element: Locator): Promise<boolean> {
  const view = await page.getByLabel('Ansicht der Zeichenfläche').boundingBox();
  const box = await element.boundingBox();
  if (!view || !box) return false;
  return box.x < view.x + view.width && box.y < view.y + view.height
    && box.x + box.width > view.x && box.y + box.height > view.y;
}

test('a page whose content lies below or beside the first screen opens scrolled to that content', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'canvink-open-at-content-'));
  try {
    await writeExport(root);
    await importFolder(page, root);

    const text = page.locator('[data-element-kind="richText"]').first();
    await expect(page.getByLabel('Seitentitel')).toHaveValue('Oben');
    await expect(text).toContainText('Text am Seitenanfang');
    expect(await isInView(page, text)).toBe(true);
    const originAtTop = await page.locator('.live-canvas-surface').boundingBox();

    await page.getByRole('button', { name: /Weit unten/ }).first().click();
    await expect(page.getByLabel('Seitentitel')).toHaveValue('Weit unten');
    await expect(text).toContainText('Text tief unten auf der Seite');
    await expect.poll(() => isInView(page, text)).toBe(true);
    // The paper moved up: the page origin is above the top of the canvas.
    const movedUp = await page.locator('.live-canvas-surface').boundingBox();
    expect(movedUp!.y).toBeLessThan(originAtTop!.y - 1_000);

    await page.getByRole('button', { name: /Weit rechts/ }).first().click();
    await expect(page.getByLabel('Seitentitel')).toHaveValue('Weit rechts');
    await expect(text).toContainText('Text weit rechts auf der Seite');
    await expect.poll(() => isInView(page, text)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
