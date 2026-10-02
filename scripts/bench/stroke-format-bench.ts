/**
 * Measures how the storage form of ink strokes (`points` list against
 * `packed` byte string, see src/crdt/strokeStorage.ts) affects a page with
 * bm's worst page shape: about 7,000 handwriting strokes of ten samples.
 *
 *   pnpm exec vite build --config scripts/bench/vite.stroke-bench.config.mjs
 *   node --expose-gc node_modules/.cache/canvink-stroke-bench/stroke-format-bench.js \
 *     --strokes 7000 --points 10 --runs 5
 *
 * Phases run in fresh child processes, so the peak resident memory of each
 * one is its own:
 *
 * - create: build the Automerge page document from a portable page, the way
 *   an import applies a page, and save it;
 * - open: load the saved bytes and materialise the first snapshot, the way
 *   opening the page does;
 * - edit: add one stroke, move 100 strokes, and take the snapshot after each,
 *   with the size of the Automerge change each one produces;
 * - sync: send the whole page to a peer that has nothing, then a single
 *   stroke change to a peer that has the page.
 *
 * `--phases create,open` limits the phases. `--variants` adds two ceilings that are not in the app, to show where the
 * remaining Automerge operations of a packed page come from (each stroke's
 * string fields and the z-order ids are Automerge text objects with one
 * operation per character): `packed-immutable` stores those strings as
 * immutable scalar strings, `blob` stores every stroke as one byte string.
 * Their rows use plain Automerge load and toJS only, as no app reader
 * understands them.
 *
 * Two data shapes: `import` (double-precision coordinates, constant pressure,
 * no tilt or time, as OneNote import writes them) and `pen` (a live pen:
 * varying pressure, tilt in whole degrees, timestamps).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as Automerge from '@automerge/automerge';
import {
  changePageDocument,
  createPageAutomergeDocV3,
  getAutomergeSnapshot,
  loadAutomergeDocument,
  saveAutomergeDocument,
} from '../../src/crdt/document';
import { getSharedAutomergeSnapshot } from '../../src/crdt/sharedSnapshot';
import { packStrokePoints } from '../../src/crdt/packedStrokePoints';
import type { StrokeStorageFormat } from '../../src/crdt/strokeStorage';
import type { PageAutomergeDoc } from '../../src/crdt/types';
import type { StrokeElementV2, StrokePointV2 } from '../../src/domain/v2/types';
import { DEFAULT_MATH_PAGE_SETTINGS, type PageDocV3 } from '../../src/domain/v3/types';
import { applyPageElementChanges } from '../../src/editor/pageChanges';
import { pendingInk } from '../../src/ink/pendingInk';
import type { PlainInkPage } from '../../src/ink/projection';
import { compactPageInk, sealPendingInk, sealProjection, type InkPageTarget } from '../../src/ink/seal';
import { sharedPlainSnapshot } from '../../src/crdt/sharedSnapshot';
import { MemorySegmentBackend, resetInkSegments } from '../../src/ink/segmentStore';

type Scenario = 'import' | 'pen';
type Variant = StrokeStorageFormat | 'packed-immutable' | 'blob' | 'segments';
type Phase = 'create' | 'open' | 'edit' | 'sync' | 'live';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const strokeCount = Number(arg('strokes', '7000'));
const pointsPerStroke = Number(arg('points', '10'));
const runs = Number(arg('runs', '5'));
const workDir = arg('dir', join(tmpdir(), 'canvink-stroke-bench'));
const TIME = '2026-09-25T08:00:00.000Z';
const ACTOR = 'a'.repeat(64);

let seed = 0x2f6b_1a3d;
const random = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
};

function strokePoints(scenario: Scenario, column: number, row: number): StrokePointV2[] {
  const x0 = 40 + column * 22 + random();
  const y0 = 200 + row * 18 + random();
  const start = 1_234_567 + (row * 30 + column) * 90 + random();
  return Array.from({ length: pointsPerStroke }, (_, index) => ({
    x: x0 + index * 1.8 + random() * 0.9,
    y: y0 + Math.sin(index / 2) * 4 + random() * 0.9,
    pressure: scenario === 'import' ? 0.5 : 0.25 + random() * 0.6,
    tiltX: scenario === 'import' ? 0 : Math.round(random() * 30 - 15),
    tiltY: scenario === 'import' ? 0 : Math.round(random() * 30 - 15),
    time: scenario === 'import' ? 0 : start + index * 8 + random(),
    pointerType: 'pen',
  }));
}

function stroke(scenario: Scenario, id: string, column: number, row: number): StrokeElementV2 {
  const points = strokePoints(scenario, column, row);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    id, kind: 'stroke',
    frame: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#1b1b8f', size: 1.5, opacity: 1, points,
  };
}

function portablePage(scenario: Scenario): PageDocV3 {
  seed = 0x2f6b_1a3d;
  const elementsById: PageDocV3['elementsById'] = {};
  const zOrder: string[] = [];
  for (let index = 0; index < strokeCount; index += 1) {
    const id = `page-s${index}`;
    elementsById[id] = stroke(scenario, id, index % 30, Math.floor(index / 30));
    zOrder.push(id);
  }
  return {
    schemaVersion: 3, documentId: 'page:bench', kind: 'page', notebookId: 'bm', sectionId: 'section', pageId: 'bench',
    title: 'Algebra schwer', tags: [], pageType: 'free',
    background: { type: 'grid', color: '#ffffff', spacing: 16, lineColor: '#caebfd' }, createdAt: TIME, updatedAt: TIME,
    elementsById, zOrder, mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
    pageContent: { version: 1, kind: 'canvas' }, version: { protocol: 'uninitialized', heads: [] },
  };
}

const gc = (): void => { (globalThis as { gc?: () => void }).gc?.(); };
const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024 * 10) / 10;
const now = (): number => performance.now();
const peakRssMb = (): number => mb(process.resourceUsage().maxRSS * 1024);
function heapMb(): number {
  gc();
  const usage = process.memoryUsage();
  return mb(usage.heapUsed + usage.external);
}
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const path = (scenario: Scenario, format: Variant): string => join(workDir, `${scenario}-${format}.bin`);
const round = (value: number): number => Math.round(value * 100) / 100;
/** User and system CPU time since `since`, which is less sensitive to a busy machine than wall time. */
const cpuMsSince = (since: NodeJS.CpuUsage): number => {
  const used = process.cpuUsage(since);
  return (used.user + used.system) / 1000;
};

