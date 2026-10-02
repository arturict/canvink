import type { Page } from "@playwright/test";
import {
  createQuickNote,
  expect,
  gotoApp,
  openFileMenu,
  ribbonTab,
  saveStatus,
  test,
  waitForSaved,
} from "./support";

/**
 * The heavy code (math libraries, the OneNote import, the Markdown editor,
 * PDF export, team sync) is split into chunks that load when a feature asks
 * for them. Offline, a chunk that is not cached is a broken feature, so the
 * service worker caches every file of a build when it installs.
 */

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return false;
        const registration = await navigator.serviceWorker.ready;
        return Boolean(registration.active && navigator.serviceWorker.controller);
      }),
    )
    .toBe(true);
}

test("every chunk of the build is cached once the service worker controls the page", async ({ page }) => {
  await gotoApp(page);
  await waitForServiceWorkerControl(page);

  const missing = await page.evaluate(async () => {
    const source = await (await fetch("/sw.js", { cache: "no-store" })).text();
    const manifest = /const PRECACHE_MANIFEST = '(\[.*?\])';/.exec(source)?.[1];
    if (!manifest) throw new Error("The service worker carries no precache manifest.");
    const paths = JSON.parse(manifest) as string[];
    const cache = await caches.open("canvink-static-v1");
    const absent: string[] = [];
    for (const path of paths) {
      if (!(await cache.match(new URL(path, location.origin), { ignoreVary: true }))) absent.push(path);
    }
    return { total: paths.length, absent };
  });

  // A real build has dozens of files; an empty list would pass vacuously.
  expect(missing.total).toBeGreaterThan(20);
  expect(missing.absent).toEqual([]);
});

test("every lazily loaded feature works offline after the first load", async ({ context, page }) => {
  await gotoApp(page);
  await waitForServiceWorkerControl(page);
  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    // Export: the PDF libraries load when the first export runs.
    await openFileMenu(page);
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    const pdfDownload = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("menuitem", { name: "Seite PDF", exact: true }).click();
    const pdfPath = await (await pdfDownload).path();
    expect(pdfPath).toBeTruthy();
    await expect(page.getByRole("button", { name: "Offline nicht verfügbar – erneut versuchen" })).toHaveCount(0);

    // Import dialog.
    await page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true }).click();
    await page.getByRole("menuitem", { name: "OneNote importieren" }).click();
    const dialog = page.getByRole("dialog", { name: "OneNote sicher importieren" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Importdialog schliessen" }).click();
    await expect(dialog).toBeHidden();

    // Math block: opening the app with the feature on loads the math libraries.
    // (Before the Markdown page below: the app reopens on the last page.)
    await page.goto("/app?__canvinkFeatureMath=1", { waitUntil: "domcontentloaded" });
    await waitForSaved(page);
    const surface = page.getByRole("application", { name: "Gemeinsame Seitenzeichenfläche" });
    const bounds = await surface.boundingBox();
    if (!bounds) throw new Error("The shared canvas has no visible bounds.");
    await (await ribbonTab(page, "Einfügen")).getByRole("button", { name: "Mathe", exact: true }).click();
    await page.mouse.click(bounds.x + 80, bounds.y + 80);
    const mathBlock = page.locator('[data-element-kind="math"]');
    await expect(mathBlock).toHaveCount(1);
    await expect(mathBlock.locator("math-field.math-block__field")).toBeVisible();
    await expect(page.getByRole("button", { name: "Offline nicht verfügbar – erneut versuchen" })).toHaveCount(0);

    // Markdown page: the parser and editor load with it.
    const navigation = page.getByRole("navigation", { name: "Notizbuchnavigation" });
    await navigation.getByRole("button", { name: "Erstellen", exact: true }).click();
    await navigation.getByRole("button", { name: "Markdown-Seite", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Notiz bearbeiten" });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("Offline geschrieben");
    await waitForSaved(page);
  } finally {
    await context.setOffline(false);
  }
});

test("a first visit that goes offline at once still captures notes", async ({ context, page }) => {
  await gotoApp(page);
  // No wait for the service worker: it may not have cached anything yet.
  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await createQuickNote(page, {
      title: "Sofort offline",
      body: "Diese Notiz entsteht ohne Service Worker und ohne Netz.",
    });
    await expect(saveStatus(page)).toHaveAttribute("data-state", "saved");
    // Nothing here needs a chunk that was not downloaded: no retry notice.
    await expect(page.getByRole("button", { name: "Offline nicht verfügbar – erneut versuchen" })).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});

test.describe("without a service worker", () => {
  // The worker would answer the chunk from its cache before page.route sees it.
  test.use({
    serviceWorkers: "block",
    expectedBrowserErrors: [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/],
  });

  test("a lazy chunk that cannot load shows a retry and recovers", async ({ page }) => {
    await gotoApp(page);
    let blocked = true;
    await page.route(/\/assets\/MarkdownPageEditor-[^/]+\.js$/, (route) =>
      blocked ? route.abort("internetdisconnected") : route.continue(),
    );

    const navigation = page.getByRole("navigation", { name: "Notizbuchnavigation" });
    await navigation.getByRole("button", { name: "Erstellen", exact: true }).click();
    await navigation.getByRole("button", { name: "Markdown-Seite", exact: true }).click();
    const retry = page.getByRole("button", { name: "Offline nicht verfügbar – erneut versuchen" });
    await expect(retry).toBeVisible();
    // The rest of the app keeps working behind the notice.
    await expect(page.getByLabel("Seitentitel")).toBeVisible();

    blocked = false;
    await retry.click();
    await expect(page.getByRole("textbox", { name: "Notiz bearbeiten" })).toBeVisible();
    await expect(retry).toBeHidden();
  });
});
