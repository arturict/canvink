#!/usr/bin/env node
/**
 * Generates a synthetic OneNote desktop export in the layout written by
 * scripts/onenote-com-export.ps1 (see src/import/onenoteDesktop/exportFormat.ts):
 * manifest.json, pages/<n>.xml, ink/<n>.json, assets/<sha256>.png for every
 * printout page image and files/<sha256>.pdf for every printed document.
 *
 * The defaults describe a large synthetic notebook (398 pages, about
 * 204,500 strokes with about 2.1 million ink points, 1,046 printout pages).
 * Everything is invented and deterministic for a given seed.
 *
 *   node scripts/onenote-synthetic-export.mjs --out /tmp/bm-export
 *   node scripts/onenote-synthetic-export.mjs --out /tmp/small --pages 40 --strokes 8000 --points 80000 --printouts 60
 *
 * Options: --pages, --strokes, --points, --printouts, --seed, --max-strokes
 * (largest page), --printout-size WxH (pixel size of each printout PNG; noisy
 * pixels, so larger sizes give realistic, incompressible image bytes),
 * --pdf-kb (padding of each printed document).
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ONE = 'http://schemas.microsoft.com/office/onenote/2013/onenote';
const PT_PER_PX = 72 / 96;

export const BM_SCALE = Object.freeze({
  pages: 398,
  strokes: 204_500,
  points: 2_100_000,
  printouts: 1_046,
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(random) {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Splits `total` into integer parts proportional to `weights`, each at most `cap`. */
function apportion(total, weights, cap = Number.POSITIVE_INFINITY) {
  const parts = weights.map(() => 0);
  let remaining = total;
  let open = weights.map((_, index) => index);
  while (remaining > 0 && open.length > 0) {
    const sum = open.reduce((acc, index) => acc + weights[index], 0);
    let assigned = 0;
    for (const index of open) {
      const share = Math.floor((remaining * weights[index]) / sum);
      const room = cap - parts[index];
      const add = Math.min(share, room);
      parts[index] += add;
      assigned += add;
    }
    remaining -= assigned;
    open = open.filter((index) => parts[index] < cap);
    if (assigned === 0) {
      // Rounding leftovers go to the heaviest open parts, one each.
      for (const index of [...open].sort((a, b) => weights[b] - weights[a])) {
        if (remaining === 0) break;
        parts[index] += 1;
        remaining -= 1;
      }
    }
  }
  return parts;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A unique greyscale PNG for one printout page. */
export function printoutPng(index, width, height, random) {
  const noisy = width * height > 64 * 96;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      // Lines of "text" plus the page index as a bit pattern in the first row.
      const text = y % 12 < 2 && x > 4 && x < width - 4 ? 40 : 250;
      const bit = y === 0 && x < 32 ? ((index >>> x) & 1) * 200 : 0;
      const noise = noisy ? Math.floor(random() * 24) : 0;
      raw[y * (width + 1) + 1 + x] = Math.max(0, Math.min(255, text - bit - noise));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

export function printoutPdf(document, pages, paddingKb) {
  const body = `%PDF-1.7\n% synthetic printed document ${document} with ${pages} pages\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(body, 'latin1'), Buffer.alloc(paddingKb * 1024, 0x20), Buffer.from('\n%%EOF\n')]));
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Plans the notebook: sections, pages, and per page the number of strokes,
 * the points of each stroke and the number of printout pages.
 */
export function planSyntheticExport(options = {}) {
  const pages = options.pages ?? BM_SCALE.pages;
  const strokes = options.strokes ?? BM_SCALE.strokes;
  const points = options.points ?? BM_SCALE.points;
  const printouts = options.printouts ?? BM_SCALE.printouts;
  const maxStrokes = options.maxStrokes ?? 7_000;
  const random = mulberry32(options.seed ?? 1);
  // Most school pages carry some handwriting, a few carry a lot (heavy tail).
  const inkWeights = Array.from({ length: pages }, () => (random() < 0.12 ? 0 : Math.exp(1.3 * normal(random))));
  if (inkWeights.every((weight) => weight === 0)) inkWeights[0] = 1;
  const strokeCounts = apportion(strokes, inkWeights, maxStrokes);
  // About one page in six has a printed document behind it (worksheets, slides).
  const printoutWeights = Array.from({ length: pages }, () => (random() < 0.17 ? 0.3 + random() : 0));
  if (printouts > 0 && printoutWeights.every((weight) => weight === 0)) printoutWeights[0] = 1;
  const printoutCounts = apportion(printouts, printoutWeights, 60);
  const meanPoints = strokes > 0 ? points / strokes : 0;
  const sectionCount = Math.max(1, Math.min(14, Math.ceil(pages / 28)));
  const sections = Array.from({ length: sectionCount }, (_, index) => ({
    id: `{S${String(index + 1).padStart(4, '0')}}{1}{B0}`,
    name: `Fach ${index + 1}`,
    groupPath: index % 4 === 3 ? ['Archiv', `Semester ${Math.ceil(index / 4)}`] : index % 3 === 1 ? ['Semester 2'] : [],
    color: `#${(0x6a4c93 + index * 0x131313).toString(16).slice(-6)}`,
    pages: [],
  }));
  let pointBudget = points;
  let strokeBudget = strokes;
  const planned = [];
  for (let index = 0; index < pages; index += 1) {
    const section = sections[Math.min(sectionCount - 1, Math.floor((index * sectionCount) / pages))];
    const strokePoints = [];
    for (let stroke = 0; stroke < strokeCounts[index]; stroke += 1) {
      const target = strokeBudget > 0 ? pointBudget / strokeBudget : meanPoints;
      const count = Math.max(2, Math.min(120, Math.round(target * Math.exp(0.45 * normal(random)))));
      strokePoints.push(count);
      pointBudget -= count;
      strokeBudget -= 1;
    }
    const page = {
      number: index + 1,
      id: `{P${String(index + 1).padStart(4, '0')}}{1}{B0}`,
      name: `Lektion ${index + 1}`,
      // Every eighth page is a subpage of the page before it.
      level: section.pages.length > 0 && index % 8 === 5 ? 2 : 1,
      strokePoints,
      printoutPages: printoutCounts[index],
    };
    section.pages.push(page);
    planned.push(page);
  }
  return { sections, pages: planned };
}

