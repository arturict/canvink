/**
 * The synthetic school notebook of `seed-workspace.ts --school 1`: a Swiss
 * Gymnasium notebook "Schule 2026/27" with coloured subject sections and pages
 * that look written in: typed notes, handwriting, worked maths, sketches,
 * textbook figures and worksheet printouts. Everything is generated here; no
 * real notebook is read. The landing-page clip (scripts/record-landing-clips.mjs)
 * films it.
 */
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { AssetRef, RichTextBlock, RichTextMark, RichTextSpan } from '../../src/domain/v2/types';
import { DEFAULT_MATH_PAGE_SETTINGS, type PageDocV3, type PageElementV3 } from '../../src/domain/v3/types';
import { generator, measure, sketch, spline, withPressure, write, type InkLine } from './handwriting';

/* ------------------------------------------------------------------ pictures */

type Point = [number, number];

/** One drawing command of a picture, run on a canvas in Chromium. */
export type DrawOp =
  | { op: 'text'; x: number; y: number; text: string; size: number; color?: string; weight?: number; italic?: boolean; serif?: boolean; align?: 'left' | 'center' | 'right' }
  | { op: 'path'; points: Point[]; width: number; color: string; fill?: string; dash?: number[] }
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; width?: number }
  | { op: 'circle'; x: number; y: number; r: number; fill: string };

export interface Worksheet {
  school: string;
  title: string;
  intro: string;
  tasks: string[];
  pages: number;
}

/** A picture to render: free drawing commands or a worksheet page. */
export type PictureSpec =
  | { key: string; kind: 'ops'; width: number; height: number; ops: DrawOp[] }
  | { key: string; kind: 'worksheet'; width: number; height: number; sheet: Worksheet };

interface Plot {
  width: number;
  height: number;
  x: [number, number];
  y: [number, number];
  ticks: { x: number[]; y: number[] };
  axes: [string, string];
  curves: Array<{ f: (x: number) => number; from?: number; to?: number; color: string; width?: number; dash?: number[] }>;
  points?: Array<{ x: number; y: number; label: string; dx?: number; dy?: number }>;
  labels?: Array<{ x: number; y: number; text: string; color: string }>;
  caption: string;
}

/** A textbook figure: grid, axes with arrows and ticks, curves, marked points and a caption. */
function plotOps(plot: Plot): DrawOp[] {
  const left = 70;
  const right = plot.width - 40;
  const top = 40;
  const bottom = plot.height - 90;
  const px = (x: number) => left + ((x - plot.x[0]) / (plot.x[1] - plot.x[0])) * (right - left);
  const py = (y: number) => bottom - ((y - plot.y[0]) / (plot.y[1] - plot.y[0])) * (bottom - top);
  const ops: DrawOp[] = [{ op: 'rect', x: 0, y: 0, w: plot.width, h: plot.height, fill: '#ffffff', stroke: '#d4d8de', width: 3 }];
  for (let x = Math.ceil(plot.x[0] * 2) / 2; x <= plot.x[1]; x += 0.5) ops.push({ op: 'path', points: [[px(x), top], [px(x), bottom]], width: 1.5, color: Number.isInteger(x) ? '#dfe3e8' : '#eef0f3' });
  for (let y = Math.ceil(plot.y[0] * 2) / 2; y <= plot.y[1]; y += 0.5) ops.push({ op: 'path', points: [[left, py(y)], [right, py(y)]], width: 1.5, color: Number.isInteger(y) ? '#dfe3e8' : '#eef0f3' });
  const ox = px(Math.max(plot.x[0], 0));
  const oy = py(Math.max(plot.y[0], 0));
  ops.push(
    { op: 'path', points: [[left - 10, oy], [right + 18, oy]], width: 3, color: '#222222' },
    { op: 'path', points: [[right + 4, oy - 9], [right + 20, oy], [right + 4, oy + 9]], width: 3, color: '#222222', fill: '#222222' },
    { op: 'path', points: [[ox, bottom + 10], [ox, top - 18]], width: 3, color: '#222222' },
    { op: 'path', points: [[ox - 9, top - 4], [ox, top - 20], [ox + 9, top - 4]], width: 3, color: '#222222', fill: '#222222' },
    { op: 'text', x: right + 18, y: oy - 18, text: plot.axes[0], size: 30, italic: true, serif: true, align: 'right' },
    { op: 'text', x: ox + 16, y: top + 4, text: plot.axes[1], size: 30, italic: true, serif: true },
  );
  for (const x of plot.ticks.x) {
    ops.push({ op: 'path', points: [[px(x), oy - 7], [px(x), oy + 7]], width: 2.5, color: '#222222' });
    ops.push({ op: 'text', x: px(x), y: oy + 34, text: String(x).replace('-', '−'), size: 24, align: 'center', serif: true });
  }
  for (const y of plot.ticks.y) {
    ops.push({ op: 'path', points: [[ox - 7, py(y)], [ox + 7, py(y)]], width: 2.5, color: '#222222' });
    ops.push({ op: 'text', x: ox - 14, y: py(y) + 8, text: String(y).replace('-', '−'), size: 24, align: 'right', serif: true });
  }
  for (const curve of plot.curves) {
    const from = curve.from ?? plot.x[0];
    const to = curve.to ?? plot.x[1];
    const points: Point[] = [];
    for (let step = 0; step <= 240; step += 1) {
      const x = from + ((to - from) * step) / 240;
      const y = curve.f(x);
      if (y >= plot.y[0] - 0.3 && y <= plot.y[1] + 0.3) points.push([px(x), py(y)]);
    }
    ops.push({ op: 'path', points, width: curve.width ?? 5, color: curve.color, dash: curve.dash });
  }
  for (const point of plot.points ?? []) {
    ops.push({ op: 'circle', x: px(point.x), y: py(point.y), r: 8, fill: '#c62828' });
    ops.push({ op: 'text', x: px(point.x) + (point.dx ?? 14), y: py(point.y) + (point.dy ?? -14), text: point.label, size: 26, serif: true, color: '#c62828' });
  }
  for (const label of plot.labels ?? []) ops.push({ op: 'text', x: px(label.x), y: py(label.y), text: label.text, size: 28, italic: true, serif: true, color: label.color });
  ops.push({ op: 'text', x: 24, y: plot.height - 30, text: plot.caption, size: 25, italic: true, serif: true, color: '#333333' });
  return ops;
}

