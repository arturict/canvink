import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, gotoApp, test, waitForSaved } from './support';

async function createMarkdownPage(page: Page, title: string) {
  await gotoApp(page);
  const navigation = page.getByRole('navigation', { name: 'Notizbuchnavigation' });
  await navigation.getByRole('button', { name: 'Erstellen', exact: true }).click();
  await navigation.getByRole('button', { name: 'Markdown-Seite', exact: true }).click();
  await page.getByLabel('Seitentitel').fill(title);
  const editor = page.getByRole('textbox', { name: 'Notiz bearbeiten' });
  await expect(editor).toBeVisible();
  await editor.click();
  return { navigation, editor };
}

async function exportedMarkdown(page: Page): Promise<string> {
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Herunterladen', exact: true }).click();
  const path = await (await download).path();
  return readFile(path, 'utf8');
}

test('a Markdown page is a Notion-style block editor that stores Markdown', async ({ page }) => {
  const { navigation, editor } = await createMarkdownPage(page, 'Notion Notiz');

  // "/" opens the block menu, "/h1" filters it and Enter applies the heading.
  await page.keyboard.type('/h1');
  const menu = page.getByRole('listbox', { name: 'Block einfügen' });
  await expect(menu.getByRole('option')).toHaveCount(1);
  await expect(menu.getByRole('option', { name: /Überschrift 1/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Wochenplan');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('heading', { level: 1, name: 'Wochenplan' })).toBeVisible();

  // Markdown shortcuts: list, to-do, quote, inline marks and a code block.
  await page.keyboard.type('- Mathe lernen');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Deutsch repetieren');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[] Hefte kaufen');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Sport packen');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> Ein Zitat');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Mit **fett**, *kursiv* und `code`.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```');
  await page.keyboard.type('const a = 1;');

  await expect(editor.getByRole('list').first().getByRole('listitem')).toHaveText(['Mathe lernen', 'Deutsch repetieren']);
  await expect(editor.locator('.canvink-check-item')).toHaveCount(2);
  await expect(editor.locator('blockquote')).toHaveText('Ein Zitat');
  await expect(editor.locator('strong')).toHaveText('fett');
  await expect(editor.locator('em')).toHaveText('kursiv');
  await expect(editor.locator('p code')).toHaveText('code');
  await expect(editor.locator('pre code')).toHaveText('const a = 1;');
  await waitForSaved(page);

  // Ticking a to-do with the mouse writes "[x]".
  await editor.locator('.canvink-check-item__box').first().click();
  await expect(editor.locator('.canvink-check-item.is-checked')).toHaveText(/Hefte kaufen/);

  const expected = [
    '# Wochenplan',
    '',
    '- Mathe lernen',
    '- Deutsch repetieren',
    '',
    // A different bullet keeps the to-dos a separate list from the list above.
    '* [x] Hefte kaufen',
    '* [ ] Sport packen',
    '',
    '> Ein Zitat',
    '',
    'Mit **fett**, *kursiv* und `code`.',
    '',
    '```',
    'const a = 1;',
    '```',
    '',
  ].join('\n');
  await waitForSaved(page);
  expect(await exportedMarkdown(page)).toBe(expected);

  // The stored source shows in the raw toggle, and editing it updates the blocks.
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown bearbeiten' });
  await expect(source).toHaveValue(expected);
  await source.fill(`${expected}\n---\n\nEnde`);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(editor.locator('hr')).toHaveCount(1);
  await expect(editor.getByText('Ende', { exact: true })).toBeVisible();
  await waitForSaved(page);

  // After a reload the same blocks render and the file is unchanged.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await navigation.getByRole('button', { name: /Notion Notiz/ }).click();
  await expect(editor.getByRole('heading', { level: 1, name: 'Wochenplan' })).toBeVisible();
  await expect(editor.locator('.canvink-check-item.is-checked')).toHaveCount(1);
  await expect(editor.locator('pre code')).toHaveText('const a = 1;');
  expect(await exportedMarkdown(page)).toBe(`${expected}\n---\n\nEnde`);
});

test('the block menu, Backspace and the source toggle behave like Notion', async ({ page }) => {
  const { editor } = await createMarkdownPage(page, 'Blockmenü');

  await page.keyboard.type('/zitat');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Zitiert');
  await expect(editor.locator('blockquote')).toHaveText('Zitiert');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await page.keyboard.type('/trennlinie');
  await page.keyboard.press('Enter');
  await expect(editor.locator('hr')).toHaveCount(1);
  await page.keyboard.type('/tabelle');
  await page.keyboard.press('Enter');
  await expect(editor.locator('table')).toHaveCount(1);
  await page.keyboard.type('A');

  // Escape closes the menu without changing the line.
  await editor.locator('p').last().click();
  // The empty-line hint shows once the editor has taken the caret into the line below the table.
  await expect(editor.locator('p.is-empty-line')).toBeVisible();
  await page.keyboard.type('/co');
  await expect(page.getByRole('listbox', { name: 'Block einfügen' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Block einfügen' })).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');

  // "## " makes a heading and Backspace at its start makes it a paragraph again.
  await page.keyboard.type('## Zweiter');
  await expect(editor.getByRole('heading', { level: 2, name: 'Zweiter' })).toBeVisible();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(editor.getByRole('heading', { level: 2 })).toHaveCount(0);
  await expect(editor.getByText('Zweiter', { exact: true })).toBeVisible();

  await waitForSaved(page);
  const markdown = await exportedMarkdown(page);
  expect(markdown).toContain('> Zitiert\n');
  expect(markdown).toContain('---\n');
  expect(markdown).toContain('| A |');
  expect(markdown.trimEnd().endsWith('Zweiter')).toBe(true);
  expect(markdown).not.toContain('##');
});

test('Markdown the editor does not model survives editing', async ({ page }) => {
  const { editor } = await createMarkdownPage(page, 'Unverändert');
  const source = '# Notiz\n\n<details>\n<summary>Mehr</summary>\n</details>\n\nBild ![Skizze](skizze.png) und Fussnote[^1].\n\n[^1]: Quelle.\n';
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown bearbeiten' }).fill(source);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await waitForSaved(page);

  await expect(editor.locator('.markdown-raw-block')).toHaveCount(2);
  // Opening does not rewrite the file.
  expect(await exportedMarkdown(page)).toBe(source);

  await editor.getByRole('heading', { name: 'Notiz' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' neu');
  await waitForSaved(page);
  expect(await exportedMarkdown(page)).toBe(source.replace('# Notiz', '# Notiz neu'));
});

test('a title edit followed at once by a text edit survives a reload', async ({ page }) => {
  const { navigation, editor } = await createMarkdownPage(page, 'Titel zuerst');
  await page.keyboard.type('Erster Satz');
  await page.getByLabel('Seitentitel').fill('Titel danach');
  await editor.getByText('Erster Satz').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' und mehr');
  await waitForSaved(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await navigation.getByRole('button', { name: /Titel danach/ }).click();
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Titel danach');
  await expect(editor).toContainText('Erster Satz und mehr');
});
