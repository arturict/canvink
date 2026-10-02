import { expect, gotoApp, openTopbarMore, test, waitForSaved } from "./support";

test("cached app shell reopens offline and restores the last IndexedDB save", async ({
  context,
  page,
}) => {
  await gotoApp(page);

  await expect
    .poll(() =>
      page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return false;
        const registration = await navigator.serviceWorker.ready;
        return Boolean(
          registration.active && navigator.serviceWorker.controller,
        );
      }),
    )
    .toBe(true);

  // Let the now-controlling worker cache the lazy V2 editor chunks before the
  // first offline navigation.
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);

  const title = "Offline self-host proof";
  const body = "This saved note must survive a complete offline reload.";
  await openTopbarMore(page);
  await page
    .getByRole("menuitem", { name: "Schnelle Notiz", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Gemeinsamer Text" })
    .last()
    .fill(body);
  await page.getByLabel("Seitentitel").fill(title);
  await waitForSaved(page);

  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSaved(page);

    await expect(page.getByLabel("Seitentitel")).toHaveValue(title);
    await expect(
      page.getByRole("textbox", { name: "Gemeinsamer Text" }).last(),
    ).toContainText(body);
  } finally {
    await context.setOffline(false);
  }
});