const CUBIC = (x: number) => x ** 3 - 3 * x;

const WORKSHEETS: Record<string, Worksheet> = {
  'worksheet-kurven': {
    school: 'Kantonsschule am See · Mathematik 3c',
    title: 'Arbeitsblatt 7 – Kurvendiskussion',
    intro: 'Gegeben ist die Funktion f(x) = x³ − 3x.',
    tasks: [
      'Untersuche f auf Symmetrie.',
      'Bestimme die Nullstellen von f.',
      'Berechne f′(x) und f″(x).',
      'Ermittle die Hoch- und Tiefpunkte.',
      'Bestimme den Wendepunkt.',
      'Skizziere den Graphen für −2 ≤ x ≤ 2.',
      'Berechne die Fläche zwischen dem Graphen und der x-Achse im Intervall [0; √3].',
    ],
    pages: 2,
  },
};

/** Every picture the school notebook shows, by key. */
export function schoolPictures(): PictureSpec[] {
  return [
    {
      key: 'figure-cubic', kind: 'ops', width: 750, height: 560, ops: plotOps({
        width: 750, height: 560, x: [-2.4, 2.4], y: [-3, 3], ticks: { x: [-2, -1, 1, 2], y: [-2, 2] }, axes: ['x', 'y'],
        curves: [{ f: CUBIC, color: '#1d4ed8' }],
        points: [{ x: -1, y: 2, label: 'H(−1 | 2)', dx: -60, dy: -22 }, { x: 1, y: -2, label: 'T(1 | −2)', dx: -40, dy: 40 }, { x: 0, y: 0, label: 'W', dx: 14, dy: 30 }],
        labels: [{ x: 1.75, y: 2.4, text: 'f', color: '#1d4ed8' }],
        caption: 'Abb. 4.3  Graph von f(x) = x³ − 3x',
      }),
    },
    ...Object.entries(WORKSHEETS).map(([key, sheet]): PictureSpec => ({ key, kind: 'worksheet', width: 1240, height: 1754, sheet })),
  ];
}

/** Renders the pictures with Chromium's canvas; returns PNG bytes by key. */
export async function renderPictures(specs: PictureSpec[]): Promise<Map<string, Uint8Array>> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const encoded = await page.evaluate(async (pictures) => {
      const sans = '"Noto Sans", "DejaVu Sans", sans-serif';
      const serif = '"Noto Serif", "DejaVu Serif", serif';
      const results: string[] = [];
      for (const picture of pictures) {
        const canvas = document.createElement('canvas');
        canvas.width = picture.width;
        canvas.height = picture.height;
        const context = canvas.getContext('2d')!;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        const lines = (text: string, width: number) => {
          const out: string[] = [];
          let line = '';
          for (const word of text.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (line && context.measureText(next).width > width) {
              out.push(line);
              line = word;
            } else line = next;
          }
          if (line) out.push(line);
          return out;
        };
        if (picture.kind === 'worksheet') {
          const { sheet } = picture;
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, picture.width, picture.height);
          context.fillStyle = '#5f6670';
          context.font = `30px ${sans}`;
          context.fillText(sheet.school, 110, 120);
          context.textAlign = 'right';
          context.fillText('Name: ____________________', 1130, 120);
          context.textAlign = 'left';
          context.strokeStyle = '#9aa1ab';
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(110, 152);
          context.lineTo(1130, 152);
          context.stroke();
          context.fillStyle = '#111111';
          context.font = `700 62px ${sans}`;
          context.fillText(sheet.title, 110, 260);
          context.font = `42px ${sans}`;
          let y = 350;
          for (const line of lines(sheet.intro, 1020)) {
            context.fillText(line, 110, y);
            y += 58;
          }
          y += 30;
          sheet.tasks.forEach((task, index) => {
            context.font = `700 42px ${sans}`;
            context.fillText(`${index + 1}.`, 110, y);
            context.font = `42px ${sans}`;
            for (const line of lines(task, 960)) {
              context.fillText(line, 170, y);
              y += 58;
            }
            y += 26;
          });
          const boxTop = y + 10;
          context.strokeStyle = '#d6dbe1';
          context.lineWidth = 1.5;
          for (let gridY = boxTop; gridY <= 1640; gridY += 40) {
            context.beginPath();
            context.moveTo(110, gridY);
            context.lineTo(1130, gridY);
            context.stroke();
          }
          for (let gridX = 110; gridX <= 1130; gridX += 40) {
            context.beginPath();
            context.moveTo(gridX, boxTop);
            context.lineTo(gridX, 1640);
            context.stroke();
          }
          context.fillStyle = '#7a818b';
          context.font = `28px ${sans}`;
          context.textAlign = 'center';
          context.fillText(`Seite 1 von ${sheet.pages}`, 620, 1710);
          context.textAlign = 'left';
        } else {
          for (const op of picture.ops) {
            if (op.op === 'rect') {
              if (op.fill) {
                context.fillStyle = op.fill;
                context.fillRect(op.x, op.y, op.w, op.h);
              }
              if (op.stroke) {
                context.strokeStyle = op.stroke;
                context.lineWidth = op.width ?? 2;
                context.strokeRect(op.x + (op.width ?? 2) / 2, op.y + (op.width ?? 2) / 2, op.w - (op.width ?? 2), op.h - (op.width ?? 2));
              }
            } else if (op.op === 'circle') {
              context.fillStyle = op.fill;
              context.beginPath();
              context.arc(op.x, op.y, op.r, 0, Math.PI * 2);
              context.fill();
            } else if (op.op === 'path') {
              context.strokeStyle = op.color;
              context.lineWidth = op.width;
              context.setLineDash(op.dash ?? []);
              context.beginPath();
              op.points.forEach(([x, y], index) => (index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
              if (op.fill) {
                context.closePath();
                context.fillStyle = op.fill;
                context.fill();
              }
              context.stroke();
              context.setLineDash([]);
            } else {
              context.fillStyle = op.color ?? '#222222';
              context.font = `${op.italic ? 'italic ' : ''}${op.weight ?? 400} ${op.size}px ${op.serif ? serif : sans}`;
              context.textAlign = op.align ?? 'left';
              context.fillText(op.text, op.x, op.y);
              context.textAlign = 'left';
            }
          }
        }
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))), 'image/png'));
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let start = 0; start < buffer.length; start += 0x8000) binary += String.fromCharCode(...buffer.subarray(start, start + 0x8000));
        results.push(btoa(binary));
      }
      return results;
    }, specs);
    return new Map(specs.map((spec, index) => [spec.key, new Uint8Array(Buffer.from(encoded[index], 'base64'))]));
  } finally {
    await browser.close();
  }
}

