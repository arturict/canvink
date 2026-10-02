/**
 * Generates a synthetic Canvink workspace of a large notebook as raw IndexedDB records, for the lazy-page benchmark
 * (scripts/lazy-pages-bench.mjs).
 *
 * The records use the complete-image layout that a schema-v1 migration writes
 * (activation, v1 backup, assets, `repo-chunk:<n>` copies and live Automerge
 * Repo keys), so the same seed opens in builds before and after lazy loading.
 *
 * With `--school 1` it writes a small, written-in school notebook instead
 * (schoolNotebook.ts), which the landing-page clip films.
 *
 * Build and run (Vite bundles the app modules for Node):
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/cv/bench-seed --pages 400 --strokes 200000 --images 1000
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/cv/school-seed --school 1
 */
import { mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as Automerge from '@automerge/automerge';
import { generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo';
import {
  createAutomergeDocumentV3,
  getAutomergeHeads,
  saveAutomergeDocument,
} from '../../src/crdt/document';
import { canonicalJson, sha256Bytes, sha256Canonical } from '../../src/domain/v2/hash';
import { sealProjection } from '../../src/ink/seal';
import { MemorySegmentBackend, resetInkSegments } from '../../src/ink/segmentStore';
import type { PlainInkPage } from '../../src/ink/projection';
import type { AssetRef, MigrationManifestV2, NotebookDoc, NotebookSectionRef, Sha256Checksum } from '../../src/domain/v2/types';
import { upgradeManifestV2ToV3 } from '../../src/domain/v3/migration';
import { DEFAULT_MATH_PAGE_SETTINGS, type NotebookDocV3, type PageDocV3 } from '../../src/domain/v3/types';
import type { WorkspaceState } from '../../src/domain/types';
import { headsHash } from '../../src/storage/workspaceDocuments';
import { renderPictures, SCHOOL_START_PAGE, schoolPictures, schoolSections, worksheetPdfs } from './schoolNotebook';
import { syntheticPdf } from './syntheticPdf';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const outDir = arg('out', '/tmp/cv/bench-seed');
// `--school 1` seeds a written-in school notebook instead of bm's pages (see
// schoolNotebook.ts): "Schule 2026/27" with one coloured section per subject,
// by default beside the notebooks "Schule 2025/26", "Projekte" and "Privat".
// The landing-page clip films it; the size options below then default to 0.
const school = arg('school', '0') === '1';
// Names shown in the app; the defaults mirror the real notebook "bm" this seed imitates.
const pagePrefix = arg('page-prefix', 'bm Seite');
const notebookTitle = arg('notebook-title', school ? 'Schule 2026/27' : 'bm');
const pageCount = Number(arg('pages', school ? '0' : '400'));
const totalStrokes = Number(arg('strokes', school ? '0' : '200000'));
const imageCount = Number(arg('images', school ? '0' : '1000'));
const sectionCount = Number(arg('sections', school ? '0' : '10'));
const pointsPerStroke = Number(arg('points', '10'));
// Section groups of the first notebook: `--groups 8` nests some groups in
// others and puts most sections into a group, like a school notebook's terms.
const groupCount = Number(arg('groups', '0'));
// Further, light notebooks to switch between (`--extra-notebooks 2`), each with
// `--extra-pages` pages in three sections and a handful of strokes per page.
const extraNotebookCount = Number(arg('extra-notebooks', school ? '3' : '0'));
const extraPageCount = Number(arg('extra-pages', '20'));
// Their titles, comma-separated (`--extra-notebook-titles Projekte,Privat`); untitled ones are "Heft <n>".
const extraNotebookTitles = arg('extra-notebook-titles', school ? 'Schule 2025/26,Projekte,Privat' : '').split(',').filter(Boolean);
// One extra page shaped like bm's worst pages (an Algebra page with 6,641
// handwriting objects over printouts): `--heavy 7000` adds it as the second
// page of the first section, with `--heavy-images` printout backgrounds.
const heavyStrokes = Number(arg('heavy', '0'));
const heavyImages = Number(arg('heavy-images', '8'));
// `--heavy-pages 10` adds nine more heavy pages (`bm-heavy-2` to `bm-heavy-10`)
// after the first, for memory measurements across many heavy pages.
const heavyPageCount = Number(arg('heavy-pages', '1'));
// Printout size in pixels (bm's OneNote printouts are scans of about A4 at
// 150 to 200 dpi; the default is small so the older benchmarks keep their seed).
const [printoutWidth, printoutHeight] = arg('printout-size', '1000x1400').split('x').map(Number);
// `--heavy-pdf 1` places the heavy page's printouts as `pdf` elements
// linked to one multi-page source PDF, the way the OneNote import writes the
// 486 printouts of bm that have their PDF.
const heavyPdf = arg('heavy-pdf', '0') === '1';
// `--photos 12` adds a page of large JPEG photos, like the 288 pictures of bm.
const photoCount = Number(arg('photos', '0'));
// `--worksheet 300` adds a page with the same printouts and only that many
// strokes, to time the printouts without the cost of the ink.
const worksheetStrokes = Number(arg('worksheet', '0'));
const [photoWidth, photoHeight] = arg('photo-size', '4032x3024').split('x').map(Number);
// Worksheet PDFs as imported printouts carry: `--pdfs` distinct documents of
// `--pdf-pages` pages, and `--pdf-printouts` PDF elements spread over the
// pages, each showing one page of one of the documents.
const pdfCount = Number(arg('pdfs', '0'));
const pdfPages = Number(arg('pdf-pages', '4'));
const pdfPrintouts = Number(arg('pdf-printouts', '0'));
// `--ink packed` seeds pages the way earlier builds stored ink (every stroke inside the page document);
// the default `segments` puts ink into immutable segments, as a page created by an import is.
const inkMode = arg('ink', 'segments');
const segmentBackend = new MemorySegmentBackend();
const segmentStore = resetInkSegments(segmentBackend);
async function pageDocument<T extends PageDocV3>(projection: T): Promise<ReturnType<typeof createAutomergeDocumentV3>> {
  const prepared = inkMode === 'segments' ? await sealProjection(projection as unknown as PlainInkPage, segmentStore) : projection;
  return createAutomergeDocumentV3(prepared as unknown as T);
}
const TIME = '2026-09-25T08:00:00.000Z';

// Deterministic PRNG so every run produces the same workspace.
let seed = 0x2f6b_1a3d;
const random = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};

/** Strokes per page: most pages hold a few hundred, about one in ten 2,000 or more. */
function strokeDistribution(): number[] {
  const weights = Array.from({ length: pageCount }, (_, index) =>
    index % 10 === 3 ? 5 + random() * 2 : 0.3 + random() * 1.4);
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const counts = weights.map((weight) => Math.max(1, Math.round((weight / sum) * totalStrokes)));
  let difference = totalStrokes - counts.reduce((total, count) => total + count, 0);
  for (let index = 0; difference !== 0; index = (index + 1) % pageCount) {
    const step = difference > 0 ? 1 : -1;
    if (counts[index] + step >= 1) {
      counts[index] += step;
      difference -= step;
    }
  }
  return counts;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffff_ffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** A small, unique 24x16 RGB PNG. */
function syntheticPng(index: number): Uint8Array {
  const width = 24;
  const height = 16;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      raw[offset] = (index * 37 + x * 5) & 0xff;
      raw[offset + 1] = ((index >> 8) * 91 + y * 7) & 0xff;
      raw[offset + 2] = (index * 13 + x * y) & 0xff;
    }
  }
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** A printout-sized PNG (a scanned worksheet page): white with grey rows of "text". */
function syntheticPrintout(index: number, width = printoutWidth, height = printoutHeight): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width)).fill(255);
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width)] = 0;
    if (y % 28 < 10 && y > 80) {
      for (let x = Math.round(width * 0.08); x < width - Math.round(width * 0.08); x += 1) {
        // Anti-aliased glyph edges are noisy, so the PNG is a few hundred kilobytes, like a real scan.
        if (((x * 7 + y * 3 + index * 11) % 13) < 6) raw[y * (1 + width) + 1 + x] = 40 + Math.floor(random() * 120);
      }
    }
  }
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/**
 * A page like bm's worst: `strokes` imported handwriting strokes of about
 * `pointsPerStroke` points with pressure (as the OneNote importer writes
 * them: no tilt, no time), printout images pinned as backgrounds and a few
 * text boxes, on OneNote's squared paper.
 */
