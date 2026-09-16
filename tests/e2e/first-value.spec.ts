import {
  createQuickNote,
  editSelectedText,
  escapeRegExp,
  expect,
  gotoApp,
  renameViaPrompt,
  saveStatus,
  test,
  waitForAutosave,
  waitForSaved,
} from './support';

test('preserves unsupported UI preference records until the user changes a setting', async ({
  page,
}) => {
  const storageKey = 'canvink:ui-preferences:v1';
  const unsupportedRecords = [
    {
      raw: '{',
      change: 'dismiss-guide',
      expected: {
        schemaVersion: 1,
        guideDismissed: true,
        textSize: 'default',
      },
    },
    {
      raw: '{ "schemaVersion": 2, "guideDismissed": true, "textSize": "future-large", "futureSetting": "preserve exactly" }',
      change: 'text-size',
      expected: {
        schemaVersion: 1,
        guideDismissed: false,
        textSize: 'large',
      },
    },
  ];

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const { raw, change, expected } of unsupportedRecords) {
    await page.evaluate(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: storageKey, value: raw },
    );
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    await waitForSaved(page);
    await expect(page.getByRole('button', { name: /Close guide/i })).toBeFocused();
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), storageKey),
    ).toBe(raw);

    if (change === 'dismiss-guide') {
      await page.getByRole('button', { name: /Skip for now/i }).click();
    } else {
      await page.getByLabel('Interface text size').selectOption('large');
    }
    expect(
      JSON.parse(
        (await page.evaluate((key) => window.localStorage.getItem(key), storageKey)) ??
          '',
      ),
    ).toEqual(expected);
  }
});

test('first start is skippable, resumable, and leads directly to a useful note', async ({
  page,
}) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  const guideControl = page.getByRole('button', { name: /Guide and display/i });
  const closeGuide = page.getByRole('button', { name: /Close guide/i });
  const dismiss = page.getByRole('button', { name: /Skip for now/i });
  await expect(guideControl).toBeVisible();
  await expect(dismiss).toBeVisible();
  await expect(closeGuide).toBeFocused();
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(dismiss).toBeHidden();
  await expect(guideControl).toBeFocused();

  const note = {
    title: 'First value note',
    body: 'The first useful thought is captured locally.',
  };
  const directEditor = await createQuickNote(page, note);
  const editorPlacement = await directEditor.evaluate((element) => {
    const editor = element.getBoundingClientRect();
    const canvas = element.closest('#page-editor')?.getBoundingClientRect();
    return {
      left: Number.parseFloat(element.style.left),
      top: Number.parseFloat(element.style.top),
      width: Number.parseFloat(element.style.width),
      height: Number.parseFloat(element.style.height),
      insideCanvas:
        Boolean(canvas) &&
        editor.left >= canvas!.left &&
        editor.top >= canvas!.top &&
        editor.right <= canvas!.right &&
        editor.bottom <= canvas!.bottom,
    };
  });
  expect(editorPlacement).toEqual({
    left: 72,
    top: 72,
    width: 560,
    height: 160,
    insideCanvas: true,
  });

  await page.evaluate(() => {
    const downloads: string[] = [];
    Object.defineProperty(window, '__CANVINK_E2E_DOWNLOADS__', {
      configurable: true,
      value: downloads,
    });
    HTMLAnchorElement.prototype.click = function captureDownload() {
      downloads.push(this.href);
    };
  });
  await page
    .locator('details.action-menu')
    .last()
    .locator('button', { hasText: 'Page PNG' })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(directEditor).toBeFocused();
  const exportedPng = await page.evaluate(
    () =>
      (
        window as Window & {
          __CANVINK_E2E_DOWNLOADS__?: string[];
        }
      ).__CANVINK_E2E_DOWNLOADS__?.at(-1),
  );
  expect(exportedPng).toMatch(/^data:image\/png;base64,/);
  const darkTextPixels = await page.evaluate(async (dataUrl) => {
    if (!dataUrl) return 0;
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const scaleX = image.naturalWidth / 1600;
    const scaleY = image.naturalHeight / 1000;
    const pixels = context.getImageData(
      Math.floor(72 * scaleX),
      Math.floor(72 * scaleY),
      Math.ceil(560 * scaleX),
      Math.ceil(160 * scaleY),
    ).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        pixels[index] < 120 &&
        pixels[index + 1] < 120 &&
        pixels[index + 2] < 120 &&
        pixels[index + 3] > 0
      ) {
        count += 1;
      }
    }
    return count;
  }, exportedPng);
  expect(darkTextPixels).toBeGreaterThan(40);

  await directEditor.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        isComposing: true,
        key: 'Escape',
      }),
    );
  });
  await expect(directEditor).toBeFocused();

  await directEditor.press('Escape');
  await expect(directEditor).toBeHidden();
  await expect(page.locator('#page-editor')).toBeFocused();
  await page.locator('#page-editor .konvajs-content').dblclick({
    position: { x: 80, y: 80 },
  });
  await expect(directEditor).toBeFocused();
  await page.getByLabel('Page title').click();
  await expect(directEditor).toBeHidden();
  await expect(page.getByLabel('Page title')).toBeFocused();
  await page.getByRole('button', { name: 'Edit text on page' }).click();
  await expect(directEditor).toBeFocused();
  await expect(directEditor).toHaveValue(note.body);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeHidden();

  const search = page.getByRole('searchbox', { name: 'Search workspace' });
  await search.fill(note.body);
  const searchResults = page.getByRole('region', { name: /Search results/i });
  const searchResult = searchResults.getByRole('button', {
    name: new RegExp(escapeRegExp(note.title), 'i'),
  });
  await expect(searchResults).toBeVisible();
  await search.press('Tab');
  await expect(page.getByRole('button', { name: /Clear search/i })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(searchResult).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(searchResults).toBeHidden();
  await expect(page.getByLabel('Page title')).toBeFocused();
  await expect(await editSelectedText(page)).toHaveValue(note.body);

  await page.getByLabel('Page title').fill('Start here');
  await waitForAutosave(page);

  await guideControl.focus();
  await guideControl.press('Enter');
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible();
  await expect(closeGuide).toBeFocused();
  await page.getByRole('button', { name: /Open an example/i }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('Start here');
  await expect(page.getByLabel('Current page location')).toContainText('Examples');
  await expect(
    page.getByRole('list', { name: /Canvas objects/i }),
  ).toContainText('Welcome to Canvink');
  await expect(page.getByLabel('Page title')).toBeFocused();
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeHidden();
});