/** Standard PDF fonts only cover WinAnsi; maths signs fall back to ASCII there. */
const winAnsi = (text: string) => text
  .replaceAll('−', '-').replaceAll('′', "'").replaceAll('″', "''").replaceAll('≤', '<=').replaceAll('√3', 'sqrt(3)');

/** The source PDFs of the worksheet printouts, by key: the same text as their pictures. */
export async function worksheetPdfs(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const [key, sheet] of Object.entries(WORKSHEETS)) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    for (let pageNumber = 1; pageNumber <= sheet.pages; pageNumber += 1) {
      const page = pdf.addPage([595, 842]);
      const grey = rgb(0.37, 0.4, 0.44);
      page.drawText(winAnsi(sheet.school), { x: 53, y: 784, size: 10, font, color: grey });
      if (pageNumber === 1) {
        page.drawText(winAnsi(sheet.title), { x: 53, y: 718, size: 20, font: bold });
        page.drawText(winAnsi(sheet.intro), { x: 53, y: 676, size: 13, font });
        sheet.tasks.forEach((task, index) => page.drawText(`${index + 1}.  ${winAnsi(task)}`, { x: 53, y: 640 - index * 30, size: 12, font, maxWidth: 490 }));
      } else {
        page.drawText('Platz für deine Lösungen', { x: 53, y: 718, size: 14, font: bold });
      }
      page.drawText(`Seite ${pageNumber} von ${sheet.pages}`, { x: 262, y: 30, size: 9, font, color: grey });
    }
    out.set(key, await pdf.save({ useObjectStreams: false }));
  }
  return out;
}

/* --------------------------------------------------------------------- pages */