const encoder = new TextEncoder();

/** The page as plain Automerge content for the two ceiling variants. */
function ceilingContent(page: PageDocV3, variant: 'packed-immutable' | 'blob'): Record<string, unknown> {
  const text = (value: string): unknown => (variant === 'packed-immutable' ? new Automerge.ImmutableString(value) : value);
  const elementsById: Record<string, unknown> = {};
  for (const [id, element] of Object.entries(page.elementsById)) {
    if (element.kind !== 'stroke') continue;
    const packed = packStrokePoints(element.points);
    if (!packed) throw new Error('The bench strokes must be packable.');
    if (variant === 'blob') {
      const { points: _points, ...metadata } = element;
      void _points;
      const header = encoder.encode(JSON.stringify(metadata));
      const bytes = new Uint8Array(4 + header.length + packed.length);
      new DataView(bytes.buffer).setUint32(0, header.length);
      bytes.set(header, 4);
      bytes.set(packed, 4 + header.length);
      elementsById[id] = bytes;
    } else {
      const { points: _points, ...rest } = element;
      void _points;
      elementsById[id] = {
        ...rest, id: text(id), kind: text(rest.kind), tool: text(rest.tool), color: text(rest.color),
        createdAt: text(rest.createdAt), updatedAt: text(rest.updatedAt), packedPoints: packed,
      };
    }
  }
  return { elementsById, zOrder: page.zOrder.map(text) };
}

