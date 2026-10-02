import { expect, gotoApp, test } from "./support";

/**
 * Most of Canvink's JavaScript is code that opening a notebook never runs:
 * the math libraries, the encrypted team sync, the OneNote import, PDF export.
 * They are separate chunks that load when something asks for them; a static
 * import that pulled one into the start bundle would cost every start. The
 * chunk names come from the groups in vite.config.ts and from the lazy
 * imports.
 */
const ON_DEMAND = /^(compute-engine|mathlive|jsxgraph|sodium|SyncCollaborationPanel|OneNoteImportDialogHost|NotebookSettingsDialog|jspdf|html2canvas|pdf|MarkdownPageEditor)[.-]/;

test("opening a notebook does not download the on-demand chunks", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith(".js") || url.pathname.endsWith(".mjs")) scripts.push(url.pathname.split("/").pop() ?? "");
  });

  await gotoApp(page);
  await expect(page.getByLabel("Seitentitel")).toBeVisible();
  // The start page has text and ink, and the shell has settled.
  await expect(page.locator("[data-ink-stroke-count]").first()).toBeAttached();

  expect(scripts.filter((name) => ON_DEMAND.test(name))).toEqual([]);
  // The chunks the notebook itself runs did load, so the filter can match.
  expect(scripts.some((name) => name.startsWith("V2NotebookApp-"))).toBe(true);
});

test("a first start builds the start workspace in a worker, so the main thread stays free", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));

  // A fresh profile has no workspace yet: the first start materializes, stages and upgrades the
  // start notebook, several hundred milliseconds of Automerge work that must not block input.
  await gotoApp(page);
  await expect(page.getByLabel("Seitentitel")).toBeVisible();
  await expect(page.locator("[data-ink-stroke-count]").first()).toBeAttached();

  expect(workers.some((url) => /automergeTask\.worker/.test(url))).toBe(true);
});
