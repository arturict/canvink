import {
  createQuickNote,
  editSelectedText,
  expect,
  expectNoDocumentOverflow,
  gotoApp,
  saveStatus,
  test,
  waitForAutosave,
} from './support';

test('desktop keeps navigation, capture, and editor inside the viewport', async ({ page }) => {
  await gotoApp(page);

  await expect(
    page.getByRole('navigation', { name: /Notebook navigation/i }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Quick note', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Page title')).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test('keeps one dialog when an open desktop trash view becomes compact', async ({
  page,
}) => {
  await gotoApp(page);

  await page.getByRole('button', { name: /^Trash/i }).click();
  await expect(page.getByRole('dialog', { name: /Trash/i })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => window.matchMedia('(max-width: 820px)').matches),
    )
    .toBe(true);
  const navigationToggle = page.getByRole('button', {
    name: /Show notebook navigation/i,
  });
  await expect(navigationToggle).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(
    page.getByRole('dialog', { name: /Notebook navigation/i }),
  ).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(navigationToggle).toBeFocused();
});

test.describe('tablet', () => {
  test.use({
    viewport: { width: 900, height: 800 },
  });

  test('keeps import and export menus visible outside the scrolling tools', async ({
    page,
  }) => {
    await gotoApp(page);

    const menus = page.locator('details.action-menu');
    await menus.first().locator('summary').click();
    const importAction = page.getByRole('button', { name: /JSON or Markdown/i });
    await expect(importAction).toBeInViewport();
    await importAction.click({ trial: true });
    await menus.first().locator('summary').click();

    await menus.last().locator('summary').click();
    const exportAction = page.getByRole('button', { name: /Workspace JSON/i });
    await expect(exportAction).toBeInViewport();
    await exportAction.click({ trial: true });
    await expectNoDocumentOverflow(page);
  });
});

test.describe('mobile', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.75,
  });

  test('uses a focused single-column capture and navigation journey', async ({ page }) => {
    await gotoApp(page);

    const navigation = page.getByRole('dialog', {
      name: /Notebook navigation/i,
    });
    await expect(navigation).toHaveCount(0);
    await expectNoDocumentOverflow(page);

    const note = {
      title: 'Mobile capture',
      body: 'Captured without leaving the focused editor.',
    };
    await createQuickNote(page, note);
    await expectNoDocumentOverflow(page);

    await page
      .getByRole('button', { name: /Show notebook navigation/i })
      .click();
    await expect(navigation).toBeVisible();
    await expectNoDocumentOverflow(page);

    const activePage = navigation.locator('button[aria-current="page"]');
    await expect(activePage).toContainText(note.title);
    await activePage.click();
    await expect(navigation).toHaveCount(0);
    await expect(page.getByLabel('Page title')).toHaveValue(note.title);
    await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
    const editor = await editSelectedText(page);
    await expect(editor).toHaveValue(note.body);
    const inspector = page.getByRole('complementary', {
      name: /Object properties/i,
    });
    await expect(inspector).toBeHidden();
    await expectNoDocumentOverflow(page);

    await editor.press('Escape');
    await expect(inspector).toBeVisible();
  });

  test('keeps guide, navigation, shortcuts, and trash in one modal layer', async ({
    page,
  }) => {
    await gotoApp(page, { dismissGuide: false });
    const guide = page.locator('#getting-started-panel');
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: /Write a quick note/i }).click();
    await waitForAutosave(page);

    await page.getByRole('button', { name: /Guide and display/i }).click();
    await expect(guide).toBeVisible();
    const navigationToggle = page.getByRole('button', {
      name: /Show notebook navigation/i,
    });
    await navigationToggle.click();
    await expect(guide).toBeHidden();

    const navigation = page.getByRole('dialog', {
      name: /Notebook navigation/i,
    });
    await expect(navigation).toBeVisible();

    const status = saveStatus(page);
    await status.evaluate((element) => {
      element.setAttribute('data-observed-saving', 'false');
      const observer = new MutationObserver(() => {
        if (element.getAttribute('data-state') === 'saving') {
          element.setAttribute('data-observed-saving', 'true');
        }
      });
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['data-state'],
      });
    });
    await navigation
      .getByRole('button', { name: /Close notebook navigation/i })
      .focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(750);
    await expect(status).toHaveAttribute('data-observed-saving', 'false');

    await navigation.getByRole('button', { name: /^Trash/i }).click();
    await expect(navigation).toHaveCount(0);
    const trash = page.getByRole('dialog', { name: /Trash/i });
    await expect(trash).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(trash).toBeHidden();
    await expect(navigationToggle).toBeFocused();
  });
});