function inkForPage(page, random) {
  const objects = {};
  const drawings = [];
  let cursor = 0;
  let line = 0;
  while (cursor < page.strokePoints.length) {
    const strokesInLine = Math.min(page.strokePoints.length - cursor, 30 + Math.floor(random() * 40));
    const key = `i${line}`;
    const baseY = 160 + line * 28;
    const strokes = [];
    let x = 60 + random() * 20;
    for (let stroke = 0; stroke < strokesInLine; stroke += 1) {
      const count = page.strokePoints[cursor + stroke];
      const p = [];
      const amplitude = 3 + random() * 6;
      const phase = random() * Math.PI * 2;
      for (let point = 0; point < count; point += 1) {
        const t = point / Math.max(1, count - 1);
        p.push(
          Math.round((x + t * 14 + Math.sin(phase + t * 9) * 2 + random() * 0.6) * 100) / 100,
          Math.round((baseY + Math.cos(phase + t * 7) * amplitude + random() * 0.6) * 100) / 100,
          Math.round((0.35 + 0.4 * Math.sin(t * Math.PI) + random() * 0.05) * 1000) / 1000,
        );
      }
      strokes.push({ c: stroke % 17 === 0 ? '#c00000' : '#1f3a93', a: 255, w: 1.8, h: 1.8, hl: false, p });
      x += 12 + random() * 8;
      if (x > 700) x = 60 + random() * 20;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
      for (let index = 0; index < stroke.p.length; index += 3) {
        minX = Math.min(minX, stroke.p[index]);
        maxX = Math.max(maxX, stroke.p[index]);
        minY = Math.min(minY, stroke.p[index + 1]);
        maxY = Math.max(maxY, stroke.p[index + 1]);
      }
    }
    objects[key] = { bounds: [minX, minY, maxX - minX, maxY - minY], strokes };
    drawings.push({ key, x: minX, y: minY, width: maxX - minX, height: maxY - minY, z: line + 10 });
    cursor += strokesInLine;
    line += 1;
  }
  return { objects, drawings };
}