const INK = { blue: '#1d4ed8', black: '#1f2937', red: '#dc2626', green: '#15803d', purple: '#7c3aed' };
const HIGHLIGHT = { yellow: '#facc15', green: '#4ade80', pink: '#f472b6' };
const TEXT_STYLE = { color: '#111827', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', textAlign: 'left' as const };

const span = (text: string, ...marks: Array<RichTextMark['type']>): RichTextSpan => ({ text, marks: marks.map((type) => ({ type })) });
type BlockSpec =
  | { h: string; level?: 2 | 3 }
  | { p: Array<RichTextSpan | string>; list?: 'bullet' | 'ordered' }
  | { table: string[][] };

interface WriteStyle {
  size?: number;
  color?: string;
  pen?: number;
}

/** Collects the elements of one page in paint order. */
class PageBuilder {
  readonly elementsById: PageDocV3['elementsById'] = {};
  readonly zOrder: string[] = [];
  readonly random: () => number;
  private count = 0;
  private clock = 0;
  private readonly pageId: string;
  private readonly time: string;

  constructor(pageId: string, time: string, seed: number) {
    this.pageId = pageId;
    this.time = time;
    this.random = generator(seed);
  }

  private add(element: PageElementV3): void {
    this.elementsById[element.id] = element;
    this.zOrder.push(element.id);
  }

  private nextId(kind: string): string {
    this.count += 1;
    return `${this.pageId}-${kind}${this.count}`;
  }

  text(frame: { x: number; y: number; width: number; height: number }, blocks: BlockSpec[], fontSize = 15): void {
    const id = this.nextId('text');
    const spans = (parts: Array<RichTextSpan | string>) => parts.map((part) => (typeof part === 'string' ? span(part) : part));
    const content: RichTextBlock[] = blocks.map((block, index) => {
      const blockId = `${id}-b${index}`;
      if ('h' in block) return { id: blockId, type: 'heading', level: block.level ?? 2, spans: [span(block.h)] };
      if ('table' in block) return { id: blockId, type: 'table', rows: block.table.map((row, rowIndex) => row.map((cell) => (cell ? [span(cell, ...(rowIndex === 0 ? ['bold' as const] : []))] : []))) };
      return { id: blockId, type: 'paragraph', spans: spans(block.p), ...(block.list ? { list: block.list } : {}) };
    });
    this.add({
      id, kind: 'richText', frame: { ...frame, rotation: 0 }, createdAt: this.time, updatedAt: this.time, locked: false,
      content: { type: 'doc', blocks: content }, style: { ...TEXT_STYLE, fontSize },
    });
  }

  ink(lines: InkLine[], color: string, size: number, tool: 'pen' | 'highlighter' = 'pen'): void {
    for (const line of lines) {
      if (line.points.length === 0) continue;
      const xs = line.points.map((point) => point.x);
      const ys = line.points.map((point) => point.y);
      const start = this.clock;
      this.clock += line.points.length * 8 + 120;
      this.add({
        id: this.nextId('s'), kind: 'stroke',
        frame: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), rotation: 0 },
        createdAt: this.time, updatedAt: this.time, locked: false, tool, color, size, opacity: tool === 'highlighter' ? 0.36 : 1,
        points: line.points.map((point, index) => ({ ...point, tiltX: 0, tiltY: 0, time: start + index * 8, pointerType: 'pen' })),
      });
    }
  }

  /** Handwriting from (x, baseline); returns where the pen stopped. */
  write(text: string, x: number, baseline: number, style: WriteStyle = {}): number {
    const { lines, end } = write(text, x, baseline, { size: style.size ?? 8.5, random: this.random });
    this.ink(lines, style.color ?? INK.blue, style.pen ?? 1.5);
    return end;
  }

  /** A handwritten fraction with its bar on the maths axis of `baseline`; returns its right end. */
  fraction(top: string, bottom: string, x: number, baseline: number, style: WriteStyle = {}): number {
    const size = style.size ?? 7.5;
    const topWidth = measure(top, size);
    const bottomWidth = measure(bottom, size);
    const width = Math.max(topWidth, bottomWidth) + size * 0.8;
    const bar = baseline - size * 0.55;
    this.write(top, x + (width - topWidth) / 2, bar - size * 0.45, { ...style, size });
    this.write(bottom, x + (width - bottomWidth) / 2, bar + size * 2.05, { ...style, size });
    this.line([[x, bar + 0.4], [x + width, bar - 0.4]], style.color ?? INK.black, style.pen ?? 1.5);
    return x + width + size * 0.3;
  }

  line(points: Point[], color: string, size = 1.5, wobble = 0.8): void {
    this.ink([sketch(points, this.random, wobble)], color, size);
  }

  arrow(from: Point, to: Point, color: string, size = 1.5): void {
    this.line([from, to], color, size);
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const wing = (side: number): Point => [to[0] - Math.cos(angle + side * 0.45) * 8, to[1] - Math.sin(angle + side * 0.45) * 8];
    this.ink([withPressure(spline([wing(1), to, wing(-1)], 1.2), this.random)], color, size);
  }

  /** A hand-drawn box, the way a result gets framed: the corners overshoot a little. */
  box(x: number, y: number, width: number, height: number, color: string, size = 1.6): void {
    this.line([[x + 2, y], [x + width, y - 1], [x + width + 1, y + height], [x - 1, y + height + 1], [x, y - 3]], color, size, 1.2);
  }

  highlight(x1: number, x2: number, y: number, color = HIGHLIGHT.yellow): void {
    const path: Point[] = [];
    for (let x = x1; x <= x2; x += 6) path.push([x, y + Math.sin(x / 40) * 0.8]);
    this.ink([withPressure(path, this.random, 0.7)], color, 14, 'highlighter');
  }

  image(asset: AssetRef, frame: { x: number; y: number; width: number; height: number }, alt: string): void {
    this.add({ id: this.nextId('img'), kind: 'image', frame: { ...frame, rotation: 0 }, createdAt: this.time, updatedAt: this.time, locked: false, asset, alt });
  }

  printout(preview: AssetRef, original: AssetRef, pageCount: number, frame: { x: number; y: number; width: number; height: number }): void {
    this.add({
      id: this.nextId('pdf'), kind: 'pdf', frame: { ...frame, rotation: 0 }, createdAt: this.time, updatedAt: this.time, locked: true,
      previewAsset: preview, originalAsset: original, pageCount, sourcePageNumber: 1, sourceAvailability: 'original',
    });
  }
}

/* ------------------------------------------------------------------ subjects */

type Paper = PageDocV3['background'];
const GRID: Paper = { type: 'grid', color: '#ffffff', spacing: 20 };
const LINED: Paper = { type: 'lined', color: '#ffffff', spacing: 28 };

interface Subject {
  title: string;
  color: string;
  paper: Paper;
  topics: string[];
  /** Short handwritten lines for the plainer pages of the section. */
  notes: string[];
  intro: (topic: string) => string;
}