function phaseCreateCeiling(scenario: Scenario, variant: 'packed-immutable' | 'blob'): Record<string, number> {
  const content = ceilingContent(portablePage(scenario), variant);
  gc();
  const heapBefore = heapMb();
  const started = now();
  // One change that assigns the whole content to the root, as createAutomergeDocument does.
  const document = Automerge.change(Automerge.init<Record<string, unknown>>(), (draft) => {
    Object.assign(draft, content);
  });
  const createMs = now() - started;
  const savedAt = now();
  const bytes = Automerge.save(document);
  const saveMs = now() - savedAt;
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path(scenario, variant), bytes);
  return {
    createMs, saveMs, docBytes: bytes.length, gzipBytes: gzipSync(bytes).length, ops: Automerge.stats(document).numOps,
    peakRssMb: peakRssMb(), heapGrowthMb: round(heapMb() - heapBefore),
  };
}

function phaseOpenCeiling(scenario: Scenario, variant: Variant): Record<string, number> {
  const bytes = new Uint8Array(readFileSync(path(scenario, variant)));
  gc();
  const heapBefore = heapMb();
  const loadedAt = now();
  const cpuStart = process.cpuUsage();
  const document = Automerge.load<Record<string, unknown>>(bytes);
  const loadMs = now() - loadedAt;
  const toJsAt = now();
  Automerge.toJS(document);
  const toJsMs = now() - toJsAt;
  const openCpuMs = cpuMsSince(cpuStart);
  return { loadMs, toJsMs, openMs: loadMs + toJsMs, openCpuMs, peakRssMb: peakRssMb(), heapGrowthMb: round(heapMb() - heapBefore) };
}

function phaseCreate(scenario: Scenario, format: StrokeStorageFormat): Record<string, number> {
  const page = portablePage(scenario);
  gc();
  const heapBefore = heapMb();
  const started = now();
  const cpuStart = process.cpuUsage();
  const document = createPageAutomergeDocV3(page, { actorId: ACTOR, strokeFormat: format });
  const createMs = now() - started;
  const createCpuMs = cpuMsSince(cpuStart);
  const savedAt = now();
  const bytes = saveAutomergeDocument(document);
  const saveMs = now() - savedAt;
  const ops = Automerge.stats(document).numOps;
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path(scenario, format), bytes);
  return {
    createMs, createCpuMs, saveMs, docBytes: bytes.length, gzipBytes: gzipSync(bytes).length, ops,
    peakRssMb: peakRssMb(), heapGrowthMb: round(heapMb() - heapBefore),
  };
}

function phaseOpen(scenario: Scenario, format: StrokeStorageFormat): Record<string, number> {
  const bytes = new Uint8Array(readFileSync(path(scenario, format)));
  gc();
  const heapBefore = heapMb();
  const loadedAt = now();
  const cpuStart = process.cpuUsage();
  const document = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  const loadMs = now() - loadedAt;
  const sharedAt = now();
  const snapshot = getSharedAutomergeSnapshot(document);
  const sharedMs = now() - sharedAt;
  const openCpuMs = cpuMsSince(cpuStart);
  const elements = Object.keys(snapshot.elementsById).length;
  const toJsAt = now();
  getAutomergeSnapshot(document);
  const toJsMs = now() - toJsAt;
  if (elements !== strokeCount) throw new Error(`Expected ${strokeCount} strokes, found ${elements}.`);
  const result = { loadMs, firstSnapshotMs: sharedMs, toJsMs, openMs: loadMs + sharedMs, openCpuMs, peakRssMb: peakRssMb(), heapGrowthMb: round(heapMb() - heapBefore) };
  // Plain Automerge load and toJS of the same bytes, comparable with the ceiling rows.
  const rawLoadedAt = now();
  const raw = Automerge.load<Record<string, unknown>>(bytes);
  const rawLoadMs = now() - rawLoadedAt;
  const rawToJsAt = now();
  Automerge.toJS(raw);
  return { ...result, rawLoadMs, rawToJsMs: now() - rawToJsAt };
}