function pageXml(page, drawings, printout) {
  const title = escapeXml(page.name);
  const parts = [
    `<?xml version="1.0"?>`,
    `<one:Page xmlns:one="${ONE}" ID="${page.id}" name="${title}" dateTime="2026-03-02T08:00:00.000Z" lastModifiedTime="2026-03-02T09:30:00.000Z" pageLevel="${page.level}" lang="de-CH">`,
    `  <one:QuickStyleDef index="0" name="PageTitle" fontColor="automatic" highlightColor="automatic" font="Calibri Light" fontSize="20.0" spaceBefore="0.0" spaceAfter="0.0"/>`,
    `  <one:QuickStyleDef index="1" name="p" fontColor="automatic" font="Calibri" fontSize="11.0" spaceBefore="0.0" spaceAfter="0.0"/>`,
    `  <one:PageSettings RTL="false" color="automatic"><one:PageSize><one:Automatic/></one:PageSize><one:RuleLines visible="false"/></one:PageSettings>`,
    `  <one:Title lang="de-CH"><one:OE quickStyleIndex="0"><one:T><![CDATA[${page.name}]]></one:T></one:OE></one:Title>`,
    `  <one:Outline><one:Position x="36.0" y="86.4" z="0"/><one:Size width="400.0" height="20.0"/>`,
    `    <one:OEChildren><one:OE quickStyleIndex="1"><one:T><![CDATA[Notizen zu ${page.name}: Aufgaben, Lösungen und Skizzen.]]></one:T></one:OE></one:OEChildren>`,
    `  </one:Outline>`,
  ];
  if (printout) {
    parts.push(
      `  <one:InsertedFile pathCache="C:\\cache\\${page.number}.bin" pathSource="C:\\Schule\\dokument-${page.number}.pdf" preferredName="dokument-${page.number}.pdf" canvinkFile="${printout.pdf}">`,
      `    <one:Position x="36.0" y="120.0" z="1"/><one:Size width="60.0" height="60.0"/><one:Printout xpsFileIndex="0"/>`,
      `  </one:InsertedFile>`,
    );
    printout.images.forEach((image, index) => {
      parts.push(
        `  <one:Image format="png" isPrintOut="true" xpsFileIndex="0" originalPageNumber="${index}" canvinkAsset="${image}">`,
        `    <one:Position x="36.0" y="${(200 + index * 860).toFixed(1)}" z="${2 + index}"/><one:Size width="595.0" height="842.0"/>`,
        `  </one:Image>`,
      );
    });
  }
  for (const drawing of drawings) {
    parts.push(
      `  <one:InkDrawing canvinkInk="${drawing.key}">`,
      `    <one:Position x="${(drawing.x * PT_PER_PX).toFixed(2)}" y="${(drawing.y * PT_PER_PX).toFixed(2)}" z="${drawing.z + (printout?.images.length ?? 0)}"/><one:Size width="${(drawing.width * PT_PER_PX).toFixed(2)}" height="${(drawing.height * PT_PER_PX).toFixed(2)}"/>`,
      `  </one:InkDrawing>`,
    );
  }
  parts.push('</one:Page>');
  return parts.join('\n');
}

/**
 * Yields `[path, bytes]` for every file of the export, page by page, and the
 * manifest last (it records the checksums of the assets). Also returns totals.
 */