const SUBJECTS: Subject[] = [
  {
    title: 'Analysis', color: '#1f6fb2', paper: GRID,
    topics: ['Grenzwerte', 'Ableitungen', 'Produktregel', 'Kettenregel', 'Kurvendiskussion', 'Extremwertaufgaben', 'Integralrechnung', 'Prüfungsvorbereitung'],
    notes: ['lim (1 + 1/n)ⁿ = e', 'f(x) = x² · sin(x)', 'f\'(x) = 2x · sin(x) + x² · cos(x)', 'Ansatz: A(x) = x · (10 − 2x)', 'A\'(x) = 10 − 4x = 0 ⇒ x = 2.5', 'Stammfunktion: F\'(x) = f(x)'],
    intro: (topic) => `${topic}: Notizen aus der Lektion, Beispiele von Hand ergänzt.`,
  },
  {
    title: 'Physik', color: '#ef6c1a', paper: GRID,
    topics: ['Kinematik', 'Freier Fall', 'Newtonsche Gesetze', 'Energieerhaltung', 'Impuls', 'Praktikum Pendel'],
    notes: ['F = m · a', 'g = 9.81 m/s²', 'p = m · v', 'T = 2π · √(l/g)', 'Messung: T = 1.42 s', 'Δp = F · Δt'],
    intro: (topic) => `${topic}: Zusammenfassung und gelöste Aufgaben.`,
  },
  {
    title: 'Chemie', color: '#2f9e5b', paper: GRID,
    topics: ['Atombau', 'Periodensystem', 'Ionenbindung', 'Redoxreaktionen', 'Säuren und Basen', 'Praktikum Titration'],
    notes: ['Oxidation: Abgabe von Elektronen', 'Reduktion: Aufnahme von Elektronen', 'Na → Na⁺ + e⁻', 'Cl₂ + 2e⁻ → 2Cl⁻', 'pH = 7 neutral', 'HCl + NaOH → NaCl + H₂O'],
    intro: (topic) => `${topic}: Begriffe, Reaktionsgleichungen und Versuche.`,
  },
  {
    title: 'Deutsch', color: '#d13438', paper: LINED,
    topics: ['Kafka, Die Verwandlung', 'Erörterung', 'Lyrik der Romantik', 'Dürrenmatt, Der Besuch der alten Dame', 'Grammatik Konjunktiv', 'Aufsatz Feedback'],
    notes: ['These, Argument, Beispiel', 'Sehnsucht und Natur', 'Groteske, Tragikomödie', 'Konjunktiv I: indirekte Rede', 'Einleitung kürzer fassen!', 'Zitate belegen'],
    intro: (topic) => `${topic}: Notizen zur Lektüre und zur Diskussion in der Klasse.`,
  },
  {
    title: 'Geschichte', color: '#b08d57', paper: LINED,
    topics: ['Französische Revolution', 'Industrialisierung', 'Erster Weltkrieg', 'Kalter Krieg', 'Die Schweiz im 20. Jahrhundert', 'Quellenanalyse'],
    notes: ['1789 Sturm auf die Bastille', '1914 bis 1918', 'Mauerbau 1961', 'Kubakrise 1962', 'Neutralität und Landesversorgung', 'Wer schreibt, für wen, warum?'],
    intro: (topic) => `${topic}: Ursachen, Verlauf und Folgen in Stichworten.`,
  },
  {
    title: 'Informatik', color: '#7b4bb7', paper: GRID,
    topics: ['Algorithmen', 'Rekursion', 'Sortieren', 'Binärsystem', 'Python Grundlagen', 'Projekt Website'],
    notes: ['fak(n) = n · fak(n − 1)', 'Abbruch: fak(0) = 1', 'Bubblesort: O(n²)', '13 = 1101 im Binärsystem', 'for i in range(10):', 'Laufzeit messen!'],
    intro: (topic) => `${topic}: Konzepte und Beispiele aus dem Unterricht.`,
  },
  {
    title: 'Englisch', color: '#0f8b8d', paper: LINED,
    topics: ['Vocabulary Unit 3', 'Vocabulary Unit 4', 'Short Story Analysis', 'Grammar: Conditionals', 'Essay Writing', 'Lord of the Flies'],
    notes: ['to deny – leugnen', 'reluctant – widerwillig', 'If I had known, I would have', 'topic sentence first', 'the conch = order', 'Piggy, Ralph, Jack'],
    intro: (topic) => `${topic}: notes from class.`,
  },
];

/* ---------------------------------------------------------------- rich pages */

type Assets = (key: string) => AssetRef;