function phaseEdit(scenario: Scenario, format: StrokeStorageFormat): Record<string, number> {
  const bytes = new Uint8Array(readFileSync(path(scenario, format)));
  let document = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  let snapshot = getSharedAutomergeSnapshot(document);
  const addMs: number[] = [];
  const addSnapshotMs: number[] = [];
  const addBytes: number[] = [];
  seed = 0x51ed_270b;
  for (let index = 0; index < 20; index += 1) {
    const id = `added-${index}`;
    const added = stroke(scenario, id, index, 300);
    const before = snapshot.elementsById as Record<string, never>;
    const order = snapshot.zOrder;
    const started = now();
    document = changePageDocument(document, { message: 'Draw ink stroke' }, (draft) => {
      applyPageElementChanges(draft, { upserts: [added] }, before, TIME, order, format);
    });
    addMs.push(now() - started);
    const change = Automerge.getLastLocalChange(document);
    addBytes.push(change?.length ?? 0);
    const snapshotAt = now();
    snapshot = getSharedAutomergeSnapshot(document);
    addSnapshotMs.push(now() - snapshotAt);
  }

  // A lasso move of 100 strokes: every point of each moved stroke changes.
  const ids = Object.keys(snapshot.elementsById).slice(1000, 1100);
  const moved = ids.map((id): StrokeElementV2 => {
    const element = snapshot.elementsById[id] as StrokeElementV2;
    return {
      ...element,
      frame: { ...element.frame, x: element.frame.x + 13.37, y: element.frame.y + 5.11 },
      points: element.points.map((point) => ({ ...point, x: point.x + 13.37, y: point.y + 5.11 })),
    };
  });
  const before = snapshot.elementsById as Record<string, never>;
  const moveStart = now();
  document = changePageDocument(document, { message: 'Move selection' }, (draft) => {
    applyPageElementChanges(draft, { upserts: moved }, before, TIME, snapshot.zOrder, format);
  });
  const moveMs = now() - moveStart;
  const moveBytes = Automerge.getLastLocalChange(document)?.length ?? 0;
  const moveSnapshotAt = now();
  getSharedAutomergeSnapshot(document);
  const moveSnapshotMs = now() - moveSnapshotAt;
  return {
    addStrokeMs: median(addMs), addStrokeSnapshotMs: median(addSnapshotMs), addStrokeChangeBytes: median(addBytes),
    move100Ms: moveMs, move100SnapshotMs: moveSnapshotMs, move100ChangeBytes: moveBytes,
  };
}

function phaseSync(scenario: Scenario, format: StrokeStorageFormat): Record<string, number> {
  const bytes = new Uint8Array(readFileSync(path(scenario, format)));
  const source = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  let sender = Automerge.clone(source);
  let receiver: Automerge.Doc<unknown> = Automerge.init();
  let senderState = Automerge.initSyncState();
  let receiverState = Automerge.initSyncState();
  let total = 0;
  let messages = 0;
  const started = now();
  for (let round = 0; round < 50; round += 1) {
    const [nextSenderState, toReceiver] = Automerge.generateSyncMessage(sender, senderState);
    senderState = nextSenderState;
    if (toReceiver) {
      total += toReceiver.length;
      messages += 1;
      [receiver, receiverState] = Automerge.receiveSyncMessage(receiver, receiverState, toReceiver);
    }
    const [nextReceiverState, toSender] = Automerge.generateSyncMessage(receiver, receiverState);
    receiverState = nextReceiverState;
    if (toSender) {
      total += toSender.length;
      messages += 1;
      [sender, senderState] = Automerge.receiveSyncMessage(sender, senderState, toSender);
    }
    if (!toReceiver && !toSender) break;
  }
  const fullSyncMs = now() - started;

  const snapshot = getSharedAutomergeSnapshot(sender as PageAutomergeDoc);
  const added = stroke(scenario, 'synced-stroke', 5, 301);
  const changed = changePageDocument(sender as PageAutomergeDoc, { message: 'Draw ink stroke' }, (draft) => {
    applyPageElementChanges(draft, { upserts: [added] }, snapshot.elementsById as Record<string, never>, TIME, snapshot.zOrder, format);
  });
  const change = Automerge.getLastLocalChange(changed);
  if (!change) throw new Error('No change was produced.');
  const applyAt = now();
  Automerge.applyChanges(receiver, [change]);
  const applyMs = now() - applyAt;
  return { fullSyncBytes: total, fullSyncMessages: messages, fullSyncMs, oneStrokeApplyMs: applyMs, oneStrokeSyncBytes: change.length };
}

