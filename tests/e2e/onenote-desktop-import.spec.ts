import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, gotoApp, test } from './support';
import { syntheticDesktopExport } from '../../src/import/onenoteDesktop/fixtures';

test('imports a OneNote desktop export folder with printouts, ink and text as a new notebook', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'canvink-onenote-export-'));
  const folder = join(root, 'schulheft-export');
  try {
    for (const [path, bytes] of await syntheticDesktopExport()) {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await writeFile(join(folder, path), bytes);
    }

    await gotoApp(page);
    await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('menuitem', { name: 'OneNote importieren' }).click();
    const dialog = page.getByRole('dialog', { name: 'OneNote sicher importieren' });
    await dialog.getByRole('radio', { name: 'OneNote Desktop-Export (Ordner)' }).click();
    await expect(dialog).toContainText('nichts wird hochgeladen');
    await dialog.getByLabel('Exportordner wählen').setInputFiles(folder);

    // Only the manifest is read for the review; pages are read while the import writes them.
    await expect(dialog).toContainText('4 Seiten in 2 Abschnitten · 2 Dateien');
    await expect(dialog.getByLabel(/Semester 1 › Mathe/)).toBeChecked();
    await dialog.getByLabel(/Geschützt/).uncheck();
    await dialog.getByRole('button', { name: 'Auswahl prüfen' }).click();
    await expect(dialog).toContainText('3 Seiten');
    await expect(dialog).toContainText('Wie genau jede Seite übernommen wurde, zeigt der Bericht danach.');
    await dialog.getByRole('checkbox', { name: /Ich bestätige genau diesen Fingerabdruck/ }).check();
    await dialog.getByRole('button', { name: 'Additiv importieren' }).click();
    await expect(dialog).toContainText('Import abgeschlossen');
    await expect(dialog.getByTestId('onenote-import-timing')).toContainText('3 Seiten mit 4 Strichen in');
    await expect(dialog).toContainText('Arbeitsblatt Brüche');
    await expect(dialog).toContainText('3 Striche · 2 Ausdruckseiten');
    await dialog.getByRole('button', { name: 'Zum neuen Notizbuch' }).click();

    await expect(page.getByLabel('Seitentitel')).toHaveValue('Arbeitsblatt Brüche');
    await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(2);
    await page.getByRole('button', { name: /Zusammenfassung & Übungen/ }).first().click();
    await expect(page.getByLabel('Seitentitel')).toHaveValue('Zusammenfassung & Übungen');
    await expect(page.locator('[data-element-kind="richText"]').first()).toContainText('Bruch hat Zähler und Nenner.');
    await expect(page.locator('[data-element-kind="richText"] table')).toHaveCount(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
