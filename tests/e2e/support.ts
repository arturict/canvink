import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";

const APP_PATH = "/app";

export const test = base.extend<{ runtimeGuard: void; expectedBrowserErrors: RegExp[] }>({
  // Console errors a test provokes on purpose (a blocked request); anything
  // else still fails the test.
  expectedBrowserErrors: [[], { option: true }],
  runtimeGuard: [
    async ({ page, expectedBrowserErrors }, use, testInfo) => {
      const errors: string[] = [];

      // Reproduces a loaded machine on demand: CANVINK_E2E_CPU_THROTTLE=6 runs
      // the page's main thread six times slower, which surfaces races that
      // only show when the app is slow (a missing wait, a lost early action).
      const throttle = Number(process.env.CANVINK_E2E_CPU_THROTTLE ?? "1");
      if (throttle > 1) {
        const session = await page.context().newCDPSession(page);
        await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      }

      page.on("pageerror", (error) => {
        errors.push(`pageerror: ${error.stack ?? error.message}`);
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (expectedBrowserErrors.some((pattern) => pattern.test(message.text()))) return;
        const location = message.location();
        const source = location.url
          ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
          : "";
        errors.push(`console.error: ${message.text()}${source}`);
      });

      await use();

      if (errors.length > 0) {
        await testInfo.attach("browser-errors", {
          body: Buffer.from(errors.join("\n")),
          contentType: "text/plain",
        });
      }
      expect(
        errors,
        "The browser emitted unexpected console or page errors",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export function saveStatus(page: Page): Locator {
  return page.getByTestId("save-status");
}

/** The app starts slowly on a busy machine, so the first wait for it gets a long ceiling; it returns as soon as the app is ready. */
const APP_READY_TIMEOUT_MS = 60_000;
const SAVE_TIMEOUT_MS = 30_000;

export async function waitForSaved(page: Page, timeout = SAVE_TIMEOUT_MS): Promise<void> {
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout });
}

/**
 * Waits until the change just made is written. The indicator only reads
 * "saved" when no write is pending, and a change turns it to "saving" in the
 * same render that shows the change, so call this after the change is visible.
 * The "saving" phase itself is too short to observe reliably on a fast or a
 * loaded machine, so it is not asserted.
 */
export async function waitForAutosave(page: Page): Promise<void> {
  await waitForSaved(page);
}

export async function dismissGuideIfOpen(page: Page): Promise<void> {
  // Schema v2 opens directly into the workspace; the v1 guide no longer
  // participates in startup.
  void page;
}

export async function gotoApp(
  page: Page,
  options: { dismissGuide?: boolean } = {},
): Promise<void> {
  await page.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  await waitForSaved(page, APP_READY_TIMEOUT_MS);
  if (options.dismissGuide ?? true) {
    await dismissGuideIfOpen(page);
  }
}

export async function createQuickNote(
  page: Page,
  note: { title: string; body: string },
): Promise<Locator> {
  await openTopbarMore(page);
  await page
    .getByRole("menuitem", { name: "Schnelle Notiz", exact: true })
    .click();

  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await editor.fill(note.body);
  await page.getByLabel("Seitentitel").fill(note.title);
  await waitForSaved(page);
  return editor;
}

/** Opens the ribbon's Datei menu; `path` then walks into its submenus ("Export", then the format). */
export async function chooseFileMenuItem(page: Page, ...path: string[]): Promise<void> {
  await page.locator(".ribbon__tabs").getByRole("button", { name: /^(Datei|File)$/ }).click();
  for (const name of path) {
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
}

/** Opens the Datei menu without choosing anything. */
export async function openFileMenu(page: Page): Promise<void> {
  await page.locator(".ribbon__tabs").getByRole("button", { name: /^(Datei|File)$/ }).click();
  await expect(page.getByRole("menu", { name: /^(Datei|File)$/ })).toBeVisible();
}

/** Chooses the language in the open More menu. */
export async function chooseLanguage(page: Page, language: "de" | "en"): Promise<void> {
  await page.getByRole("menuitemradio", { name: language === "de" ? "Deutsch" : "English", exact: true }).click();
}

export async function openTopbarMore(page: Page): Promise<void> {
  const menu = page.locator(".app-topbar").getByRole("button", { name: /^(Mehr|More)$/, exact: true });
  const quickNote = page.getByRole("menuitem", { name: /^(Schnelle Notiz|Quick note)$/, exact: true });
  if (!(await quickNote.isVisible())) await menu.click();
}

/** Opens the context menu of a navigation row with a right-click. */
export async function openContextMenu(page: Page, row: Locator): Promise<Locator> {
  await row.click({ button: "right" });
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  return menu;
}

/** Runs one command from a row's context menu. */
export async function contextCommand(page: Page, row: Locator, command: string | RegExp): Promise<void> {
  const menu = await openContextMenu(page, row);
  await menu.getByRole("menuitem", { name: command, exact: typeof command === "string" }).click();
}

export function notebookSwitcherButton(page: Page): Locator {
  return page.locator(".notebook-switcher__button");
}

/** The title of the open notebook, as the title bar's switcher shows it. */
export function activeNotebookTitle(page: Page): Locator {
  return page.locator(".notebook-switcher__title");
}

export async function openNotebookSwitcher(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: /^(Notizbuch wechseln|Switch notebook)$/ });
  if (!(await dialog.isVisible())) await notebookSwitcherButton(page).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function switchNotebook(page: Page, title: string): Promise<void> {
  const dialog = await openNotebookSwitcher(page);
  await notebookOption(page, dialog, title).click();
}

export function notebookOption(page: Page, dialog: Locator, title: string): Locator {
  return dialog.locator(".notebook-switcher__option:not(.notebook-switcher__option--page)").filter({
    has: page.locator(".notebook-switcher__option-title", { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  });
}

export async function createNotebook(page: Page): Promise<void> {
  const dialog = await openNotebookSwitcher(page);
  await dialog.getByRole("button", { name: /^(Neues Notizbuch|New notebook)$/ }).click();
}

export async function openPageSettings(page: Page): Promise<void> {
  const settings = page.getByRole("button", { name: /^(Seiteneinstellungen|Page settings)$/, exact: true });
  const close = page.getByRole("button", { name: /^(Seiteneinstellungen schliessen|Close page settings)$/ });
  if (!(await close.isVisible())) await settings.click();
}

export async function editSelectedText(page: Page): Promise<Locator> {
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeVisible();
  await editor.focus();
  return editor;
}

/** The rename field that replaced a label after "Umbenennen", F2 or a double click. */
export function inlineRenameField(page: Page): Locator {
  return page.locator("input.inline-rename");
}

/** Types a name into the open inline rename field and confirms it with Enter. */
export async function submitInlineRename(page: Page, name: string): Promise<void> {
  const field = inlineRenameField(page);
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press("Enter");
  await expect(field).toHaveCount(0);
}

/** The app's confirmation dialog (it replaces the browser's confirm box). */
export function confirmDialog(page: Page): Locator {
  return page.getByRole("alertdialog");
}

/** Confirms the open confirmation dialog and returns its message. */
export async function acceptConfirm(page: Page): Promise<string> {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  const message = (await dialog.locator("p").textContent()) ?? "";
  await dialog.locator(".confirm-dialog__confirm").click();
  await expect(dialog).toHaveCount(0);
  return message;
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const offenders = [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rectangle = element.getBoundingClientRect();
        if (
          rectangle.width <= 0 ||
          rectangle.height <= 0 ||
          !element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        ) {
          return false;
        }
        const crossesViewport =
          rectangle.right > window.innerWidth + 1 || rectangle.left < -1;
        if (!crossesViewport) return false;

        const intentionalScrollRegion = element.closest<HTMLElement>(
          ".canvas-viewport, .live-canvas-viewport, .editor-toolbar__scroll, .page-header, .ribbon__card, .ribbon__tabs",
        );
        if (intentionalScrollRegion && intentionalScrollRegion !== element) {
          const scrollRectangle =
            intentionalScrollRegion.getBoundingClientRect();
          if (
            rectangle.right > scrollRectangle.right + 1 ||
            rectangle.left < scrollRectangle.left - 1
          ) {
            return false;
          }
        }
        return true;
      })
      .slice(0, 8)
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return `${element.tagName.toLocaleLowerCase()}.${element.className}: ${rectangle.left.toFixed(1)}..${rectangle.right.toFixed(1)}`;
      });

    return {
      clientWidth: documentElement.clientWidth,
      scrollWidth: documentElement.scrollWidth,
      offenders,
    };
  });

  expect(
    metrics.scrollWidth,
    `Document overflowed by ${metrics.scrollWidth - metrics.clientWidth}px. Wide elements: ${metrics.offenders.join(", ")}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(
    metrics.offenders,
    `Visible elements crossed the viewport boundary: ${metrics.offenders.join(", ")}`,
  ).toEqual([]);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function installOneShotIndexedDbWriteFailure(
  page: Page,
): Promise<void> {
  await page.addInitScript(() => {
    let armed = false;
    let injected = false;
    const originalPut = IDBObjectStore.prototype.put;

    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (
        armed &&
        !injected &&
        this.transaction.db.name === "canvink-v2" &&
        key === "activation:v2"
      ) {
        injected = true;
        armed = false;
        throw new DOMException(
          "Canvink E2E injected one IndexedDB write failure.",
          "QuotaExceededError",
        );
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };

    Object.defineProperty(window, "__CANVINK_E2E__", {
      configurable: false,
      value: {
        armNextIndexedDbWriteFailure() {
          armed = true;
        },
      },
    });
  });
}

export async function armOneShotIndexedDbWriteFailure(
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    const controller = (
      window as unknown as {
        __CANVINK_E2E__?: { armNextIndexedDbWriteFailure: () => void };
      }
    ).__CANVINK_E2E__;
    if (!controller) {
      throw new Error("The IndexedDB failure controller was not installed.");
    }
    controller.armNextIndexedDbWriteFailure();
  });
}

export type RibbonTabName = "Start" | "Einfügen" | "Zeichnen" | "Ansicht";

const RIBBON_TAB_NAMES: Record<RibbonTabName, RegExp> = {
  Start: /^(Start|Home)$/,
  Einfügen: /^(Einfügen|Insert)$/,
  Zeichnen: /^(Zeichnen|Draw)$/,
  Ansicht: /^(Ansicht|View)$/,
};

/** Selects a tab of the OneNote-style ribbon and returns its panel. */
export async function ribbonTab(page: Page, tab: RibbonTabName): Promise<Locator> {
  const button = page.getByRole("tab", { name: RIBBON_TAB_NAMES[tab] });
  if ((await button.getAttribute("aria-selected")) !== "true") await button.click();
  return page.getByRole("tabpanel", { name: RIBBON_TAB_NAMES[tab] });
}

/** Einfügen → Text hinzufügen in the ribbon. */
export async function addTextFromRibbon(page: Page): Promise<void> {
  const insert = await ribbonTab(page, "Einfügen");
  await insert.getByRole("button", { name: /^(Text hinzufügen|Add text)$/ }).click();
}

/** One stroke as the editor's test hook reports it (screen coordinates). */
export interface InkStrokeInfo {
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  opacity: number;
  size: number;
  box: { x: number; y: number; width: number; height: number };
  /** A point on the ink (its middle sample), in screen coordinates. */
  samplePoint: { x: number; y: number };
  /** The stroke's points relative to its frame, as "x,y x,y ...". */
  localPoints: string;
}

/**
 * Ink is painted on canvas tiles, not as one DOM node per stroke. Test builds
 * (VITE_CANVINK_ALLOW_FEATURE_OVERRIDE) expose the strokes on screen through
 * `window.__canvinkInk`.
 */
export async function inkStrokes(page: Page): Promise<InkStrokeInfo[]> {
  await page.waitForFunction(() => "__canvinkInk" in window);
  return page.evaluate(() => {
    const hook = (window as Window & { __canvinkInk?: { strokes: () => InkStrokeInfo[] } }).__canvinkInk;
    if (!hook) throw new Error("The ink test hook is missing; build with VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1.");
    return hook.strokes();
  });
}

export async function expectInkCount(page: Page, count: number): Promise<void> {
  await expect(page.locator("[data-ink-stroke-count]")).toHaveAttribute(
    "data-ink-stroke-count",
    String(count),
  );
}

export async function inkCount(page: Page): Promise<number> {
  return Number(await page.locator("[data-ink-stroke-count]").getAttribute("data-ink-stroke-count"));
}

/** The painted ink colour at a screen point, or null where no ink is painted. */
export async function inkPixelAt(
  page: Page,
  point: { x: number; y: number },
): Promise<{ r: number; g: number; b: number; a: number } | null> {
  return page.evaluate(({ x, y }) => {
    const tiles = [...document.querySelectorAll<HTMLCanvasElement>(".live-canvas-ink-tile")];
    let found: { r: number; g: number; b: number; a: number } | null = null;
    for (const tile of tiles) {
      const rect = tile.getBoundingClientRect();
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue;
      const context = tile.getContext("2d");
      if (!context) continue;
      const px = Math.floor(((x - rect.left) / rect.width) * tile.width);
      const py = Math.floor(((y - rect.top) / rect.height) * tile.height);
      const [r, g, b, a] = context.getImageData(px, py, 1, 1).data;
      if (a > 0) found = { r, g, b, a };
    }
    return found;
  }, point);
}

/** Whether the live-ink overlay (stroke under the pen, lasso, eraser trail) is empty. */
export async function inkOverlayIsBlank(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const overlay = document.querySelector<HTMLCanvasElement>(".live-canvas-ink-overlay");
    const context = overlay?.getContext("2d");
    if (!overlay || !context || overlay.width === 0 || overlay.height === 0) return true;
    const { data } = context.getImageData(0, 0, overlay.width, overlay.height);
    for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) return false;
    return true;
  });
}

/**
 * Chooses the pen once and draws `count` strokes, as a user does right after
 * opening a page: no waiting, no choosing the pen again. Expects every stroke
 * to count and the pen to stay chosen.
 */
export async function drawPenStrokesRightAway(page: Page, count: number): Promise<void> {
  const pen = (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true });
  await pen.click();
  const surface = page.getByLabel("Ansicht der Zeichenfläche");
  const box = (await surface.boundingBox())!;
  const before = await inkCount(page);
  for (let index = 0; index < count; index += 1) {
    const y = box.y + 140 + index * 50;
    await page.mouse.move(box.x + 120, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + 120 + step * 14, y + Math.sin(step) * 8);
    await page.mouse.up();
  }
  await expectInkCount(page, before + count);
  await expect(pen).toHaveAttribute("aria-pressed", "true");
}