/**
 * The `segments` variant: the page's ink lives in immutable segments outside
 * the document (src/ink). Rows count the document and the segments together
 * where the whole page has to travel (sync).
 */
function segmentPath(scenario: Scenario): string {
  return join(workDir, `${scenario}-segments.seg`);
}

function writeSegments(scenario: Scenario, backend: MemorySegmentBackend): number {
  const parts: Buffer[] = [];
  let total = 0;
  for (const [hash, bytes] of backend.blobs) {
    const header = Buffer.from(hash, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    parts.push(header, length, Buffer.from(bytes));
    total += bytes.length;
  }
  writeFileSync(segmentPath(scenario), Buffer.concat(parts));
  return total;
}

function readSegments(scenario: Scenario): Map<string, Uint8Array> {
  const file = readFileSync(segmentPath(scenario));
  const blobs = new Map<string, Uint8Array>();
  for (let offset = 0; offset < file.length;) {
    const hash = file.subarray(offset, offset + 64).toString('utf8');
    const length = file.readUInt32LE(offset + 64);
    blobs.set(hash, new Uint8Array(file.subarray(offset + 68, offset + 68 + length)));
    offset += 68 + length;
  }
  return blobs;
}

async function residentStore(scenario: Scenario): Promise<{ store: ReturnType<typeof resetInkSegments>; loadMs: number }> {
  const backend = new MemorySegmentBackend();
  for (const [hash, bytes] of readSegments(scenario)) backend.blobs.set(hash, bytes);
  const store = resetInkSegments(backend);
  const startedAt = now();
  const missing = await store.ensure(backend.blobs.keys());
  if (missing.length > 0) throw new Error('A segment could not be read.');
  return { store, loadMs: now() - startedAt };
}

async function phaseCreateSegments(scenario: Scenario): Promise<Record<string, number>> {
  const page = portablePage(scenario);
  const backend = new MemorySegmentBackend();
  const store = resetInkSegments(backend);
  gc();
  const heapBefore = heapMb();
  const started = now();
  const cpuStart = process.cpuUsage();
  const prepared = await sealProjection(page as unknown as PlainInkPage, store);
  const sealMs = now() - started;
  const document = createPageAutomergeDocV3(prepared as unknown as PageDocV3, { actorId: ACTOR });
  const createMs = now() - started;
  const createCpuMs = cpuMsSince(cpuStart);
  const savedAt = now();
  const bytes = saveAutomergeDocument(document);
  const saveMs = now() - savedAt;
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path(scenario, 'segments'), bytes);
  const segmentBytes = writeSegments(scenario, backend);
  return {
    createMs, createCpuMs, sealMs, saveMs, docBytes: bytes.length, gzipBytes: gzipSync(bytes).length,
    segmentBytes, segments: backend.blobs.size, ops: Automerge.stats(document).numOps,
    peakRssMb: peakRssMb(), heapGrowthMb: round(heapMb() - heapBefore),
  };
}

async function phaseOpenSegments(scenario: Scenario): Promise<Record<string, number>> {
  const bytes = new Uint8Array(readFileSync(path(scenario, 'segments')));
  gc();
  const heapBefore = heapMb();
  const cpuStart = process.cpuUsage();
  const loadedAt = now();
  const document = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  const loadMs = now() - loadedAt;
  const { loadMs: segmentMs } = await residentStore(scenario);
  const sharedAt = now();
  const snapshot = getSharedAutomergeSnapshot(document);
  const sharedMs = now() - sharedAt;
  const openCpuMs = cpuMsSince(cpuStart);
  const elements = Object.keys(snapshot.elementsById).length;
  if (elements !== strokeCount) throw new Error(`Expected ${strokeCount} strokes, found ${elements}.`);
  return {
    loadMs, segmentLoadMs: segmentMs, firstSnapshotMs: sharedMs, openMs: loadMs + segmentMs + sharedMs, openCpuMs,
    peakRssMb: peakRssMb(), heapGrowthMb: round(heapMb() - heapBefore),
  };
}