/** The page the clip opens on: theory, handwritten working, a figure and the worksheet. */
function curveSketchingPage(b: PageBuilder, asset: Assets): void {
  b.text({ x: 34, y: 14, width: 404, height: 128 }, [
    { h: 'Kurvendiskussion' },
    { p: ['Bei einer Kurvendiskussion untersuchen wir den Graphen einer Funktion Schritt für Schritt: Symmetrie, Nullstellen, Extrem- und Wendepunkte sowie das Verhalten im Unendlichen.'] },
    { p: [span('Beispiel: ', 'bold'), 'f(x) = x³ − 3x'] },
  ]);
  const top = 190;
  const gap = 27;
  b.write('Symmetrie: f(−x) = −f(x) → punktsymmetrisch', 36, top);
  b.write('Nullstellen: x(x² − 3) = 0 ⇒ x = 0, x = ±√3', 36, top + gap);
  b.write('f\'(x) = 3x² − 3        f\'\'(x) = 6x', 36, top + gap * 2);
  const marked = b.write('f\'(x) = 0 ⇒ x = ±1 → ', 36, top + gap * 3);
  const markedEnd = b.write('H(−1|2), T(1|−2)', marked, top + gap * 3);
  b.highlight(marked - 2, markedEnd + 2, top + gap * 3 - 5);

  // Worked area: integral, antiderivative in fractions, framed result.
  const black = { color: INK.black, size: 9.5 };
  const row1 = top + gap * 3 + 46;
  let x = b.write('A =', 36, row1, black);
  b.write('∫', x + 2, row1 + 2, { ...black, size: 13 });
  b.write('√3', x + 16, row1 - 25, { ...black, size: 6 });
  b.write('0', x + 4, row1 + 13, { ...black, size: 6 });
  b.write('(x³ − 3x) dx', x + 24, row1, black);
  const row2 = row1 + 46;
  x = b.write('= [', 52, row2, black);
  x = b.fraction('x⁴', '4', x + 2, row2, { color: INK.black });
  x = b.write('−', x, row2, black);
  x = b.fraction('3x²', '2', x + 2, row2, { color: INK.black });
  x = b.write(']', x, row2, black);
  b.write('√3', x, row2 - 19, { ...black, size: 6 });
  b.write('0', x, row2 + 8, { ...black, size: 6 });
  const row3 = row2 + 46;
  x = b.write('=', 52, row3, black);
  x = b.fraction('9', '4', x + 4, row3, { color: INK.black });
  x = b.write('−', x, row3, black);
  x = b.fraction('9', '2', x + 2, row3, { color: INK.black });
  x = b.write('=', x + 2, row3, black);
  const resultStart = x + 4;
  x = b.write('−', resultStart, row3, black);
  x = b.fraction('9', '4', x, row3, { color: INK.black });
  b.box(resultStart - 5, row3 - 25, x - resultStart + 8, 34, INK.red);
  b.write('|A| = 9/4 FE', x + 22, row3, { color: INK.red, size: 8.5 });

  // Sketch of f' beside the working: axes, the parabola and its zeros.
  const ox = 352;
  const oy = row2 - 6;
  b.arrow([292, oy], [436, oy], INK.black, 1.3);
  b.arrow([ox, row3 + 26], [ox, row1 - 30], INK.black, 1.3);
  const parabola: Point[] = [];
  for (let u = -1.65; u <= 1.65; u += 0.15) parabola.push([ox + u * 32, oy - (3 * u * u - 3) * 9.5]);
  b.ink([withPressure(spline(parabola, 1.4), b.random)], INK.blue, 1.7);
  for (const u of [-1, 1]) b.line([[ox + u * 32, oy - 4], [ox + u * 32, oy + 4]], INK.black, 1.2, 0.2);
  b.write('−1', ox - 44, oy + 15, { color: INK.black, size: 6 });
  b.write('1', ox + 30, oy + 15, { color: INK.black, size: 6 });
  b.write('x', 430, oy + 16, { color: INK.black, size: 7 });
  b.write('y', ox + 8, row1 - 22, { color: INK.black, size: 7 });
  b.write('f\'', ox + 50, oy - 50, { color: INK.blue, size: 8 });

  b.image(asset('figure-cubic'), { x: 466, y: 14, width: 276, height: 206 }, 'Graph von f(x) = x³ − 3x');
  b.printout(asset('worksheet-kurven'), asset('worksheet-kurven.pdf'), WORKSHEETS['worksheet-kurven'].pages, { x: 460, y: 236, width: 300, height: 424 });
}

function chainRulePage(b: PageBuilder): void {
  b.text({ x: 34, y: 14, width: 470, height: 120 }, [
    { h: 'Kettenregel' },
    { p: ['Für eine verkettete Funktion f(x) = u(v(x)) gilt:'] },
    { p: [span('f′(x) = u′(v(x)) · v′(x)', 'bold')] },
    { p: [span('Merksatz: ', 'italic'), 'äussere Ableitung mal innere Ableitung.'] },
  ]);
  b.highlight(34, 188, 87);
  const top = 172;
  const gap = 28;
  b.write('Beispiel 1: f(x) = (2x + 1)³', 36, top);
  b.write('innere: v(x) = 2x + 1, v\'(x) = 2', 56, top + gap);
  b.write('äussere: u(v) = v³, u\'(v) = 3v²', 56, top + gap * 2);
  const result = b.write('f\'(x) = 3(2x + 1)² · 2 = 6(2x + 1)²', 56, top + gap * 3);
  b.box(52, top + gap * 3 - 20, result - 48, 28, INK.red);
  b.write('Beispiel 2: g(x) = sin(x²)', 36, top + gap * 5);
  b.write('g\'(x) = cos(x²) · 2x', 56, top + gap * 6, { color: INK.black });
  // Little chain diagram beside the first example: x → v → u.
  const y = top + gap;
  const purple = { color: INK.purple, size: 9 };
  b.write('x', 330, y, purple);
  b.arrow([346, y - 5], [392, y - 5], INK.purple, 1.4);
  b.write('v', 364, y - 13, { ...purple, size: 7 });
  b.write('2x + 1', 400, y, purple);
  b.arrow([460, y - 5], [506, y - 5], INK.purple, 1.4);
  b.write('u', 478, y - 13, { ...purple, size: 7 });
  b.write('(2x + 1)³', 514, y, purple);
}

/** Hand-drawn axes with arrows and their labels around `origin`. */
function sketchAxes(b: PageBuilder, origin: Point, size: { left: number; right: number; up: number; down: number }, labels: [string, string]): void {
  const [ox, oy] = origin;
  b.arrow([ox - size.left, oy], [ox + size.right, oy], INK.black, 1.3);
  b.arrow([ox, oy + size.down], [ox, oy - size.up], INK.black, 1.3);
  b.write(labels[0], ox + size.right - 8, oy + 16, { color: INK.black, size: 7 });
  b.write(labels[1], ox + 8, oy - size.up + 8, { color: INK.black, size: 7 });
}

function curve(b: PageBuilder, f: (u: number) => number, from: number, to: number, place: (u: number, v: number) => Point, color: string, size = 1.7): void {
  const points: Point[] = [];
  for (let step = 0; step <= 24; step += 1) {
    const u = from + ((to - from) * step) / 24;
    points.push(place(u, f(u)));
  }
  b.ink([withPressure(spline(points, 1.4), b.random)], color, size);
}

