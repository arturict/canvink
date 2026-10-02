import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { FIXTURE_PNG } from "../../src/import/onenoteDesktop/fixtures";
import { machineSlowdown } from "./machineLoad";
import { deleteSearchDatabases, generateSeed, seedWorkspace, type SeedPage } from "./seededWorkspace";
import { expect, gotoApp, test } from "./support";

/**
 * The words of PDF printouts stay searchable when the search index is built
 * again. The seed (synthetic data) holds worksheet PDFs shown as printouts on
 * ordinary pages, and one page shaped like a large synthetic notebook page: 486 printouts, each one page of the same PDF. Its
 * printouts hold more text than a search record may store in full, so the
 * words of the later printouts must survive in a compact form.
 */
const seedBase = join(tmpdir(), "canvink-e2e-search-printouts-seed");
let seedDir = seedBase; // set to the generated seed in beforeAll
const PRINTOUT_PAGES = 486;
/**
 * No task of the rebuild may hold the main thread longer than this on an idle
 * machine. A browser that shares its cores with others is descheduled in the
 * middle of a task and reports the wait as task time (a rebuild that measured
 * 52 to 74 ms alone measured 110 ms under parallel load), so the limit is
 * multiplied by the measured slowdown of the machine (see machineLoad.ts).
 * Work that really blocks the thread for a long time stays several times
 * above it.
 */
const LONGEST_TASK_MS = 100;
const REBUILD_ATTEMPTS = 5;

const searchBox = (page: Page) => page.getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" });

/** Titles of the results for a query, once the results list shows an answer. */
async function resultTitles(page: Page, query: string): Promise<string[]> {
  await searchBox(page).fill("");
  await searchBox(page).fill(query);
  const options = page.getByRole("listbox", { name: "Suchergebnisse" }).getByRole("option");
  await page.waitForTimeout(150);
  return options.allInnerTexts();
}

async function expectPrintoutWordsFound(page: Page, timeout: number): Promise<void> {
  const queries: Array<[string, RegExp]> = [
    // A PDF that several ordinary pages show pages of.
    ["pdfwort1", /Arbeitsblatt 2 Seite/],
    ["pdfwort2", /Arbeitsblatt 3 Seite/],
    // Text of the first and of the very last printout of the heavy page.
    ["Arbeitsblatt Seite 1", /Algebra schwer/],
    [`Arbeitsblatt Seite ${PRINTOUT_PAGES}`, /Algebra schwer/],
  ];
  for (const [query, expected] of queries) {
    await expect.poll(async () => (await resultTitles(page, query)).join("\n"), { timeout, message: query }).toMatch(expected);
  }
}