async function phaseEditSegments(scenario: Scenario): Promise<Record<string, number>> {
  const bytes = new Uint8Array(readFileSync(path(scenario, 'segments')));
  const { store } = await residentStore(scenario);
  pendingInk().reset();
  let document = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  let snapshot = getSharedAutomergeSnapshot(document);
  const documentId = document.documentId;
  const addMs: number[] = [];
  const addSnapshotMs: number[] = [];
  seed = 0x51ed_270b;
  const headsBefore = Automerge.getHeads(document).join();
  for (let index = 0; index < 20; index += 1) {
    const added = stroke(scenario, `added-${index}`, index, 300);
    const before = snapshot.elementsById as Record<string, never>;
    const order = snapshot.zOrder;
    const started = now();
    document = changePageDocument(document, { message: 'Draw ink stroke' }, (draft) => {
      applyPageElementChanges(draft, { upserts: [added] }, before, TIME, order, undefined, { holdNewInk: true });
    });
    addMs.push(now() - started);
    const snapshotAt = now();
    snapshot = getSharedAutomergeSnapshot(document);
    addSnapshotMs.push(now() - snapshotAt);
  }
  const documentUntouched = Automerge.getHeads(document).join() === headsBefore;

  const sealAt = now();
  const opsBefore = Automerge.stats(document).numOps;
  let holder = document;
  const sealed = await sealPendingInk({
    change: (message, change) => {
      holder = Automerge.change(holder, { message }, (draft) => change(draft as never));
      return true;
    },
  }, documentId, store, pendingInk());
  const sealMs = now() - sealAt;
  const sealChangeBytes = Automerge.getLastLocalChange(holder)?.length ?? 0;
  document = holder;
  const sealOps = Automerge.stats(document).numOps - opsBefore;
  snapshot = getSharedAutomergeSnapshot(document);

  // A lasso move of 100 strokes writes each of them as an element that replaces its segment copy.
  const ids = Object.keys(snapshot.elementsById).slice(1000, 1100);
  const moved = ids.map((id): StrokeElementV2 => {
    const element = snapshot.elementsById[id] as StrokeElementV2;
    return {
      ...element,
      frame: { ...element.frame, x: element.frame.x + 13.37, y: element.frame.y + 5.11 },
      points: element.points.map((point) => ({ ...point, x: point.x + 13.37, y: point.y + 5.11 })),
    };
  });
  const before = snapshot.elementsById as Record<string, never>;
  const moveStart = now();
  document = changePageDocument(document, { message: 'Move selection' }, (draft) => {
    applyPageElementChanges(draft, { upserts: moved }, before, TIME, snapshot.zOrder, undefined, { holdNewInk: true });
  });
  const moveMs = now() - moveStart;
  const moveBytes = Automerge.getLastLocalChange(document)?.length ?? 0;
  const moveSnapshotAt = now();
  getSharedAutomergeSnapshot(document);
  return {
    addStrokeMs: median(addMs), addStrokeSnapshotMs: median(addSnapshotMs), addStrokeChangeBytes: documentUntouched ? 0 : -1,
    sealMs, sealedStrokes: sealed, sealChangeBytes, sealOps,
    move100Ms: moveMs, move100SnapshotMs: now() - moveSnapshotAt, move100ChangeBytes: moveBytes,
  };
}