export async function* syntheticExportEntries(options = {}) {
  const plan = planSyntheticExport(options);
  const random = mulberry32((options.seed ?? 1) + 7);
  const [width, height] = String(options.printoutSize ?? '48x64').split('x').map(Number);
  const pdfKb = options.pdfKb ?? 2;
  const encoder = new TextEncoder();
  const assets = [];
  const totals = { pages: 0, strokes: 0, points: 0, printoutPages: 0, documents: 0, bytes: 0 };
  let printoutIndex = 0;
  for (const page of plan.pages) {
    const file = `pages/${String(page.number).padStart(4, '0')}.xml`;
    const inkPath = `ink/${String(page.number).padStart(4, '0')}.json`;
    let printout;
    if (page.printoutPages > 0) {
      const pdf = printoutPdf(page.number, page.printoutPages, pdfKb);
      const pdfHash = sha256Hex(pdf);
      const pdfPath = `files/${pdfHash}.pdf`;
      assets.push({ path: pdfPath, mediaType: 'application/pdf', bytes: pdf.byteLength, sha256: pdfHash, originalName: `dokument-${page.number}.pdf` });
      totals.documents += 1;
      totals.bytes += pdf.byteLength;
      yield [pdfPath, pdf];
      const images = [];
      for (let index = 0; index < page.printoutPages; index += 1) {
        const png = printoutPng(printoutIndex++, width, height, random);
        const pngHash = sha256Hex(png);
        const pngPath = `assets/${pngHash}.png`;
        assets.push({ path: pngPath, mediaType: 'image/png', bytes: png.byteLength, sha256: pngHash, width, height });
        images.push(pngPath);
        totals.bytes += png.byteLength;
        yield [pngPath, png];
      }
      printout = { pdf: pdfPath, images };
      totals.printoutPages += images.length;
    }
    const { objects, drawings } = inkForPage(page, random);
    if (drawings.length > 0) {
      const ink = encoder.encode(JSON.stringify({ objects }));
      totals.bytes += ink.byteLength;
      yield [inkPath, ink];
    }
    const xml = encoder.encode(pageXml(page, drawings, printout));
    totals.bytes += xml.byteLength;
    yield [file, xml];
    page.file = file;
    page.ink = drawings.length > 0 ? inkPath : undefined;
    totals.pages += 1;
    totals.strokes += page.strokePoints.length;
    totals.points += page.strokePoints.reduce((sum, count) => sum + count, 0);
  }
  const manifest = {
    format: 'canvink-onenote-desktop-export',
    version: 1,
    exportedAt: '2026-09-25T10:00:00.000Z',
    generator: 'scripts/onenote-synthetic-export.mjs',
    notebook: { id: '{NB-SYNTHETIC}{1}{B0}', name: options.name ?? 'bm (synthetisch)' },
    sections: plan.sections.map((section) => ({
      id: section.id,
      name: section.name,
      groupPath: section.groupPath,
      color: section.color,
      pages: section.pages.map((page) => ({
        id: page.id,
        name: page.name,
        level: page.level,
        created: '2026-03-02T08:00:00.000Z',
        modified: '2026-03-02T09:30:00.000Z',
        file: page.file,
        ...(page.ink ? { ink: page.ink } : {}),
      })),
    })),
    assets,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  totals.bytes += manifestBytes.byteLength;
  yield ['manifest.json', manifestBytes];
  return totals;
}

/** Writes the export into `directory` (replacing it) and returns its totals. */
export async function writeSyntheticExport(directory, options = {}) {
  await rm(directory, { recursive: true, force: true });
  const iterator = syntheticExportEntries(options);
  for (;;) {
    const next = await iterator.next();
    if (next.done) return next.value;
    const [path, bytes] = next.value;
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
}

/** Collects the export in memory, for tests at small scale. */
export async function syntheticExportMap(options = {}) {
  const entries = new Map();
  const iterator = syntheticExportEntries(options);
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { entries, totals: next.value };
    entries.set(next.value[0], next.value[1]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  if (!args.out) throw new Error('--out <directory> is required');
  const number = (key) => (args[key] === undefined ? undefined : Number(args[key]));
  const started = performance.now();
  const totals = await writeSyntheticExport(args.out, {
    pages: number('pages'),
    strokes: number('strokes'),
    points: number('points'),
    printouts: number('printouts'),
    maxStrokes: number('max-strokes'),
    seed: number('seed'),
    printoutSize: args['printout-size'],
    pdfKb: number('pdf-kb'),
  });
  console.log(JSON.stringify({ out: args.out, ...totals, ms: Math.round(performance.now() - started) }));
}