test.describe("printout text in the search index", () => {
  test.setTimeout(300_000);

  test.beforeAll(() => {
    test.setTimeout(240_000);
    seedDir = generateSeed(seedBase, [
      "--pages", "6", "--strokes", "100", "--images", "3", "--sections", "1",
      "--pdfs", "3", "--pdf-pages", "4", "--pdf-printouts", "9",
      "--heavy", "300", "--heavy-images", String(PRINTOUT_PAGES), "--heavy-pdf", "1", "--printout-size", "200x280",
    ]);
  });

  test("finds the same printout words after the search index databases were deleted and rebuilt", async ({ page }) => {
    await page.addInitScript(() => {
      const tasks: Array<{ start: number; duration: number }> = [];
      (window as unknown as { __longTasks: typeof tasks }).__longTasks = tasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: "longtask", buffered: true });
    });
    const pages: SeedPage[] = await seedWorkspace(page, seedDir);
    await page.goto("/app");
    await expect(page.getByLabel("Seitentitel")).toHaveValue(pages[0].title, { timeout: 120_000 });
    await expectPrintoutWordsFound(page, 120_000);

    // The words must come back after every rebuild. The longest task is taken
    // from the best of up to five rebuilds: a slow task on a shared machine may be
    // the wait for a core, and waiting on the next rebuild does not hide a
    // rebuild that blocks the thread, because that one is slow every time.
    const attempts: string[] = [];
    let withinBudget = false;
    for (let attempt = 1; attempt <= REBUILD_ATTEMPTS && !withinBudget; attempt += 1) {
      const loadBefore = await machineSlowdown(page);
      await deleteSearchDatabases(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByLabel("Seitentitel")).toHaveValue(pages[0].title, { timeout: 120_000 });
      // Starting the app is not part of the rebuild; its tasks are measured elsewhere.
      const rebuildStart = await page.evaluate(() => performance.now());

      await expectPrintoutWordsFound(page, 120_000);
      await expect(page.locator("[data-search-indexing]")).toHaveCount(0, { timeout: 120_000 });
      await expect(page.getByRole("region", { name: "Lokale Suche" })).not.toContainText("fehlgeschlagen");

      const longestTask = await page.evaluate((from) => Math.max(0, ...(window as unknown as { __longTasks: Array<{ start: number; duration: number }> })
        .__longTasks.filter((task) => task.start + task.duration >= from).map((task) => task.duration)), rebuildStart);
      const slowdown = Math.max(loadBefore, await machineSlowdown(page));
      attempts.push(`${Math.round(longestTask)} ms, machine ${slowdown.toFixed(1)}x slower than idle`);
      withinBudget = longestTask < LONGEST_TASK_MS * slowdown;
    }
    test.info().annotations.push({ type: "longest task while rebuilding", description: attempts.join("; ") });
    expect(withinBudget, `Every rebuild had a task over the budget: ${attempts.join("; ")}`).toBe(true);
  });

  test("finds the printout words of an imported OneNote export, in a text box too, and indexes a page whose PDF is damaged", async ({ page }) => {
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const worksheet = async (...words: string[]): Promise<Uint8Array> => {
      const document = await PDFDocument.create();
      const font = await document.embedFont(StandardFonts.Helvetica);
      for (const word of words) document.addPage([595, 842]).drawText(`Blatt ${word}`, { x: 50, y: 780, size: 14, font });
      return document.save({ useObjectStreams: false });
    };
    const damaged = new TextEncoder().encode("%PDF-1.7\n% not a document\n%%EOF");
    const onenote = "http://schemas.microsoft.com/office/onenote/2013/onenote";
    const png = `assets/${sha256(FIXTURE_PNG)}.png`;
    const printout = (asset: string, number: number, y: number, xpsFileIndex: boolean) =>
      `<one:Image format="png" isPrintOut="true"${xpsFileIndex ? ' xpsFileIndex="0"' : ""} originalPageNumber="${number}" canvinkAsset="${asset}">`
      + `<one:Position x="36" y="${y}" z="${number + 1}"/><one:Size width="595" height="842"/></one:Image>`;
    const pageXml = (title: string, body: string) => `<?xml version="1.0"?><one:Page xmlns:one="${onenote}" ID="{${title}}{1}{B0}" name="${title}" pageLevel="1">`
      + `<one:Title><one:OE><one:T><![CDATA[${title}]]></one:T></one:OE></one:Title>${body}</one:Page>`;
    const file = (path: string, name: string, xpsFileIndex: boolean) => `<one:InsertedFile pathSource="C:\\${name}" preferredName="${name}" canvinkFile="${path}">`
      + `<one:Position x="36" y="80" z="0"/><one:Size width="60" height="60"/>${xpsFileIndex ? '<one:Printout xpsFileIndex="0"/>' : ""}</one:InsertedFile>`;
    const outlineText = (text: string, inner = "") => `<one:Outline><one:Position x="36" y="80" z="0"/><one:Size width="300" height="100"/>`
      + `<one:OEChildren><one:OE><one:T><![CDATA[${text}]]></one:T></one:OE>${inner}</one:OEChildren></one:Outline>`;

    const alpha = await worksheet("alphawort", "alphazwei");
    const beta = await worksheet("betawort", "betazwei");
    const alphaPath = `files/${sha256(alpha)}.pdf`;
    const betaPath = `files/${sha256(beta)}.pdf`;
    const damagedPath = `files/${sha256(damaged)}.pdf`;
    const pages = [
      // A printed PDF whose pages are linked by OneNote itself.
      ["Alpha", file(alphaPath, "alpha.pdf", true) + printout(png, 0, 160, true) + printout(png, 1, 1010, true)],
      // A file dropped into a text box: its printout pages carry no link.
      ["Beta", outlineText("Text im Kasten", `<one:OE>${file(betaPath, "beta.pdf", false)}</one:OE>`) + printout(png, 0, 260, false) + printout(png, 1, 1110, false)],
      // A PDF that cannot be read must not take the page's own text with it.
      ["Delta", outlineText("Deltatext auf der Seite") + file(damagedPath, "delta.pdf", true) + printout(png, 0, 260, true)],
    ] as const;
    const manifest = {
      format: "canvink-onenote-desktop-export", version: 1, exportedAt: "2026-09-24T10:00:00.000Z", generator: "test",
      notebook: { id: "{NB}{1}{B0}", name: "Druckheft" },
      sections: [{
        id: "{S1}{1}{B0}", name: "Mathe", groupPath: [],
        pages: pages.map(([title], index) => ({ id: `{${title}}{1}{B0}`, name: title, level: 1, file: `pages/000${index + 1}.xml` })),
      }],
      assets: [
        { path: png, mediaType: "image/png", bytes: FIXTURE_PNG.byteLength, sha256: sha256(FIXTURE_PNG), width: 1, height: 1 },
        ...[[alphaPath, alpha], [betaPath, beta], [damagedPath, damaged]].map(([path, bytes]) => ({
          path: path as string, mediaType: "application/pdf", bytes: (bytes as Uint8Array).byteLength, sha256: sha256(bytes as Uint8Array),
        })),
      ],
    };
    const files = new Map<string, Uint8Array>([
      ["manifest.json", Buffer.from(JSON.stringify(manifest))],
      [png, FIXTURE_PNG], [alphaPath, alpha], [betaPath, beta], [damagedPath, damaged],
      ...pages.map(([title, body], index): [string, Uint8Array] => [`pages/000${index + 1}.xml`, Buffer.from(pageXml(title, body))]),
    ]);

    const root = await mkdtemp(join(tmpdir(), "canvink-search-printouts-"));
    const folder = join(root, "export");
    try {
      for (const [path, bytes] of files) {
        await mkdir(dirname(join(folder, path)), { recursive: true });
        await writeFile(join(folder, path), bytes);
      }
      await gotoApp(page);
      await page.locator(".app-topbar").getByRole("button", { name: "Mehr", exact: true }).click();
      await page.getByRole("menuitem", { name: "OneNote importieren" }).click();
      const dialog = page.getByRole("dialog", { name: "OneNote sicher importieren" });
      await dialog.getByRole("radio", { name: "OneNote Desktop-Export (Ordner)" }).click();
      await dialog.getByLabel("Exportordner wählen").setInputFiles(folder);
      await expect(dialog).toContainText("3 Seiten");
      await dialog.getByRole("button", { name: "Auswahl prüfen" }).click();
      await dialog.getByRole("checkbox", { name: /Ich bestätige genau diesen Fingerabdruck/ }).check();
      await dialog.getByRole("button", { name: "Additiv importieren" }).click();
      await expect(dialog).toContainText("Import abgeschlossen");
      await dialog.getByRole("button", { name: "Zum neuen Notizbuch" }).click();
      await expect(page.getByLabel("Seitentitel")).toBeVisible();

      const expectations: Array<[string, RegExp]> = [
        ["alphawort", /Alpha/],
        ["alphazwei", /Alpha/],
        ["betawort", /Beta/],
        ["betazwei", /Beta/],
        ["Text im Kasten", /Beta/],
        ["Deltatext", /Delta/],
      ];
      const expectFound = async () => {
        for (const [query, expected] of expectations) {
          await expect.poll(async () => (await resultTitles(page, query)).join("\n"), { timeout: 60_000, message: query }).toMatch(expected);
        }
      };
      await expectFound();

      await deleteSearchDatabases(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByLabel("Seitentitel")).toBeVisible({ timeout: 60_000 });
      await expectFound();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
