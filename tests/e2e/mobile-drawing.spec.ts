import { expect, gotoApp, test, waitForSaved } from './support';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test('finger input draws on mobile when the pen tool is active', async ({ page }) => {
  await gotoApp(page);

  await page.getByRole('button', { name: 'Draw', exact: true }).click();

  const stage = page.locator('.konvajs-content');
  await expect(stage).toBeVisible();
  await expect(stage).toHaveCSS('touch-action', 'none');
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.touchscreen.tap(box.x + 90, box.y + 110);

  await expect(
    page.getByRole('list', { name: /Canvas objects/i }).getByRole('listitem'),
  ).toHaveCount(1);
  await waitForSaved(page);

  await page.getByRole('button', { name: /^Select/ }).click();
  await expect(stage).toHaveCSS('touch-action', 'pan-x pan-y');
});