function heavyPageProjection(
  pageId: string,
  title: string,
  sectionId: string,
  strokes: number,
  printouts: AssetRef[],
  sourcePdf: AssetRef | undefined,
): PageDocV3 {
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  printouts.forEach((asset, imageIndex) => {
    const id = `${pageId}-printout${imageIndex}`;
    const frame = { x: 40, y: 60 + imageIndex * 1140, width: 794, height: 1112, rotation: 0 };
    const base = { id, frame, createdAt: TIME, updatedAt: TIME, locked: true };
    elementsById[id] = sourcePdf
      ? {
        ...base, kind: 'pdf', previewAsset: asset, originalAsset: sourcePdf,
        pageCount: printouts.length, sourcePageNumber: imageIndex + 1, sourceAvailability: 'original',
      }
      : { ...base, kind: 'image', asset, alt: `Ausdruck ${imageIndex + 1}` };
    zOrder.push(id);
  });
  for (let box = 0; box < 4; box += 1) {
    const id = `${pageId}-text${box}`;
    const sentence = Array.from({ length: 30 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
    elementsById[id] = {
      id, kind: 'richText', frame: { x: 60, y: 20 + box * 2280, width: 600, height: 80, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false,
      content: { type: 'doc', blocks: [{ id: `${id}-p`, type: 'paragraph', spans: [{ text: `${sentence} schwerstichwort`, marks: [] }] }] },
      style: { color: '#1f1f1f', fontFamily: 'Inter', fontSize: 16, textAlign: 'left' },
    };
    zOrder.push(id);
  }
  const height = Math.max(1, printouts.length) * 1140;
  const rows = Math.ceil(strokes / 40);
  for (let stroke = 0; stroke < strokes; stroke += 1) {
    const id = `${pageId}-s${stroke}`;
    const x0 = 60 + (stroke % 40) * 18 + random() * 4;
    const y0 = 90 + Math.floor(stroke / 40) * (height / rows) + random() * 4;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const points = Array.from({ length: pointsPerStroke }, (_, point) => {
      const x = Math.round((x0 + point * 1.4 + random() * 0.8) * 100) / 100;
      const y = Math.round((y0 + Math.sin(point / 1.7 + stroke) * 5 + random() * 0.8) * 100) / 100;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      return { x, y, pressure: Math.round((0.3 + random() * 0.5) * 1000) / 1000, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' };
    });
    elementsById[id] = {
      id, kind: 'stroke', frame: { x: minX, y: minY, width: maxX - minX, height: maxY - minY, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#1b1b8f', size: 1.5, opacity: 1, points,
    };
    zOrder.push(id);
  }
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId: 'bm', sectionId, pageId,
    title, tags: [], pageType: 'free',
    background: { type: 'grid', color: '#ffffff', spacing: 16, lineColor: '#caebfd' }, createdAt: TIME, updatedAt: TIME,
    elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

/** A page of phone-camera photos in a grid, shown at about a third of the page width each. */
function photoPageProjection(sectionId: string, photos: AssetRef[]): PageDocV3 {
  const pageId = 'bm-photos';
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  const frameWidth = 300;
  const frameHeight = Math.round(frameWidth * photoHeight / photoWidth);
  photos.forEach((asset, index) => {
    const id = `${pageId}-photo${index}`;
    elementsById[id] = {
      id, kind: 'image',
      frame: { x: 40 + (index % 3) * (frameWidth + 20), y: 60 + Math.floor(index / 3) * (frameHeight + 20), width: frameWidth, height: frameHeight, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, asset, alt: `Foto ${index + 1}`,
    };
    zOrder.push(id);
  });
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId: 'bm', sectionId, pageId,
    title: 'Fotos', tags: [], pageType: 'free',
    background: { type: 'lined', color: '#ffffff' }, createdAt: TIME, updatedAt: TIME,
    elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

/** A multi-page worksheet PDF with a little text per page. */
async function syntheticWorksheetPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < pages; page += 1) {
    const sheet = pdf.addPage([595, 842]);
    sheet.drawText(`Arbeitsblatt Seite ${page + 1}`, { x: 50, y: 780, size: 20, font });
    for (let line = 0; line < 40; line += 1) {
      sheet.drawText(`${line + 1}. Berechne die Ableitung von f(x) = ${line + 2}x^${(line % 5) + 2} + ${page}x`, {
        x: 50, y: 740 - line * 17, size: 10, font, color: rgb(0.1, 0.1, 0.1),
      });
    }
  }
  return pdf.save();
}

/**
 * Phone-camera style JPEGs (smooth gradients, shapes and light noise, a few
 * megabytes each), encoded by Chromium's own JPEG encoder.
 */
async function syntheticPhotos(count: number, width: number, height: number): Promise<Uint8Array[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const encoded = await page.evaluate(async ({ count, width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      const results: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const gradient = context.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, `hsl(${(index * 47) % 360} 55% 62%)`);
        gradient.addColorStop(1, `hsl(${(index * 47 + 120) % 360} 45% 38%)`);
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
        for (let shape = 0; shape < 40; shape += 1) {
          context.fillStyle = `hsl(${(index * 31 + shape * 23) % 360} 40% ${30 + (shape * 7) % 50}% / 0.6)`;
          context.beginPath();
          context.arc(((shape * 977 + index * 131) % width), ((shape * 613 + index * 71) % height), 80 + (shape * 37) % 400, 0, Math.PI * 2);
          context.fill();
        }
        const tile = context.getImageData(0, 0, width, height);
        let state = 0x9e3779b9 + index;
        for (let offset = 0; offset < tile.data.length; offset += 4) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
          const noise = ((state >>> 0) % 41) - 20;
          tile.data[offset] += noise; tile.data[offset + 1] += noise; tile.data[offset + 2] += noise;
        }
        context.putImageData(tile, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', 0.82));
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let start = 0; start < buffer.length; start += 0x8000) binary += String.fromCharCode(...buffer.subarray(start, start + 0x8000));
        results.push(btoa(binary));
      }
      return results;
    }, { count, width, height });
    return encoded.map((value) => new Uint8Array(Buffer.from(value, 'base64')));
  } finally {
    await browser.close();
  }
}

interface PdfPrintout {
  original: AssetRef;
  preview: AssetRef;
  pageNumber: number;
}

const WORDS = [
  'Algebra', 'Vektor', 'Funktion', 'Ableitung', 'Integral', 'Matrix', 'Gleichung', 'Parabel',
  'Wahrscheinlichkeit', 'Statistik', 'Geometrie', 'Kreis', 'Dreieck', 'Beweis', 'Übung', 'Prüfung',
];

function pageProjection(
  index: number, sectionId: string, strokes: number, images: AssetRef[], pdfs: PdfPrintout[] = [],
  notebookId = 'bm', titlePrefix = pagePrefix,
): PageDocV3 {
  const pageId = notebookId === 'bm' ? `bm-page-${index}` : `${notebookId}-page-${index}`;
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  const textId = `${pageId}-text`;
  const sentence = Array.from({ length: 24 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
  elementsById[textId] = {
    id: textId, kind: 'richText', frame: { x: 60, y: 40, width: 600, height: 120, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false,
    content: { type: 'doc', blocks: [{ id: `${textId}-p`, type: 'paragraph', spans: [{ text: `${sentence} stichwort${index}`, marks: [] }] }] },
    style: { color: '#1f1f1f', fontFamily: 'Inter', fontSize: 16, textAlign: 'left' },
  };
  zOrder.push(textId);
  const columns = 30;
  for (let stroke = 0; stroke < strokes; stroke += 1) {
    const id = `${pageId}-s${stroke}`;
    const x0 = 40 + (stroke % columns) * 22;
    const y0 = 200 + Math.floor(stroke / columns) * 18;
    const points = Array.from({ length: pointsPerStroke }, (_, point) => ({
      x: Math.round((x0 + point * 1.8 + random()) * 10) / 10,
      y: Math.round((y0 + Math.sin(point / 2) * 4 + random()) * 10) / 10,
      pressure: Math.round((0.35 + random() * 0.4) * 100) / 100,
      tiltX: 0,
      tiltY: 0,
      time: stroke * 40 + point * 4,
      pointerType: 'pen',
    }));
    elementsById[id] = {
      id, kind: 'stroke', frame: { x: x0, y: y0 - 6, width: 20, height: 12, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#1b1b8f', size: 2, opacity: 1, points,
    };
    zOrder.push(id);
  }
  images.forEach((asset, imageIndex) => {
    const id = `${pageId}-img${imageIndex}`;
    elementsById[id] = {
      id, kind: 'image', frame: { x: 700, y: 60 + imageIndex * 90, width: 120, height: 80, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, asset, alt: `Bild ${imageIndex + 1}`,
    };
    zOrder.push(id);
  });
  pdfs.forEach((printout, pdfIndex) => {
    const id = `${pageId}-pdf${pdfIndex}`;
    elementsById[id] = {
      id, kind: 'pdf', frame: { x: 40, y: 700 + pdfIndex * 300, width: 400, height: 280, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: true, originalAsset: printout.original, previewAsset: printout.preview,
      pageCount: pdfPages, sourcePageNumber: printout.pageNumber, sourceAvailability: 'original',
    };
    zOrder.push(id);
  });
  return {
    schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId, sectionId, pageId,
    title: `${titlePrefix} ${index + 1}`, tags: index % 25 === 0 ? ['wichtig'] : [], pageType: 'a4',
    background: { type: 'lined', color: '#ffffff' }, createdAt: TIME, updatedAt: TIME,
    elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

interface SeedRecord {
  key: string | string[];
  /** json: `value`; bytes: raw Uint8Array; asset: AssetBlob; chunk: RepoChunkV2 ({ key, bytes }). */
  type: 'json' | 'bytes' | 'asset' | 'chunk' | 'segment';
  value?: unknown;
  chunkKey?: string[];
  offset?: number;
  length?: number;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const binPath = join(outDir, 'seed.bin');
  const bin = openSync(binPath, 'w');
  let binOffset = 0;
  const appendBinary = (bytes: Uint8Array): { offset: number; length: number } => {
    writeSync(bin, bytes);
    const result = { offset: binOffset, length: bytes.length };
    binOffset += bytes.length;
    return result;
  };
  const records: SeedRecord[] = [];
  const started = Date.now();

  // Assets: small unique PNGs, spread over the pages.
  const assets: AssetRef[] = [];
  for (let index = 0; index < imageCount; index += 1) {
    const bytes = syntheticPng(index);
    const assetId = await sha256Bytes(bytes);
    assets.push({ assetId, checksum: assetId, mimeType: 'image/png', size: bytes.length, role: 'original', fileName: `bild-${index + 1}.png` });
    records.push({ key: `asset:${assetId}`, type: 'asset', value: { assetId, checksum: assetId, size: bytes.length }, ...appendBinary(bytes) });
  }

  const printouts: AssetRef[] = [];
  for (let index = 0; heavyStrokes > 0 && index < heavyImages; index += 1) {
    const bytes = syntheticPrintout(index);
    const assetId = await sha256Bytes(bytes);
    printouts.push({ assetId, checksum: assetId, mimeType: 'image/png', size: bytes.length, role: 'original', fileName: `ausdruck-${index + 1}.png` });
    records.push({ key: `asset:${assetId}`, type: 'asset', value: { assetId, checksum: assetId, size: bytes.length }, ...appendBinary(bytes) });
  }

  let sourcePdf: AssetRef | undefined;
  if (heavyPdf && heavyStrokes > 0) {
    const bytes = await syntheticWorksheetPdf(heavyImages);
    const assetId = await sha256Bytes(bytes);
    sourcePdf = { assetId, checksum: assetId, mimeType: 'application/pdf', size: bytes.length, role: 'original', fileName: 'arbeitsblatt.pdf' };
    records.push({ key: `asset:${assetId}`, type: 'asset', value: { assetId, checksum: assetId, size: bytes.length }, ...appendBinary(bytes) });
  }
  const photos: AssetRef[] = [];
  if (photoCount > 0) {
    for (const [index, bytes] of (await syntheticPhotos(photoCount, photoWidth, photoHeight)).entries()) {
      const assetId = await sha256Bytes(bytes);
      photos.push({ assetId, checksum: assetId, mimeType: 'image/jpeg', size: bytes.length, role: 'original', fileName: `foto-${index + 1}.jpg` });
      records.push({ key: `asset:${assetId}`, type: 'asset', value: { assetId, checksum: assetId, size: bytes.length }, ...appendBinary(bytes) });
    }
  }
  const pdfDocuments: AssetRef[] = [];
  for (let index = 0; index < pdfCount; index += 1) {
    const bytes = await syntheticPdf(index, pdfPages);
    const assetId = await sha256Bytes(bytes);
    pdfDocuments.push({ assetId, checksum: assetId, mimeType: 'application/pdf', size: bytes.length, role: 'original', fileName: `arbeitsblatt-${index + 1}.pdf` });
    records.push({ key: `asset:${assetId}`, type: 'asset', value: { assetId, checksum: assetId, size: bytes.length }, ...appendBinary(bytes) });
  }
  const pdfPreview = pdfCount > 0 ? assets[0] ?? printouts[0] : undefined;
  const pdfPrintoutList: PdfPrintout[] = pdfPreview
    ? Array.from({ length: pdfPrintouts }, (_, index) => ({
      original: pdfDocuments[index % pdfCount],
      preview: pdfPreview,
      pageNumber: (Math.floor(index / pdfCount) % pdfPages) + 1,
    }))
    : [];

  const sections = Array.from({ length: sectionCount }, (_, index) => ({
    id: `bm-section-${index + 1}`, title: `Abschnitt ${index + 1}`, createdAt: TIME, updatedAt: TIME, pageDocumentIds: [] as string[],
  }));
  // Groups: every third one nests in the group before it; sections are dealt
  // into the groups in turn, except every fifth, which stays at the top level.
  const sectionGroups = Array.from({ length: groupCount }, (_, index) => ({
    id: `bm-group-${index + 1}`, title: `Gruppe ${index + 1}`, createdAt: TIME, updatedAt: TIME,
    ...(index % 3 === 2 ? { parentGroupId: `bm-group-${index}` } : {}),
  }));
  const sectionsWithGroups = sections.map((section, index) => (
    groupCount > 0 && index % 5 !== 4 ? { ...section, groupId: `bm-group-${(index % groupCount) + 1}` } : section
  ));
  const strokeCounts = strokeDistribution();
  const documents: Array<{ documentId: string; kind: 'notebook' | 'page'; url: string; heads: string[] }> = [];
  const chunks: Array<{ key: string[]; offset: number; length: number; checksum: Sha256Checksum }> = [];
  let points = 0;
  let maxStrokes = 0;
  const pageInfo: Array<{ pageId: string; title: string; strokes: number; sectionId: string; sectionTitle: string; token: string }> = [];
  // Heavy pages sit right after the first light page of the first section.
  const addHeavyPage = async (section: (typeof sections)[number], number: number): Promise<void> => {
    const heavy = heavyPageProjection(
      number === 1 ? 'bm-heavy' : `bm-heavy-${number}`, number === 1 ? 'Algebra schwer' : `Algebra schwer ${number}`,
      section.id, heavyStrokes, printouts, sourcePdf,
    );
    section.pageDocumentIds.splice(number, 0, heavy.documentId);
    const heavyDocument = await pageDocument(heavy);
    const heavyBytes = saveAutomergeDocument(heavyDocument);
    const heavyHeads = getAutomergeHeads(heavyDocument);
    Automerge.free(heavyDocument);
    const heavyUrl = generateAutomergeUrl();
    documents.push({ documentId: heavy.documentId, kind: 'page', url: heavyUrl, heads: heavyHeads });
    chunks.push({
      key: [parseAutomergeUrl(heavyUrl).documentId, 'snapshot', await headsHash(heavyHeads)],
      checksum: await sha256Bytes(heavyBytes),
      ...appendBinary(heavyBytes),
    });
    pageInfo.push({
      pageId: heavy.pageId, title: heavy.title, strokes: heavyStrokes,
      sectionId: section.id, sectionTitle: section.title, token: 'schwerstichwort',
    });
    points += heavyStrokes * pointsPerStroke;
    maxStrokes = Math.max(maxStrokes, heavyStrokes);
  };
  for (let index = 0; index < pageCount; index += 1) {
    const section = sectionsWithGroups[Math.floor((index * sectionCount) / pageCount)];
    const pageImages = assets.filter((_, assetIndex) => assetIndex % pageCount === index);
    const pagePdfs = pdfPrintoutList.filter((_, printoutIndex) => printoutIndex % pageCount === index);
    const projection = pageProjection(index, section.id, strokeCounts[index], pageImages, pagePdfs);
    section.pageDocumentIds.push(projection.documentId);
    const document = await pageDocument(projection);
    const bytes = saveAutomergeDocument(document);
    const heads = getAutomergeHeads(document);
    Automerge.free(document);
    const url = generateAutomergeUrl();
    const storageId = parseAutomergeUrl(url).documentId;
    documents.push({ documentId: projection.documentId, kind: 'page', url, heads });
    chunks.push({ key: [storageId, 'snapshot', await headsHash(heads)], checksum: await sha256Bytes(bytes), ...appendBinary(bytes) });
    pageInfo.push({
      pageId: projection.pageId, title: projection.title, strokes: strokeCounts[index],
      sectionId: section.id, sectionTitle: section.title, token: `stichwort${index}`,
    });
    points += strokeCounts[index] * pointsPerStroke;
    maxStrokes = Math.max(maxStrokes, strokeCounts[index]);
    if (index === 0 && heavyStrokes > 0) await addHeavyPage(section, 1);
    const extraPages = [
      ...(heavyStrokes > 0 && worksheetStrokes > 0 ? [{ id: 'bm-worksheet', title: 'Arbeitsblatt', strokes: worksheetStrokes, token: 'arbeitsblatt' }] : []),
    ];
    for (const extra of index === 0 ? extraPages : []) {
      const heavy = heavyPageProjection(extra.id, extra.title, section.id, extra.strokes, printouts, sourcePdf);
      section.pageDocumentIds.push(heavy.documentId);
      const heavyDocument = await pageDocument(heavy);
      const heavyBytes = saveAutomergeDocument(heavyDocument);
      const heavyHeads = getAutomergeHeads(heavyDocument);
      Automerge.free(heavyDocument);
      const heavyUrl = generateAutomergeUrl();
      documents.push({ documentId: heavy.documentId, kind: 'page', url: heavyUrl, heads: heavyHeads });
      chunks.push({
        key: [parseAutomergeUrl(heavyUrl).documentId, 'snapshot', await headsHash(heavyHeads)],
        checksum: await sha256Bytes(heavyBytes),
        ...appendBinary(heavyBytes),
      });
      pageInfo.push({
        pageId: heavy.pageId, title: heavy.title, strokes: extra.strokes,
        sectionId: section.id, sectionTitle: section.title, token: extra.token,
      });
      points += extra.strokes * pointsPerStroke;
      maxStrokes = Math.max(maxStrokes, extra.strokes);
    }
    if (index === 0 && photos.length > 0) {
      const photoPage = photoPageProjection(section.id, photos);
      section.pageDocumentIds.push(photoPage.documentId);
      const photoDocument = createAutomergeDocumentV3(photoPage);
      const photoPageBytes = saveAutomergeDocument(photoDocument);
      const photoHeads = getAutomergeHeads(photoDocument);
      Automerge.free(photoDocument);
      const photoUrl = generateAutomergeUrl();
      documents.push({ documentId: photoPage.documentId, kind: 'page', url: photoUrl, heads: photoHeads });
      chunks.push({
        key: [parseAutomergeUrl(photoUrl).documentId, 'snapshot', await headsHash(photoHeads)],
        checksum: await sha256Bytes(photoPageBytes),
        ...appendBinary(photoPageBytes),
      });
      pageInfo.push({
        pageId: photoPage.pageId, title: photoPage.title, strokes: 0,
        sectionId: section.id, sectionTitle: section.title, token: 'fotos',
      });
    }
    if ((index + 1) % 50 === 0) console.error(`pages ${index + 1}/${pageCount} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  for (let number = 2; heavyStrokes > 0 && number <= heavyPageCount; number += 1) await addHeavyPage(sectionsWithGroups[0], number);

  // The school notebook: rendered figures and worksheets (with their PDFs), then its pages.
  const schoolAssets = new Map<string, AssetRef>();
  const schoolRefs: NotebookSectionRef[] = [];
  let schoolStrokes = 0;
  if (school) {
    const files: Array<{ key: string; bytes: Uint8Array; mimeType: string }> = [
      ...[...(await renderPictures(schoolPictures()))].map(([key, bytes]) => ({ key, bytes, mimeType: 'image/png' })),
      ...[...(await worksheetPdfs())].map(([key, bytes]) => ({ key: `${key}.pdf`, bytes, mimeType: 'application/pdf' })),
    ];
    for (const { key, bytes, mimeType } of files) {
      const assetId = await sha256Bytes(bytes);
      const fileName = mimeType === 'image/png' ? `${key}.png` : key;
      schoolAssets.set(key, { assetId, checksum: assetId, mimeType, size: bytes.length, role: 'original', fileName });
      records.push({ key: `asset:${assetId}`, type: 'asset', value: { assetId, checksum: assetId, size: bytes.length }, ...appendBinary(bytes) });
    }
    const asset = (key: string): AssetRef => {
      const ref = schoolAssets.get(key);
      if (!ref) throw new Error(`No school asset ${key}`);
      return ref;
    };
    for (const section of schoolSections('bm', asset)) {
      const ref: NotebookSectionRef = { id: section.id, title: section.title, color: section.color, createdAt: TIME, updatedAt: TIME, pageDocumentIds: [] };
      for (const projection of section.pages) {
        ref.pageDocumentIds.push(projection.documentId);
        const document = await pageDocument(projection);
        const bytes = saveAutomergeDocument(document);
        const heads = getAutomergeHeads(document);
        Automerge.free(document);
        const url = generateAutomergeUrl();
        documents.push({ documentId: projection.documentId, kind: 'page', url, heads });
        chunks.push({ key: [parseAutomergeUrl(url).documentId, 'snapshot', await headsHash(heads)], checksum: await sha256Bytes(bytes), ...appendBinary(bytes) });
        const strokes = Object.values(projection.elementsById).filter((element) => element.kind === 'stroke').length;
        pageInfo.push({ pageId: projection.pageId, title: projection.title, strokes, sectionId: section.id, sectionTitle: section.title, token: projection.pageId });
        schoolStrokes += strokes;
        maxStrokes = Math.max(maxStrokes, strokes);
      }
      schoolRefs.push(ref);
    }
  }
  const addNotebook = async (notebook: NotebookDocV3): Promise<void> => {
    const notebookDocument = createAutomergeDocumentV3(notebook as unknown as NotebookDoc);
    const notebookBytes = saveAutomergeDocument(notebookDocument);
    const notebookHeads = getAutomergeHeads(notebookDocument);
    Automerge.free(notebookDocument);
    const notebookUrl = generateAutomergeUrl();
    const notebookStorageId = parseAutomergeUrl(notebookUrl).documentId;
    documents.unshift({ documentId: notebook.documentId, kind: 'notebook', url: notebookUrl, heads: notebookHeads });
    chunks.push({
      key: [notebookStorageId, 'snapshot', await headsHash(notebookHeads)],
      checksum: await sha256Bytes(notebookBytes),
      ...appendBinary(notebookBytes),
    });
  };
  const extraNotebookIds: string[] = [];
  for (let notebookIndex = 0; notebookIndex < extraNotebookCount; notebookIndex += 1) {
    const notebookId = `nb${notebookIndex + 2}`;
    const extraSections = Array.from({ length: 3 }, (_, index) => ({
      id: `${notebookId}-section-${index + 1}`, title: `Abschnitt ${index + 1}`, createdAt: TIME, updatedAt: TIME, pageDocumentIds: [] as string[],
    }));
    for (let index = 0; index < extraPageCount; index += 1) {
      const section = extraSections[index % extraSections.length];
      const projection = pageProjection(index, section.id, 30, [], [], notebookId, `${extraNotebookTitles[notebookIndex] ?? `Heft ${notebookIndex + 2}`} Seite`);
      section.pageDocumentIds.push(projection.documentId);
      const document = await pageDocument(projection);
      const bytes = saveAutomergeDocument(document);
      const heads = getAutomergeHeads(document);
      Automerge.free(document);
      const url = generateAutomergeUrl();
      documents.push({ documentId: projection.documentId, kind: 'page', url, heads });
      chunks.push({ key: [parseAutomergeUrl(url).documentId, 'snapshot', await headsHash(heads)], checksum: await sha256Bytes(bytes), ...appendBinary(bytes) });
    }
    await addNotebook({
      schemaVersion: 3, documentId: `notebook:${notebookId}`, kind: 'notebook', notebookId, title: extraNotebookTitles[notebookIndex] ?? `Heft ${notebookIndex + 2}`,
      color: ['#2b7a78', '#c0392b', '#d68910'][notebookIndex % 3], createdAt: TIME, updatedAt: TIME, sections: extraSections,
      settings: { defaultPageType: 'a4' }, version: { protocol: 'uninitialized', heads: [] },
    });
    extraNotebookIds.push(notebookId);
  }
  await addNotebook({
    schemaVersion: 3, documentId: 'notebook:bm', kind: 'notebook', notebookId: 'bm', title: notebookTitle, color: '#7a4fa0',
    createdAt: TIME, updatedAt: TIME, sections: school ? schoolRefs : sectionsWithGroups, ...(groupCount > 0 ? { sectionGroups } : {}),
    settings: { defaultPageType: 'a4' }, version: { protocol: 'uninitialized', heads: [] },
  });
  // Ink segments: raw blobs, stored by the benches in the segment database.
  for (const [hash, bytes] of segmentBackend.blobs) records.push({ key: hash, type: 'segment', ...appendBinary(bytes) });
  closeSync(bin);

  // The schema-v1 source of the (synthetic) migration: a minimal valid workspace.
  const v1: WorkspaceState = {
    schemaVersion: 1, updatedAt: TIME,
    notebooks: [{ id: 'legacy', title: 'Alt', color: '#123456', createdAt: TIME, updatedAt: TIME,
      sections: [{ id: 'legacy-section', title: 'Alt', createdAt: TIME, updatedAt: TIME,
        pages: [{ id: 'legacy-page', title: 'Alt', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }] }] }],
    trash: [], activeNotebookId: 'legacy', activeSectionId: 'legacy-section', activePageId: 'legacy-page',
  };
  const sourceFingerprint = await sha256Canonical(v1);
  const migrationId = `workspace-v1-to-v2:${sourceFingerprint.slice(7)}`;
  const firstPage = documents.find((document) => document.kind === 'page')!;
  const active = school
    ? { notebookId: 'bm', sectionId: schoolRefs[0].id, pageId: SCHOOL_START_PAGE }
    : { notebookId: 'bm', sectionId: sections[0].id, pageId: firstPage.documentId.slice('page:'.length) };
  const v2Manifest: MigrationManifestV2 = {
    schemaVersion: 2, format: 'canvink-schema-v2',
    migration: { name: 'workspace-v1-to-v2', version: 1, migrationId, sourceFingerprint, preparedAt: TIME },
    active,
    notebookDocumentIds: ['notebook:bm', ...extraNotebookIds.map((id) => `notebook:${id}`)],
    pageDocumentIds: documents.filter((document) => document.kind === 'page').map((document) => document.documentId),
    assetIds: [...assets, ...printouts, ...photos, ...pdfDocuments, ...(sourcePdf ? [sourcePdf] : []), ...schoolAssets.values()].map((asset) => asset.assetId).sort(),
    trash: [],
  };
  const manifest = upgradeManifestV2ToV3(v2Manifest, `sha256:${'5'.repeat(64)}`, TIME);
  // Chunk order is the Repo image order of a migration: canonical key order.
  chunks.sort((left, right) => canonicalJson(left.key).localeCompare(canonicalJson(right.key)));
  const activation = {
    version: 1, schemaVersion: 3, format: 'canvink-automerge-v3', migrationId, sourceFingerprint,
    artifactFingerprint: await sha256Canonical({ namespace: 'canvink-bench-seed', pageCount, totalStrokes, imageCount, ...(school ? { school } : {}) }),
    activatedAt: TIME, manifest, documents,
    chunks: chunks.map((chunk) => ({ key: chunk.key, checksum: chunk.checksum, size: chunk.length })),
    assetIds: manifest.assetIds,
  };
  chunks.forEach((chunk, index) => {
    records.push({ key: `repo-chunk:${index.toString().padStart(8, '0')}`, type: 'chunk', chunkKey: chunk.key, offset: chunk.offset, length: chunk.length });
    records.push({ key: ['automerge-repo', ...chunk.key], type: 'bytes', offset: chunk.offset, length: chunk.length });
  });
  records.push({ key: `backup:${migrationId}`, type: 'json', value: { version: 1, migrationId, sourceFingerprint, createdAt: TIME, workspace: v1 } });
  records.push({ key: 'activation:v2', type: 'json', value: activation });
  writeFileSync(join(outDir, 'seed.json'), JSON.stringify({
    database: 'canvink-v2', store: 'documents-assets',
    stats: { pages: pageCount + (heavyStrokes > 0 ? heavyPageCount + (worksheetStrokes > 0 ? 1 : 0) : 0) + (photos.length > 0 ? 1 : 0) + (school ? pageInfo.length : 0), strokes: totalStrokes + heavyStrokes * (heavyStrokes > 0 ? heavyPageCount : 0) + schoolStrokes, points, maxStrokesPerPage: maxStrokes, images: imageCount, bytes: binOffset },
    firstPage: active,
    pages: pageInfo,
    notebooks: ['bm', ...extraNotebookIds],
    records,
  }));
  process.stdout.write(`${JSON.stringify({ outDir, pages: pageCount, strokes: totalStrokes, points, maxStrokes, images: imageCount, bytes: binOffset, seconds: (Date.now() - started) / 1000 })}\n`);
}

void main();