// The pages the clip switches to carry no pictures: a picture on a page
// that just opened is decoded a frame or two after its ink and text.
function derivativesPage(b: PageBuilder): void {
  b.text({ x: 34, y: 14, width: 400, height: 300 }, [
    { h: 'Ableitungsregeln' },
    { p: ['Die Ableitung f′(x) gibt die Steigung der Tangente im Punkt (x | f(x)) an.'] },
    { table: [['Funktion f(x)', 'Ableitung f′(x)'], ['c', '0'], ['xⁿ', 'n · xⁿ⁻¹'], ['sin x', 'cos x'], ['cos x', '−sin x'], ['eˣ', 'eˣ'], ['ln x', '1/x']] },
  ]);
  // Secant and tangent at P, drawn by hand.
  const origin: Point = [500, 200];
  const place = (u: number, v: number): Point => [origin[0] + u * 70, origin[1] - v * 34];
  sketchAxes(b, origin, { left: 24, right: 236, up: 170, down: 16 }, ['x', 'y']);
  curve(b, (u) => 0.5 * u * u, -0.3, 2.9, place, INK.blue, 1.8);
  curve(b, (u) => u - 0.5, 0.2, 3.2, place, INK.red, 1.5);
  curve(b, (u) => 0.5 + 1.75 * (u - 1), 0.55, 2.85, place, INK.green, 1.5);
  for (const [u, label] of [[1, 'P'], [2.5, 'Q']] as const) {
    const [x, y] = place(u, 0.5 * u * u);
    b.ink([withPressure(spline([[x - 2.5, y], [x, y - 2.5], [x + 2.5, y], [x, y + 2.5], [x - 2.5, y]], 0.8), b.random)], INK.black, 2.2);
    b.write(label, x + 8, y + 14, { color: INK.black, size: 7 });
  }
  b.write('Tangente', 676, 152, { color: INK.red, size: 7.5 });
  b.write('Sekante', 600, 84, { color: INK.green, size: 7.5 });
  b.write('f(x) = 4x³ − 2x + 7  ⇒  f\'(x) = 12x² − 2', 466, 262, { color: INK.black });
  b.write('f(x) = 5 · eˣ  ⇒  f\'(x) = 5 · eˣ', 466, 290, { color: INK.black });
  const top = 384;
  b.write('Differenzenquotient → Differentialquotient', 36, top);
  b.write('m = (f(x + h) − f(x)) / h', 36, top + 28, { color: INK.black });
  b.write('h → 0: Sekante wird zur Tangente', 36, top + 56);
}

function kinematicsPage(b: PageBuilder): void {
  b.text({ x: 34, y: 14, width: 420, height: 170 }, [
    { h: 'Kinematik' },
    { p: ['Die Kinematik beschreibt Bewegungen, ohne nach ihren Ursachen zu fragen.'] },
    { p: ['Geschwindigkeit: v = Δs / Δt'], list: 'bullet' },
    { p: ['Beschleunigung: a = Δv / Δt'], list: 'bullet' },
    { p: ['Weg bei konstanter Beschleunigung: s = ½ · a · t²'], list: 'bullet' },
  ]);
  // s-t sketch of the accelerated start, top right.
  const st: Point = [520, 170];
  sketchAxes(b, st, { left: 14, right: 210, up: 140, down: 12 }, ['t', 's']);
  curve(b, (u) => u * u, 0, 1.9, (u, v) => [st[0] + u * 95, st[1] - v * 34], INK.blue, 1.8);
  b.write('s = ½ · a · t²', 548, 72, { color: INK.blue });
  b.write('Parabel!', 640, 150, { color: INK.green, size: 7.5 });
  // v-t diagram sketched by hand.
  const ox = 70;
  const oy = 380;
  b.arrow([ox - 10, oy], [330, oy], INK.black, 1.4);
  b.arrow([ox, oy + 10], [ox, 222], INK.black, 1.4);
  b.line([[ox, oy], [180, 262], [300, 262]], INK.blue, 1.9, 0.5);
  b.line([[180, 262], [180, oy]], INK.black, 1, 0.3);
  b.write('t', 320, oy + 16, { color: INK.black, size: 8 });
  b.write('v', ox - 22, 236, { color: INK.black, size: 8 });
  b.write('beschleunigt', 96, 374, { color: INK.green, size: 6.5 });
  b.write('konstant', 214, 254, { color: INK.green, size: 7.5 });
  b.write('Fläche unter v(t) = Weg s', 360, 300, { color: INK.red });
  b.arrow([356, 296], [250, 330], INK.red, 1.4);
  b.write('Bsp: a = 2 m/s², t = 4 s', 360, 360);
  b.write('s = ½ · 2 · 4² = 16 m', 360, 388, { color: INK.black });
}

function energyPage(b: PageBuilder): void {
  b.text({ x: 34, y: 14, width: 404, height: 140 }, [
    { h: 'Energieerhaltung' },
    { p: ['In einem abgeschlossenen System bleibt die Gesamtenergie erhalten. Beim freien Fall wird Lageenergie in Bewegungsenergie umgewandelt.'] },
    { p: [span('Epot + Ekin = konstant', 'bold')] },
  ]);
  b.highlight(36, 210, 127, HIGHLIGHT.green);
  const top = 190;
  b.write('m · g · h = ½ · m · v²', 36, top, { color: INK.black });
  b.write('⇒ v = √(2 · g · h)', 36, top + 30, { color: INK.black });
  b.write('Aufgabe 1: h = 5 m', 36, top + 72);
  const end = b.write('v = √(2 · 9.81 · 5) ≈ 9.9 m/s', 36, top + 100);
  b.box(30, top + 80, end - 22, 28, INK.red);
  b.write('Aufgabe 2: v₀ = 3 m/s, h = 2 m', 36, top + 150);
  b.write('½ · v₀² + g · h = ½ · v²', 36, top + 178, { color: INK.black });
  const end2 = b.write('v = √(3² + 2 · 9.81 · 2) ≈ 7.0 m/s', 36, top + 206);
  b.box(30, top + 186, end2 - 22, 28, INK.red);
  // Ball dropping beside the working.
  b.line([[470, 360], [620, 360]], INK.black, 1.4);
  for (let x = 476; x < 620; x += 14) b.line([[x + 8, 362], [x, 372]], INK.black, 1.1, 0.2);
  const ball: Point[] = Array.from({ length: 13 }, (_, step) => [540 + Math.cos((step / 12) * Math.PI * 2) * 11, 70 + Math.sin((step / 12) * Math.PI * 2) * 11]);
  b.ink([withPressure(spline(ball, 1), b.random)], INK.blue, 1.6);
  b.arrow([540, 88], [540, 352], INK.blue, 1.3);
  b.write('h = 5 m', 552, 230, { color: INK.blue, size: 8 });
  b.write('Epot = max', 580, 74, { color: INK.green, size: 7.5 });
  b.write('Ekin = max', 580, 340, { color: INK.green, size: 7.5 });
}