async function phaseSyncSegments(scenario: Scenario): Promise<Record<string, number>> {
  const bytes = new Uint8Array(readFileSync(path(scenario, 'segments')));
  const source = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  let sender = Automerge.clone(source);
  let receiver: Automerge.Doc<unknown> = Automerge.init();
  let senderState = Automerge.initSyncState();
  let receiverState = Automerge.initSyncState();
  let total = 0;
  let messages = 0;
  const started = now();
  for (let round = 0; round < 50; round += 1) {
    const [nextSenderState, toReceiver] = Automerge.generateSyncMessage(sender, senderState);
    senderState = nextSenderState;
    if (toReceiver) {
      total += toReceiver.length;
      messages += 1;
      [receiver, receiverState] = Automerge.receiveSyncMessage(receiver, receiverState, toReceiver);
    }
    const [nextReceiverState, toSender] = Automerge.generateSyncMessage(receiver, receiverState);
    receiverState = nextReceiverState;
    if (toSender) {
      total += toSender.length;
      messages += 1;
      [sender, senderState] = Automerge.receiveSyncMessage(sender, senderState, toSender);
    }
    if (!toReceiver && !toSender) break;
  }
  const fullSyncMs = now() - started;
  const segmentBytes = [...readSegments(scenario).values()].reduce((sum, blob) => sum + blob.length, 0);
  // The receiving device downloads the segments, verifies them and makes them resident.
  const remoteBackend = new MemorySegmentBackend();
  const remoteStore = resetInkSegments(remoteBackend);
  const blobs = readSegments(scenario);
  remoteStore.setRemote('test', { fetch: (hash) => Promise.resolve(blobs.get(hash)) });
  const fetchAt = now();
  await remoteStore.ensure(blobs.keys());
  const fetchMs = now() - fetchAt;
  return {
    fullSyncDocBytes: total, fullSyncSegmentBytes: segmentBytes, fullSyncBytes: total + segmentBytes, fullSyncMessages: messages,
    fullSyncMs, segmentFetchAdoptMs: fetchMs,
  };
}

/**
 * A page drawn from scratch stroke by stroke: bursts of 30 strokes, each
 * sealed after the pen rests, with the idle-time compaction in between. The
 * document keeps every operation it ever had, so this is the size and the
 * open time of a page that was inked live, not imported.
 */
async function phaseLiveSegments(scenario: Scenario): Promise<Record<string, number>> {
  const backend = new MemorySegmentBackend();
  const store = resetInkSegments(backend);
  pendingInk().reset();
  const empty: PageDocV3 = { ...portablePage(scenario), elementsById: {}, zOrder: [] };
  let document = createPageAutomergeDocV3(empty, { actorId: ACTOR }) as PageAutomergeDoc;
  const documentId = document.documentId;
  const target = (): InkPageTarget => ({
    read: () => ({ page: sharedPlainSnapshot(document) as never, version: Automerge.getHeads(document).join() }),
    change: (message, change) => {
      document = changePageDocument(document, { message }, (draft) => change(draft as never)) as PageAutomergeDoc;
      return true;
    },
  });
  const source = portablePage(scenario);
  const burst = 30;
  const sealMs: number[] = [];
  const started = now();
  for (let first = 0; first < strokeCount; first += burst) {
    const snapshot = getSharedAutomergeSnapshot(document);
    const strokes = Object.values(source.elementsById).slice(first, first + burst) as StrokeElementV2[];
    document = changePageDocument(document, { message: 'Draw ink' }, (draft) => {
      applyPageElementChanges(draft, { upserts: strokes }, snapshot.elementsById as Record<string, never>, TIME, snapshot.zOrder, undefined, { holdNewInk: true });
    }) as PageAutomergeDoc;
    const sealAt = now();
    await sealPendingInk(target(), documentId, store, pendingInk());
    await compactPageInk(target(), store);
    sealMs.push(now() - sealAt);
  }
  const totalMs = now() - started;
  const bytes = saveAutomergeDocument(document);
  const heads = Automerge.getHeads(document).join();
  const loadedAt = now();
  const reloaded = loadAutomergeDocument<PageAutomergeDoc>(bytes) as PageAutomergeDoc;
  const loadMs = now() - loadedAt;
  const snapshot = getSharedAutomergeSnapshot(reloaded);
  if (Object.keys(snapshot.elementsById).length !== strokeCount) {
    throw new Error(`Expected ${strokeCount} strokes, found ${Object.keys(snapshot.elementsById).length}.`);
  }
  void heads;
  return {
    docBytes: bytes.length, gzipBytes: gzipSync(bytes).length, ops: Automerge.stats(document).numOps,
    segments: Object.keys(document).filter((key) => key.startsWith('ink:')).length, blobs: backend.blobs.size,
    blobBytes: [...backend.blobs.values()].reduce((total, blob) => total + blob.length, 0),
    loadMs, sealAndCompactP50Ms: median(sealMs), sealAndCompactMaxMs: Math.max(...sealMs), totalMs,
  };
}