test('a note can be organized into a named notebook and section, then found again', async ({
  page,
}) => {
  await gotoApp(page);

  await page.getByRole('button', { name: /New notebook/i }).click();
  await renameViaPrompt(
    page,
    page.getByRole('button', { name: /Rename notebook/i }),
    'Product notebook',
  );

  await page.getByRole('button', { name: 'New section', exact: true }).click();
  await renameViaPrompt(
    page,
    page.getByRole('button', { name: /Rename New section/i }).last(),
    'Research section',
  );

  await page.getByRole('button', { name: 'New page', exact: true }).last().click();
  const emptyPage = page.locator('[data-empty-kind="page"]');
  await expect(emptyPage).toBeVisible();
  const startWriting = emptyPage.getByRole('button').first();
  await expect(startWriting).toBeEnabled();
  await startWriting.click();

  const noteTitle = 'Interview synthesis';
  const noteBody = 'Customers want capture before categorization.';
  await expect(page.getByPlaceholder('Write your note')).toBeFocused();
  await page.getByPlaceholder('Write your note').fill(noteBody);
  await page.getByLabel('Page title').fill(noteTitle);
  await waitForAutosave(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);

  const navigation = page.getByRole('navigation', { name: /Notebook navigation/i });
  await expect(navigation.getByLabel('Notebook').locator('option:checked')).toHaveText(
    'Product notebook',
  );
  await expect(
    navigation.getByRole('button', { name: /^Research section \d+$/i }),
  ).toBeVisible();
  const activePage = navigation.locator('button[aria-current="page"]');
  await expect(activePage).toContainText(noteTitle);

  const search = page.getByRole('searchbox', { name: 'Search workspace' });
  await search.fill(noteBody);
  await page
    .getByRole('region', { name: /Search results/i })
    .getByRole('button', {
      name: new RegExp(escapeRegExp(noteTitle), 'i'),
    })
    .click();
  await expect(page.getByLabel('Page title')).toHaveValue(noteTitle);
  await expect(await editSelectedText(page)).toHaveValue(noteBody);
});

test('the text tool creates one focused object and returns to direct editing', async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole('button', { name: 'New page', exact: true }).last().click();
  await expect(page.locator('[data-empty-kind="page"]')).toBeVisible();

  const textTool = page
    .getByRole('toolbar', { name: 'Canvas tools' })
    .getByTitle(/^Text \(Alt\+Shift\+T\)$/);
  await textTool.click();
  await expect(textTool).toHaveAttribute('aria-pressed', 'true');

  const canvasSurface = page.locator('#page-editor .konvajs-content');
  await canvasSurface.click({ position: { x: 120, y: 120 } });

  const editor = page.getByPlaceholder('Write your note');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(page.locator('#page-editor')).toHaveAttribute(
    'data-editor-tool',
    'select',
  );
  await expect(
    page.getByLabel('Select a canvas object').locator('option'),
  ).toHaveCount(2);

  await editor.fill('The text tool now writes directly on the page.');
  await waitForAutosave(page);
  await editor.press('Escape');
  await expect(page.locator('#page-editor')).toBeFocused();

  await canvasSurface.dblclick({ position: { x: 128, y: 128 } });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('The text tool now writes directly on the page.');
});