function kafkaPage(b: PageBuilder): void {
  b.text({ x: 34, y: 14, width: 440, height: 260 }, [
    { h: 'Franz Kafka: Die Verwandlung (1915)' },
    { p: [span('«Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt.»', 'italic')] },
    { p: ['Der erste Satz nennt das Unerhörte ohne jede Vorbereitung. Erzählt wird personal aus Gregors Sicht; die Familie reagiert zuerst mit Entsetzen, dann mit Kälte.'] },
    { p: ['Erzählperspektive und Erzählhaltung'], list: 'bullet' },
    { p: ['Motive: Käfer, Zimmer, Apfel'], list: 'bullet' },
    { p: ['Rolle der Schwester Grete'], list: 'bullet' },
  ]);
  b.highlight(292, 466, 127, HIGHLIGHT.pink);
  b.highlight(356, 443, 83, HIGHLIGHT.yellow);
  b.highlight(40, 116, 103, HIGHLIGHT.yellow);
  b.write('Pointe gleich am Anfang!', 506, 70, { color: INK.red });
  b.arrow([502, 66], [446, 120], INK.red, 1.3);
  b.write('kein Traum, Realität', 506, 98, { color: INK.red });
  b.write('Entfremdung', 506, 150, { color: INK.red });
  b.write('Familie ↔ Beruf', 506, 178, { color: INK.red });
  b.write('Gregor = Opfer der Familie?', 36, 318);
  b.write('Vergleich mit Dürrenmatt: Groteske', 36, 346);
  b.write('Aufsatz bis Freitag, 2 Seiten', 36, 374, { color: INK.green });
}

/** Any other page of a section: its topic typed out and a few handwritten lines. */
function notesPage(b: PageBuilder, subject: Subject, topic: string, index: number): void {
  b.text({ x: 34, y: 14, width: 520, height: 90 }, [{ h: topic }, { p: [subject.intro(topic)] }]);
  const lines = 3 + (index % 3);
  for (let line = 0; line < lines; line += 1) {
    b.write(subject.notes[(index + line) % subject.notes.length], 36, 140 + line * 28, { color: line % 3 === 2 ? INK.black : INK.blue });
  }
}

/* ----------------------------------------------------------------- notebooks */

export interface SchoolSection {
  id: string;
  title: string;
  color: string;
  pages: PageDocV3[];
}

/** Lesson start times (UTC; Zurich is two hours ahead in late summer). */
const LESSONS: Array<[number, number]> = [[5, 45], [6, 35], [7, 40], [8, 30], [11, 15], [12, 5]];

/** The `schoolDay`th school day from Monday 17 August 2026, at one of the lesson times. */
function lessonTime(schoolDay: number, lesson: number): string {
  const week = Math.floor(schoolDay / 5);
  const [hour, minute] = LESSONS[lesson % LESSONS.length];
  return new Date(Date.UTC(2026, 7, 17 + week * 7 + (schoolDay % 5), hour, minute)).toISOString();
}

/** Page of the clip's first frame. */
export const SCHOOL_START_PAGE = 'schule-analysis-5';

/**
 * The notebook "Schule 2026/27": one section per subject, its pages dated
 * across the first school weeks. `asset` resolves the keys of
 * `schoolPictures()` and `<worksheet>.pdf` to stored assets.
 */
export function schoolSections(notebookId: string, asset: Assets): SchoolSection[] {
  return SUBJECTS.map((subject, subjectIndex) => {
    const sectionKey = subject.title.toLowerCase();
    const pages = subject.topics.map((topic, index): PageDocV3 => {
      const pageId = `schule-${sectionKey}-${index + 1}`;
      const time = lessonTime(index * 4 + subjectIndex, subjectIndex + index);
      const b = new PageBuilder(pageId, time, 0x51ce + subjectIndex * 97 + index * 13);
      const title = `${subject.title} – ${topic}`;
      if (topic === 'Kurvendiskussion') curveSketchingPage(b, asset);
      else if (topic === 'Kettenregel') chainRulePage(b);
      else if (topic === 'Ableitungen') derivativesPage(b);
      else if (topic === 'Kinematik') kinematicsPage(b);
      else if (topic === 'Energieerhaltung') energyPage(b);
      else if (topic === 'Kafka, Die Verwandlung') kafkaPage(b);
      else notesPage(b, subject, topic, index);
      return {
        schemaVersion: 3, documentId: `page:${pageId}`, kind: 'page', notebookId, sectionId: `schule-${sectionKey}`, pageId,
        title, tags: [], pageType: 'a4', background: subject.paper, createdAt: time, updatedAt: time,
        elementsById: b.elementsById, zOrder: b.zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
        pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
      };
    });
    return { id: `schule-${sectionKey}`, title: subject.title, color: subject.color, pages };
  });
}
