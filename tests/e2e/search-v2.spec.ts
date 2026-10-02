import { jsPDF } from "jspdf";
import type { Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import {
  expect,
  gotoApp,
  openTopbarMore,
  test,
  waitForAutosave,
  waitForSaved,
} from "./support";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function scanPng(width = 120, height = 80): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      rows.set([245, 245, 245, 255], pixel);
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function worksheetPdf(): Buffer {
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  pdf.text("Lokales Such Arbeitsblatt", 72, 96);
  pdf.text("Impuls und Federkraft", 72, 140);
  return Buffer.from(pdf.output("arraybuffer"));
}

async function corruptSearchProjection(page: Page): Promise<void> {
  // Search keeps one record per page; every stored record is overwritten
  // with a value from an unknown format version.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("canvink-search-v3");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("records", "readwrite");
        const store = transaction.objectStore("records");
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          for (const key of keys.result) store.put({ version: 999, stale: "authority" }, key);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

test("searches edits after reload, PDF text, local OCR, and rebuilds a corrupt projection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      window as typeof window & { __CANVINK_LOCAL_OCR_TEST_ADAPTER__?: unknown }
    ).__CANVINK_LOCAL_OCR_TEST_ADAPTER__ = {
      availableLanguages: async () => ["de-DE", "en-US"],
      recognize: async () => ({
        engine: "windows-media-ocr",
        languageTag: "de-DE",
        text: "Optischer Prüftext Versuchsanordnung",
        lines: [{ text: "Optischer Prüftext Versuchsanordnung", words: [] }],
      }),
    };
  });
  await gotoApp(page);
  await openTopbarMore(page);
  await page
    .getByRole("menuitem", { name: "Schnelle Notiz", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await editor.fill("Beschleunigung und resultierende Kraft");
  await page.getByLabel("Seitentitel").fill("Dynamik Suche");
  await waitForAutosave(page);
  await editor.press("Escape");

  const search = page.getByRole("combobox", {
    name: "Arbeitsbereich lokal durchsuchen",
  });
  await search.fill("resultierende Kraft");
  const results = page.getByRole("listbox", { name: "Suchergebnisse" });
  await expect(
    results.getByRole("option", { name: /Dynamik Suche/ }),
  ).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await page
    .getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" })
    .fill("resultierende Kraft");
  await expect(
    page.getByRole("option", { name: /Dynamik Suche/ }),
  ).toBeVisible();

  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({
    name: "scan.png",
    mimeType: "image/png",
    buffer: scanPng(),
  });
  await expect(page.getByRole("img", { name: "scan" })).toBeVisible();
  // Maintenance sits in the "..." menu of the search surface, not on the surface itself.
  await page
    .getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" })
    .click();
  await page.getByRole("button", { name: "Weitere Suchaktionen" }).click();
  await page.getByRole("menuitem", { name: "Lokale OCR" }).click();
  await page
    .getByRole("radiogroup", { name: "Installierte Sprache" })
    .getByRole("radio", { name: "de-DE" })
    .click();
  await page.getByRole("button", { name: "Text lokal erkennen" }).click();
  await expect(
    page.getByRole("region", { name: "Lokale Suche" }).getByRole("status"),
  ).toContainText("OCR-Text wurde lokal erkannt", { timeout: 20_000 });
  await page
    .getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" })
    .fill("Optischer Prüftext");
  await expect(
    page.getByRole("option", { name: /Dynamik Suche/ }),
  ).toContainText("OCR");

  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .setInputFiles({
      name: "search-sheet.pdf",
      mimeType: "application/pdf",
      buffer: worksheetPdf(),
    });
  await expect(page.getByLabel("Seitentitel")).toHaveValue("Dynamik Suche");
  // The preview swaps a thumbnail for the sharp render, and both are in the
  // page while it does; either one shows the page arrived.
  await expect(page.getByRole("img", { name: "PDF Seite 1" }).first()).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" })
    .fill("Lokales Such Arbeitsblatt");
  await expect(
    page.getByRole("option", { name: /Dynamik Suche/ }),
  ).toContainText("PDF-Text", { timeout: 20_000 });

  await corruptSearchProjection(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSaved(page);
  await expect(
    page.getByRole("region", { name: "Lokale Suche" }),
  ).toContainText("Beschädigter Index wurde verworfen", { timeout: 20_000 });
  await page
    .getByRole("combobox", { name: "Arbeitsbereich lokal durchsuchen" })
    .fill("Optischer Prüftext");
  await expect(
    page
      .getByRole("listbox", { name: "Suchergebnisse" })
      .getByRole("option", { name: /Dynamik Suche/ }),
  ).toBeVisible();
});