const PHASES: readonly Phase[] = ['create', 'open', 'edit', 'sync', 'live'];

async function runPhase(phase: Phase, scenario: Scenario, format: Variant): Promise<Record<string, number>> {
  if (format === 'segments') {
    if (phase === 'create') return phaseCreateSegments(scenario);
    if (phase === 'open') return phaseOpenSegments(scenario);
    if (phase === 'edit') return phaseEditSegments(scenario);
    if (phase === 'live') return phaseLiveSegments(scenario);
    return phaseSyncSegments(scenario);
  }
  if (format === 'packed-immutable' || format === 'blob') {
    if (phase === 'create') return phaseCreateCeiling(scenario, format);
    if (phase === 'open') return phaseOpenCeiling(scenario, format);
    return {};
  }
  if (phase === 'create') return phaseCreate(scenario, format);
  if (phase === 'open') return phaseOpen(scenario, format);
  if (phase === 'edit') return phaseEdit(scenario, format);
  return phaseSync(scenario, format);
}

function child(phase: Phase, scenario: Scenario, format: Variant): Record<string, number> {
  const result = spawnSync(process.execPath, [
    '--expose-gc', process.argv[1], '--child', phase, '--scenario', scenario, '--format', format,
    '--strokes', String(strokeCount), '--points', String(pointsPerStroke), '--dir', workDir,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${phase} ${scenario} ${format} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, number>;
}

async function main(): Promise<void> {
  const childIndex = argv.indexOf('--child');
  if (childIndex >= 0) {
    const phase = argv[childIndex + 1] as Phase;
    const scenario = arg('scenario', 'import') as Scenario;
    const format = arg('format', 'points') as Variant;
    // Instantiate and warm the WebAssembly module, so no phase pays for it.
    Automerge.change(Automerge.from({ warm: 1 }), (draft) => { draft.warm = 2; });
    process.stdout.write(`${JSON.stringify(await runPhase(phase, scenario, format))}\n`);
    return;
  }
  const selectedPhases = arg('phases', PHASES.join(',')).split(',') as Phase[];
  const scenarios = arg('scenarios', 'import,pen').split(',') as Scenario[];
  const formats = arg('formats', argv.includes('--variants') ? 'points,packed,packed-immutable,blob' : 'points,packed').split(',') as Variant[];
  const print = (line: string): void => { process.stdout.write(`${line}\n`); };
  print(`# ${strokeCount} strokes x ${pointsPerStroke} samples, ${runs} runs each (median), node ${process.version}, ${process.platform} ${process.arch}`);
  const table: Record<string, Record<string, unknown>> = {};
  for (const scenario of scenarios) {
    for (const format of formats) {
      const key = `${scenario}/${format}`;
      table[key] = {};
      const ceiling = format === 'packed-immutable' || format === 'blob';
      for (const phase of selectedPhases) {
        if (ceiling && (phase === 'edit' || phase === 'sync')) continue;
        if (phase === 'live' && format !== 'segments') continue;
        const samples = Array.from({ length: runs }, () => child(phase, scenario, format));
        for (const metric of Object.keys(samples[0])) {
          table[key][`${phase}.${metric}`] = round(median(samples.map((sample) => sample[metric])));
        }
      }
    }
  }
  const metrics = [...new Set(Object.values(table).flatMap((row) => Object.keys(row)))];
  const columns = Object.keys(table);
  print(['metric', ...columns].join('\t'));
  for (const metric of metrics) print([metric, ...columns.map((column) => String(table[column][metric] ?? ''))].join('\t'));
}

void main();
