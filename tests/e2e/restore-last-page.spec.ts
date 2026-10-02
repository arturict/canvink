import {
  activeNotebookTitle,
  createNotebook,
  expect,
  gotoApp,
  switchNotebook,
  test,
  waitForSaved,
} from "./support";

/**
 * A reload opens the notebook, section and page last viewed on this device,
 * like OneNote, not the page of the workspace's last structural change.
 * Before, the app first opened the stored page (often "Mein Notizbuch") and
 * jumped to the last viewed page only after it had loaded, which for a
 * heavy imported page took long enough that a reload showed the wrong
 * notebook.
 */
test("reload opens the notebook and page last viewed on this device", async ({ page }) => {
  // Every title the page shows, from the first frame after each load.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __titlesSeen: string[] }).__titlesSeen = seen;
    const watch = () => {
      const value = document.querySelector<HTMLInputElement>('input[aria-label="Seitentitel"]')?.value;
      if (value && seen.at(-1) !== value) seen.push(value);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await gotoApp(page);
  const title = page.getByLabel("Seitentitel");
  const defaultNotebook = (await activeNotebookTitle(page).textContent())?.trim() ?? "";
  expect(defaultNotebook).not.toBe("");

  // A second notebook whose first page is the one to come back to.
  await createNotebook(page);
  await expect(activeNotebookTitle(page)).toHaveText("Neues Notizbuch");
  await title.fill("Letzte Seite");
  await waitForSaved(page);
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Canvas-Seite", exact: true }).click();
  await expect(title).toHaveValue("Unbenannte Seite");
  await page.locator(".page-row__target").filter({ hasText: "Letzte Seite" }).click();
  await expect(title).toHaveValue("Letzte Seite");

  // A structural change in the other notebook moves the workspace's stored
  // page there; then return to the page to come back to.
  await switchNotebook(page, defaultNotebook);
  await expect(activeNotebookTitle(page)).toHaveText(defaultNotebook);
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.getByRole("button", { name: "Canvas-Seite", exact: true }).click();
  await expect(title).toHaveValue("Unbenannte Seite");
  await title.fill("Strukturseite");
  await waitForSaved(page);
  await switchNotebook(page, "Neues Notizbuch");
  await expect(title).toHaveValue("Letzte Seite");
  await waitForSaved(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText("Neues Notizbuch");
  await expect(title).toHaveValue("Letzte Seite");
  await expect(page.locator(".page-row.is-active")).toContainText("Letzte Seite");
  // The first page shown after the reload was already the right one.
  const titlesSeen = await page.evaluate(() => (window as unknown as { __titlesSeen: string[] }).__titlesSeen);
  expect(titlesSeen[0]).toBe("Letzte Seite");
  expect(titlesSeen).not.toContain("Strukturseite");

  // Each notebook still returns to its own last page.
  await switchNotebook(page, defaultNotebook);
  await expect(title).toHaveValue("Strukturseite");
});
