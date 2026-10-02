import type { Page } from "@playwright/test";
import { expect, test } from "./support";

/**
 * The landing page is its own chunk and must not pull in the editor or the
 * app's icon bundle. Its clips download only when they scroll into view, and
 * with reduced motion they are still posters that request no video at all.
 * The language follows the browser until one is chosen; the choice is stored
 * where the app reads it.
 */
const EDITOR_CHUNKS = /^(V2NotebookApp|MarkdownPageEditor|pdf|mathlive|compute-engine|jsxgraph|sodium)[.-]/;
const ICON_CHUNK = /^lucide[.-]/;
const LANGUAGE_KEY = "canvink:language:v1";

function recordRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  return requests;
}

function loadedScripts(requests: string[]): string[] {
  return requests.map((path) => path.split("/").pop() ?? "").filter((name) => name.endsWith(".js"));
}

test.describe("German browser", () => {
  test.use({ locale: "de-CH" });

  test("the landing page offers the browser, the Windows installer, the Android APK and the PWA without loading the editor", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto("/");

    await expect(page.locator("main")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ein Notizbuch wie OneNote. Ohne das Warten.");
    await expect(page.getByRole("link", { name: "Im Browser öffnen" }).first()).toHaveAttribute("href", "/app");
    await expect(page.getByRole("link", { name: "Canvink für Windows laden" })).toHaveAttribute("href", /^\/download\/.+\.exe$/);
    await expect(page.getByRole("link", { name: "APK laden" })).toHaveAttribute("href", "/download/Canvink.apk");
    await expect(page.getByRole("heading", { name: "Als App installieren" })).toBeVisible();

    const scripts = loadedScripts(requests);
    expect(scripts.some((name) => name.startsWith("LandingPage-"))).toBe(true);
    expect(scripts.filter((name) => EDITOR_CHUNKS.test(name))).toEqual([]);
    expect(scripts.filter((name) => ICON_CHUNK.test(name))).toEqual([]);
  });

  test("clips load when they come into view and play muted", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto("/");
    await expect(page.locator("video")).toHaveCount(4);

    // Only the first clip, the notebook in the hero, is on screen at the start.
    await expect.poll(() => requests.filter((path) => path.startsWith("/landing/") && /\.(webm|mp4)$/.test(path))).toEqual([
      expect.stringMatching(/^\/landing\/notebook\.(webm|mp4)$/),
    ]);

    const collab = page.locator("video").nth(1);
    await collab.scrollIntoViewIfNeeded();
    await expect.poll(() => collab.evaluate((video: HTMLVideoElement) => !video.paused && video.muted)).toBe(true);
  });

  test("with reduced motion the clips are posters and no video is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const requests = recordRequests(page);
    await page.goto("/");
    await expect(page.locator("img.lp-media")).toHaveCount(4);
    await expect(page.locator("video")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(requests.filter((path) => /\.(webm|mp4)$/.test(path))).toEqual([]);
  });
});

test.describe("English browser", () => {
  test.use({ locale: "en-US" });

  test("English follows the browser, and a chosen language is stored for the app", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("main")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A notebook like OneNote. Without the waiting.");
    // The hero and the download card both offer the installer.
    const installer = page.getByRole("link", { name: "Download for Windows" });
    await expect(installer).toHaveCount(2);
    await expect(installer.last()).toHaveAttribute("href", /^\/download\/.+\.exe$/);
    // Detection alone stores nothing; the app keeps its own default.
    expect(await page.evaluate((key) => localStorage.getItem(key), LANGUAGE_KEY)).toBeNull();

    await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "DE" }).click();
    await expect(page.locator("main")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ein Notizbuch wie OneNote. Ohne das Warten.");
    expect(await page.evaluate((key) => localStorage.getItem(key), LANGUAGE_KEY)).toBe("de");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("button", { name: "DE" })).toHaveAttribute("aria-pressed", "true");
  });
});
