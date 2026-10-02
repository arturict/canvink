import * as Automerge from '@automerge/automerge';
import type { DocHandle } from '@automerge/automerge-repo';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LivePageDocV2 } from '../crdt';
import type { RichTextDocument } from '../domain/v2';
import type { GraphElementV3, MathElementV3, PageDocV3 } from '../domain/v3';
import LiveCanvasEditor, {
  appendInkStrokeToMathElement,
  applyPressureCurve,
  arrowHeadPoints,
  exactVisiblePageRect,
  viewportShowing,
  canvasDimensions,
  clientPointToCanvas,
  createShapeFromDrag,
  createInkMathElement,
  createScrubPreviewElements,
  createTypedMathElement,
  elementUpdateBeforePatch,
  graphSeriesFromPage,
  conversionPayloadLatex,
  formatGraphCoordinate,
  liveMapToOperationMap,
  mathElementLatex,
  mayDispatchMathRecognition,
  mathUpdateBeforePatch,
  normalizeRulerAngle,
  recognitionFinalPatches,
  rulerEdgeGeometry,
  zoomViewportAroundPoint,
} from './LiveCanvasEditor';
import {
  applyLocalCommand,
  createLocalHistory,
  recordLocalCommand,
  redoLocalCommand,
  rulerEdgePoints,
  undoLocalCommand,
  type LocalCommand,
} from './operations';
import { attestLocalMathGesture, MathPageController, MathRecognitionScheduler } from '../math/page';
import type { RecognitionProvider } from '../math/recognition';

const TIME = '2026-08-03T00:00:00.000Z';

const page = (): LivePageDocV2 => ({
  schemaVersion: 2,
  documentId: 'page:1',
  kind: 'page',
  notebookId: 'notebook-1',
  sectionId: 'section-1',
  pageId: 'page-1',
  title: 'Physics',
  tags: [],
  pageType: 'free',
  background: { type: 'grid', color: '#ffffff' },
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  elementsById: {
    stroke: {
      id: 'stroke',
      kind: 'stroke',
      frame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      locked: false,
      tool: 'pen',
      points: [
        { x: 0, y: 0, pressure: 0.2, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
        { x: 10, y: 10, pressure: 0.8, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
      ],
      color: '#000000',
      size: 2,
      opacity: 1,
    },
    text: {
      id: 'text',
      kind: 'richText',
      frame: { x: 20, y: 20, width: 200, height: 100, rotation: 0 },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      locked: false,
      text: 'remote text',
      style: { color: '#111111', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
    },
  },
  zOrder: ['stroke', 'text'],
});

/**
 * graphSeriesFromPage samples under the graph engine's wall-clock deadline
 * (100 ms), which is a limit for a user's input, not what these tests check:
 * on a machine under parallel load a correct sampling misses it and the series
 * comes back empty. With the clock frozen the deadline cannot pass, so the
 * tests decide only on the sampled shapes.
 */
function graphSeriesWithoutDeadline(...args: Parameters<typeof graphSeriesFromPage>): ReturnType<typeof graphSeriesFromPage> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    return graphSeriesFromPage(...args);
  } finally {
    vi.useRealTimers();
  }
}

describe('liveMapToOperationMap', () => {
  const textElement = {
    id: 'text', kind: 'richText', frame: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, text: 'Hallo',
    style: { color: '#000', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
  } as unknown as Parameters<typeof liveMapToOperationMap>[0][string];
  const projected: RichTextDocument = { type: 'doc', blocks: [{ id: 'b', type: 'paragraph', spans: [{ text: 'Hallo', marks: [] }] }] };

  it('projects a text box when its content is first read, not when the map is built', () => {
    const project = vi.fn(() => projected);
    const elements = { text: textElement };

    const map = liveMapToOperationMap(elements, project);
    expect(project).not.toHaveBeenCalled();

    const element = map.text;
    if (element.kind !== 'richText') throw new Error('expected a text box');
    expect(element.content).toEqual(projected);
    expect(element.content).toEqual(projected);
    expect(project).toHaveBeenCalledTimes(1);
    // The same element version reuses the projection in the next map.
    expect(liveMapToOperationMap(elements, project).text).toBe(element);
    expect(JSON.parse(JSON.stringify(element)).content).toEqual(projected);
  });

  it('falls back to the plain text when the text box is gone by the time its content is read', () => {
    const map = liveMapToOperationMap({ text: textElement }, () => { throw new Error('removed'); });
    const element = map.text;
    if (element.kind !== 'richText') throw new Error('expected a text box');

    expect(element.content.blocks[0]).toMatchObject({ type: 'paragraph', spans: [{ text: 'Hallo' }] });
  });
});

describe('LiveCanvasEditor wiring', () => {
  it('renders stable z-order, accessible controls, and the rich-text spatial path host', () => {
    const markup = renderToStaticMarkup(
      createElement(LiveCanvasEditor, {
        handle: { doc: () => Automerge.from(page()) } as DocHandle<LivePageDocV2>,
        page: page(),
        deviceId: 'device-a',
        onChange: () => undefined,
        createId: (scope: string) => `${scope}-1`,
        now: () => '2026-08-03T01:00:00.000Z',
        clipboard: { readText: async () => '', writeText: async () => undefined },
      }),
    );

    expect(markup).toContain('aria-label="Werkzeuge der Zeichenfläche"');
    expect(markup.match(/<details/g)).toHaveLength(3);
    expect(markup).toContain('<span>Einfügen</span>');
    expect(markup).toContain('<span>Werkzeuge</span>');
    expect(markup).toContain('<span>Mehr</span>');
    const visibleToolbar = markup.slice(0, markup.indexOf('<details'));
    expect(visibleToolbar.match(/<button/g)).toHaveLength(6);
    expect(visibleToolbar).toContain('aria-label="Strichradierer"');
    expect(visibleToolbar).toContain('aria-label="Rückgängig"');
    expect(visibleToolbar).toContain('aria-label="Wiederholen"');
    expect(visibleToolbar).toMatch(/<button[^>]*aria-label="Rückgängig"[^>]*disabled=""/);
    expect(visibleToolbar).toMatch(/<button[^>]*aria-label="Wiederholen"[^>]*disabled=""/);
    expect(visibleToolbar).toContain('aria-label="Auswählen"');
    expect(markup).toContain('aria-label="Stift"');
    expect(visibleToolbar).toContain('aria-label="Stift"');
    expect(visibleToolbar).toContain('aria-label="Textmarker"');
    expect(visibleToolbar).not.toContain('aria-label="Verschieben"');
    expect(markup).toContain('aria-label="Verschieben"');
    expect(markup).toContain('aria-label="Lasso"');
    expect(markup).toContain('Stiftprofil');
    expect(markup).toContain('aria-label="Strichradierer"');
    expect(markup).toContain('aria-label="Punktradierer"');
    expect(markup).toContain('aria-label="Rasterfang"');
    expect(markup).toContain('aria-label="15°-Winkelfang"');
    expect(markup).toContain('aria-label="Lineal"');
    for (const shape of ['Linie', 'Pfeil', 'Vektor', 'Rechteck', 'Ellipse', 'Dreieck', 'Koordinatenachsen']) {
      expect(markup).toContain(`aria-label="${shape}"`);
    }
    expect(markup).toContain('aria-label="Verkleinern"');
    expect(markup).toContain('aria-label="Vergrössern"');
    expect(markup).toContain('Text hinzufügen');
    expect(markup).not.toContain('aria-label="Mathe"');
    expect(markup).not.toContain('Mathe-Seitenleiste');
    expect(markup).not.toContain('Graph aus Auswahl');
    expect(markup).toContain('Gemeinsame Seitenzeichenfläche');
    expect(markup).not.toContain('Leistungsnachweis exportieren');
    // Ink is painted on a canvas layer that sits below the text in z-order.
    expect(markup).toMatch(/data-ink-layer="ink:stroke"[^>]*style="z-index:1"/);
    expect(markup).toMatch(/data-element-id="text"[^>]*style="[^"]*z-index:2/);
    expect(markup).toContain('data-ink-stroke-count="1"');
    expect(markup).not.toContain('data-element-id="stroke"');
    expect(markup).toContain('canvink-rich-text-editor');
  });

  it('renders a persisted page angle-mode selector in the Math sidebar', () => {
    const markup = renderToStaticMarkup(
      createElement(LiveCanvasEditor, {
        handle: { doc: () => Automerge.from(page()) } as DocHandle<LivePageDocV2>,
        page: page(),
        deviceId: 'device-a',
        onChange: () => undefined,
        createId: (scope: string) => `${scope}-1`,
        now: () => '2026-08-03T01:00:00.000Z',
        initialMathSidebarOpen: true,
        mathFeaturesEnabled: true,
      }),
    );

    expect(markup).toContain('Winkelmodus');
    expect(markup).toContain('<option value="degrees" selected="">Grad</option>');
    expect(markup).toContain('<option value="radians">Bogenmass</option>');
  });

  it('applies deterministic school pressure curves', () => {
    expect(applyPressureCurve(0.25, 'linear')).toBe(0.25);
    expect(applyPressureCurve(0.25, 'soft')).toBe(0.5);
    expect(applyPressureCurve(0.5, 'firm')).toBe(0.25);
  });

  it('creates every visible school shape and distinguishes vectors from arrows', () => {
    const tools = ['line', 'arrow', 'vector', 'rectangle', 'ellipse', 'triangle', 'axes'] as const;
    const shapes = tools.map((tool, index) => createShapeFromDrag({
      tool,
      start: { x: 10, y: 20 },
      end: { x: 110, y: 80 },
      id: `${tool}-${index}`,
      timestamp: '2026-08-03T01:00:00.000Z',
      background: 'plain',
      gridSnap: false,
      angleSnap: false,
    }));

    expect(shapes.every(Boolean)).toBe(true);
    expect(shapes.map((shape) => shape?.shape)).toEqual([
      'line', 'arrow', 'arrow', 'rectangle', 'ellipse', 'triangle', 'axes',
    ]);
    expect(shapes[2]?.strokeColor).toBe('#0f766e');

    const fixture = page();
    fixture.elementsById = Object.fromEntries(
      shapes.map((shape) => {
        if (!shape) throw new Error('expected a shape');
        return [shape.id, shape];
      }),
    );
    fixture.zOrder = Object.keys(fixture.elementsById);
    const markup = renderToStaticMarkup(createElement(LiveCanvasEditor, {
      handle: { doc: () => Automerge.from(fixture) } as DocHandle<LivePageDocV2>,
      page: fixture,
      deviceId: 'device-a',
      onChange: () => undefined,
    }));
    expect(markup).toContain('<rect');
    expect(markup).toContain('<ellipse');
    expect(markup).toContain('<polygon');
    expect(markup).toContain('data-shape-kind="vektor"');
    expect((markup.match(/<line/g) ?? [])).toHaveLength(5);
  });

  it('applies background grid, 15-degree, and ruler snapping deterministically', () => {
    const grid = createShapeFromDrag({
      tool: 'rectangle',
      start: { x: 13, y: 17 },
      end: { x: 94, y: 71 },
      id: 'grid',
      timestamp: 'now',
      background: 'grid',
      gridSnap: true,
      angleSnap: false,
    });
    expect(grid?.frame).toMatchObject({ x: 0, y: 0, width: 80, height: 80 });

    const angled = createShapeFromDrag({
      tool: 'line',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 20 },
      id: 'angled',
      timestamp: 'now',
      background: 'plain',
      gridSnap: false,
      angleSnap: true,
    });
    const angledEnd = angled?.points?.[1];
    expect(angledEnd && Math.atan2(angledEnd.y, angledEnd.x) * 180 / Math.PI).toBeCloseTo(15, 5);

    const ruler = {
      visible: true,
      x: 180,
      y: 140,
      angleDegrees: 37,
      length: 400,
    };
    const [rulerStart, rulerEnd] = rulerEdgePoints(rulerEdgeGeometry(ruler));
    const ruled = createShapeFromDrag({
      tool: 'arrow',
      start: { x: rulerStart.x + 60, y: rulerStart.y + 4 },
      end: { x: rulerEnd.x - 60, y: rulerEnd.y - 6 },
      id: 'ruled',
      timestamp: 'now',
      background: 'plain',
      gridSnap: false,
      angleSnap: false,
      ruler,
    });
    if (!ruled?.points) throw new Error('expected a ruler-aligned arrow');
    const [ruledStart, ruledEnd] = ruled.points;
    expect(Math.atan2(ruledEnd.y - ruledStart.y, ruledEnd.x - ruledStart.x) * 180 / Math.PI).toBeCloseTo(37, 5);
    expect(normalizeRulerAngle(397)).toBe(37);
    expect(normalizeRulerAngle(-181)).toBe(179);
  });

  it('keeps pointer coordinates and the zoom anchor transform-correct', () => {
    expect(clientPointToCanvas(
      { x: 330, y: 240 },
      { left: 30, top: 40 },
      2,
    )).toEqual({ x: 150, y: 100 });

    const viewport = zoomViewportAroundPoint(
      { zoom: 1, panX: 20, panY: 10 },
      2,
      { x: 220, y: 110 },
    );
    expect(viewport).toEqual({ zoom: 2, panX: -180, panY: -90 });
    expect((220 - viewport.panX) / viewport.zoom).toBe(200);
    expect((110 - viewport.panY) / viewport.zoom).toBe(100);
  });

  it('uses fixed A4 paper and a content-aware free canvas', () => {
    const a4 = page();
    a4.pageType = 'a4';
    expect(canvasDimensions(a4)).toEqual({ width: 794, height: 1123 });

    const free = page();
    free.elementsById.stroke.frame = { x: 1_500, y: 1_100, width: 300, height: 200, rotation: 0 };
    expect(canvasDimensions(free)).toEqual({ width: 2_120, height: 1_620 });
    // A whole viewport of empty paper stays below the lowest ink.
    expect(canvasDimensions(free, 900)).toEqual({ width: 2_120, height: 2_200 });
    expect(canvasDimensions(a4, 900)).toEqual({ width: 794, height: 1123 });
    expect(arrowHeadPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 5)).toEqual([
      { x: 10 - Math.cos(-Math.PI / 7) * 5, y: -Math.sin(-Math.PI / 7) * 5 },
      { x: 10 - Math.cos(Math.PI / 7) * 5, y: -Math.sin(Math.PI / 7) * 5 },
    ]);
  });

  it('keeps viewer mode mutation-free while retaining navigation controls', () => {
    const fixture = page();
    const markup = renderToStaticMarkup(createElement(LiveCanvasEditor, {
      handle: { doc: () => Automerge.from(fixture) } as DocHandle<LivePageDocV2>,
      page: fixture,
      deviceId: 'viewer-device',
      editable: false,
      onChange: () => {
        throw new Error('A viewer must never receive a mutation callback.');
      },
    }));

    expect(markup).toMatch(/<button[^>]*aria-label="Stift"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Lineal<\/button>/);
    expect(markup).toMatch(/<button[^>]*aria-label="Verschieben"[^>]*>/);
    expect(markup).toContain('aria-readonly="true"');
  });

  it('creates typed and handwritten Math blocks without creating a normal page stroke', () => {
    const typed = createTypedMathElement('math-typed', '2026-08-03T00:00:00.000Z');
    expect(typed).toMatchObject({ kind: 'math', inputKind: 'typed', typedLatex: '' });
    const points = [
      { x: 10, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' as const },
      { x: 30, y: 40, pressure: 0.7, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' as const },
    ];
    const ink = createInkMathElement({
      id: 'math-ink',
      strokeId: 'raw-stroke',
      timestamp: '2026-08-03T00:00:00.000Z',
      points,
      color: '#123456',
      size: 3,
    });
    expect(ink).toMatchObject({
      kind: 'math',
      inputKind: 'ink',
      recognition: { state: 'idle' },
      rawInk: { sourceStrokes: [{ id: 'raw-stroke', kind: 'stroke', locked: true }] },
    });
    expect(ink.rawInk?.sourceStrokes[0]?.points).toEqual(points);
    expect(ink.rawInk?.sourceStrokes[0]?.points).not.toBe(points);
    expect(Object.hasOwn(ink, 'typedLatex')).toBe(false);
    const settings = { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: false } as const;
    expect(mayDispatchMathRecognition({ ...ink, autoRecognition: 'disabled' }, ink, settings, false)).toBe(false);
    expect(mayDispatchMathRecognition({ ...ink, autoRecognition: 'disabled' }, ink, settings, true)).toBe(true);
    expect(mayDispatchMathRecognition(undefined, ink, settings, true)).toBe(false);
    const changed = appendInkStrokeToMathElement({
      element: ink, strokeId: 'later', timestamp: TIME,
      points: points.map((point) => ({ ...point, x: point.x + 1 })), color: '#123456', size: 3,
    });
    expect(mayDispatchMathRecognition(changed, ink, { ...settings, autoRecognition: true }, false)).toBe(false);
  });

  it('keeps unavailable handwritten recognition visibly pending despite a local parse error', () => {
    const fixture = page();
    const ink = createInkMathElement({
      id: 'pending-math', strokeId: 'pending-stroke', timestamp: TIME,
      points: [
        { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
        { x: 10, y: 10, pressure: 0.5, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
      ],
      color: '#111111', size: 2,
    });
    ink.recognition = { state: 'pending', alternatives: [], warnings: ['provider-error:provider-unavailable'] };
    ink.result = { state: 'error', diagnostics: ['Expression is empty.'] };
    fixture.elementsById = { [ink.id]: ink };
    fixture.zOrder = [ink.id];
    const markup = renderToStaticMarkup(createElement(LiveCanvasEditor, {
      handle: { doc: () => Automerge.from(fixture) } as DocHandle<LivePageDocV2>,
      page: fixture, deviceId: 'pending-device', onChange: () => true,
    }));
    expect(markup).toContain('class="math-block" data-input-kind="ink" data-status="pending"');
  });

  it('appends three nearby pen gestures losslessly to one active Math block', () => {
    const firstPoints = [
      { x: 10, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' as const },
      { x: 30, y: 40, pressure: 0.7, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' as const },
    ];
    const first = createInkMathElement({ id: 'math', strokeId: 's1', timestamp: TIME, points: firstPoints, color: '#000', size: 2 });
    const second = appendInkStrokeToMathElement({
      element: first, strokeId: 's2', timestamp: TIME,
      points: [{ ...firstPoints[0], x: 36 }, { ...firstPoints[1], x: 48 }], color: '#000', size: 2,
    });
    const third = appendInkStrokeToMathElement({
      element: second, strokeId: 's3', timestamp: TIME,
      points: [{ ...firstPoints[0], x: 4, y: 10 }, { ...firstPoints[1], x: 52, y: 46 }], color: '#000', size: 2,
    });
    expect(first.rawInk?.sourceStrokes).toHaveLength(1);
    expect(third.rawInk?.sourceStrokes.map((stroke) => stroke.id)).toEqual(['s1', 's2', 's3']);
    expect(third.rawInk?.captureFrame).toMatchObject({ x: 4, y: 10, width: 48, height: 36 });
    expect(third.frame.x).toBeLessThanOrEqual(third.rawInk?.captureFrame.x ?? 0);
  });

  it('reschedules one active block across three gestures and calls the provider only after the last 900ms pause', async () => {
    vi.useFakeTimers();
    try {
      const points = [
        { x: 10, y: 10, pressure: 1, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' as const },
        { x: 20, y: 20, pressure: 1, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' as const },
      ];
      const revisions = [createInkMathElement({ id: 'math', strokeId: 's1', timestamp: TIME, points, color: '#000', size: 2 })];
      revisions.push(appendInkStrokeToMathElement({ element: revisions[0], strokeId: 's2', timestamp: TIME, points: points.map((point) => ({ ...point, x: point.x + 4 })), color: '#000', size: 2 }));
      revisions.push(appendInkStrokeToMathElement({ element: revisions[1], strokeId: 's3', timestamp: TIME, points: points.map((point) => ({ ...point, y: point.y + 4 })), color: '#000', size: 2 }));
      const selections: Array<Parameters<RecognitionProvider['recognize']>[0]> = [];
      const recognize: RecognitionProvider['recognize'] = vi.fn((selection) => {
        selections.push(selection);
        return new Promise<never>(() => undefined);
      });
      const provider: RecognitionProvider = {
        kind: 'compatible',
        status: async () => ({ provider: 'compatible', configured: true, networkScope: 'private' }),
        recognize,
      };
      const scheduler = new MathRecognitionScheduler();
      revisions.forEach((element, index) => {
        scheduler.schedule({
          element,
          pageSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
          attestation: attestLocalMathGesture({
            element, trigger: 'activeLocalMathBlock',
            operationId: `operation_${String(index).padStart(16, '0')}`,
            requestId: `request_${String(index).padStart(16, '0')}`,
            provider: 'compatible', locale: 'de', decimalSeparator: 'comma',
          }),
          provider,
          onUpdate: () => undefined,
        });
      });
      await vi.advanceTimersByTimeAsync(899);
      expect(recognize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recognize).toHaveBeenCalledTimes(1);
      expect(selections).toHaveLength(1);
      expect(selections[0]?.strokes).toHaveLength(3);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('undoes one final recognition command while preserving raw ink and remote frame fields', () => {
    const baseline = createInkMathElement({
      id: 'math', strokeId: 'raw', timestamp: TIME,
      points: [
        { x: 1, y: 1, pressure: 1, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
        { x: 2, y: 2, pressure: 1, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
      ], color: '#000', size: 2,
    });
    const recognized: MathElementV3 = {
      ...baseline, recognizedLatex: '2+2',
      recognition: { state: 'recognized', alternatives: [], warnings: [] },
      result: { state: 'valid', exactLatex: '4', decimalText: '4', diagnostics: [] },
    };
    const patches = recognitionFinalPatches(baseline, recognized, '2026-08-03T01:00:00.000Z');
    const command: LocalCommand = {
      commandId: 'recognition', deviceId: 'device',
      patches: [{ elementId: baseline.id, before: patches.before, after: patches.after }],
    };
    const remoteFrame = { ...baseline.frame, x: 999 };
    const applied = applyLocalCommand({ [baseline.id]: { ...baseline, frame: remoteFrame } }, command);
    const history = recordLocalCommand(createLocalHistory('device'), command);
    const undone = undoLocalCommand(history, applied);
    const undoneMath = undone.elements[baseline.id] as MathElementV3;
    expect(undoneMath.rawInk).toEqual(baseline.rawInk);
    expect(undoneMath.recognizedLatex).toBeUndefined();
    expect(undoneMath.result.state).toBe('none');
    expect(undoneMath.frame).toEqual(remoteFrame);
    const redone = redoLocalCommand(undone.history, undone.elements);
    expect(redone.elements[baseline.id]).toMatchObject({
      recognizedLatex: '2+2', recognition: { state: 'recognized' }, result: { exactLatex: '4' }, frame: remoteFrame,
    });
  });

  it('undoes and redoes an ink correction by deleting the previously absent optional field', () => {
    const ink = createInkMathElement({
      id: 'corrected-ink', strokeId: 'raw', timestamp: TIME,
      points: [
        { x: 1, y: 1, pressure: 1, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
        { x: 12, y: 8, pressure: 1, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
      ], color: '#000', size: 2,
    });
    const update: Partial<MathElementV3> = {
      correctedLatex: '6+6',
      result: { state: 'none', diagnostics: [] },
      dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
    };
    const before = mathUpdateBeforePatch(ink, update);
    expect(Object.hasOwn(before, 'correctedLatex')).toBe(false);
    const command: LocalCommand = {
      commandId: 'correct-ink', deviceId: 'device',
      patches: [{ elementId: ink.id, before, after: { ...update, updatedAt: 'later' } }],
    };
    const applied = applyLocalCommand({ [ink.id]: ink }, command);
    const history = recordLocalCommand(createLocalHistory('device'), command);
    const undone = undoLocalCommand(history, applied);
    const undoneInk = undone.elements[ink.id] as MathElementV3;
    expect(Object.hasOwn(undoneInk, 'correctedLatex')).toBe(false);
    expect(undoneInk.rawInk).toEqual(ink.rawInk);
    const redone = redoLocalCommand(undone.history, undone.elements);
    expect((redone.elements[ink.id] as MathElementV3).correctedLatex).toBe('6+6');
    expect((redone.elements[ink.id] as MathElementV3).rawInk).toEqual(ink.rawInk);
  });

  it('recomputes dependent values deterministically after undoing a scrub correction', async () => {
    const definition = { ...createTypedMathElement('definition', TIME), typedLatex: 'a=2' };
    const dependent = {
      ...createTypedMathElement('dependent', TIME),
      typedLatex: 'a+1', frame: { x: 420, y: 80, width: 320, height: 140, rotation: 0 },
    };
    const fixture = {
      ...page(), schemaVersion: 3 as const,
      elementsById: { [definition.id]: definition, [dependent.id]: dependent },
      zOrder: [definition.id, dependent.id],
      mathSettings: { version: 1 as const, resultMode: 'suggest' as const, numberMode: 'exact' as const,
        angleMode: 'degrees' as const, autoRecognition: true },
      version: { protocol: 'uninitialized' as const, heads: [] },
    } as PageDocV3;
    const controller = new MathPageController({ now: () => '2026-08-03T01:00:00.000Z' });
    const initial = await controller.recompute(fixture);
    expect((initial.page.elementsById[dependent.id] as MathElementV3).result.exactLatex).toBe('3');
    const currentDefinition = initial.page.elementsById[definition.id] as MathElementV3;
    const update: Partial<MathElementV3> = {
      correctedLatex: 'a=3', result: { state: 'none', diagnostics: [] },
      dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
    };
    const command: LocalCommand = {
      commandId: 'scrub-definition', deviceId: 'device',
      patches: [{
        elementId: definition.id,
        before: mathUpdateBeforePatch(currentDefinition, update),
        after: { ...update, updatedAt: '2026-08-03T01:01:00.000Z' },
      }],
    };
    const scrubbedElements = applyLocalCommand(initial.page.elementsById, command);
    const scrubbed = await controller.recompute({ ...initial.page, elementsById: scrubbedElements });
    expect((scrubbed.page.elementsById[dependent.id] as MathElementV3).result.exactLatex).toBe('4');
    const history = recordLocalCommand(createLocalHistory('device'), command);
    const undone = undoLocalCommand(history, scrubbed.page.elementsById);
    expect(Object.hasOwn(undone.elements[definition.id], 'correctedLatex')).toBe(false);
    const recomputed = await controller.recompute({ ...scrubbed.page, elementsById: undone.elements });
    expect((recomputed.page.elementsById[definition.id] as MathElementV3).result.exactLatex).toBe('2');
    expect((recomputed.page.elementsById[dependent.id] as MathElementV3).result.exactLatex).toBe('3');
  });

  it('keeps a graph valid when a viewport change is undone and redone', () => {
    const graph: GraphElementV3 = {
      id: 'graph',
      kind: 'graph',
      frame: { x: 0, y: 200, width: 400, height: 300, rotation: 0 },
      createdAt: TIME,
      updatedAt: TIME,
      locked: false,
      series: [{ id: 'series', sourceMathElementId: 'math-source', color: '#2463eb', visible: true }],
      viewport: {
        xMin: -2, xMax: 2, yMin: -1, yMax: 5, equalScale: true, axesVisible: true, gridVisible: true,
      },
    };
    const update: Partial<GraphElementV3> = { viewport: { ...graph.viewport, xMin: -4, xMax: 4 } };
    const command: LocalCommand = {
      commandId: 'zoom-graph', deviceId: 'device',
      patches: [{
        elementId: graph.id,
        before: elementUpdateBeforePatch(graph, update),
        after: { ...update, updatedAt: 'later' },
      }],
    };
    const applied = applyLocalCommand({ [graph.id]: graph }, command);
    const undone = undoLocalCommand(recordLocalCommand(createLocalHistory('device'), command), applied);
    expect(undone.elements[graph.id]).toEqual(graph);
    const redone = redoLocalCommand(undone.history, undone.elements);
    expect(redone.elements[graph.id]).toEqual(applied[graph.id]);
  });

  it('samples persisted graph references into finite numeric arrays only', () => {
    const math: MathElementV3 = {
      ...createTypedMathElement('math-source', '2026-08-03T00:00:00.000Z'),
      typedLatex: 'y=x^2',
    };
    const graph: GraphElementV3 = {
      id: 'graph',
      kind: 'graph',
      frame: { x: 0, y: 200, width: 400, height: 300, rotation: 0 },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      locked: false,
      series: [{ id: 'series', sourceMathElementId: math.id, color: '#2463eb', visible: true }],
      viewport: {
        xMin: -2, xMax: 2, yMin: -1, yMax: 5, equalScale: true, axesVisible: true, gridVisible: true,
      },
    };
    const series = graphSeriesWithoutDeadline(graph, { [math.id]: math, [graph.id]: graph }, 'degrees');
    expect(series).toHaveLength(1);
    expect(series[0]?.points.length).toBe(257);
    expect(series[0]?.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it('recomputes dependent Math results and graph variables in a local scrub preview', () => {
    const definition = {
      ...createTypedMathElement('definition', TIME),
      frame: { x: 0, y: 0, width: 320, height: 80, rotation: 0 },
      typedLatex: 'a=2',
    };
    const dependent = {
      ...createTypedMathElement('dependent', TIME),
      frame: { x: 0, y: 100, width: 320, height: 80, rotation: 0 },
      typedLatex: 'b=a+1',
    };
    const graphFormula = {
      ...createTypedMathElement('graph-formula', TIME),
      frame: { x: 0, y: 200, width: 320, height: 80, rotation: 0 },
      typedLatex: 'y=b*x',
    };
    const graph: GraphElementV3 = {
      id: 'scrub-preview-graph', kind: 'graph',
      frame: { x: 400, y: 0, width: 400, height: 300, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false,
      series: [{ id: 'series', sourceMathElementId: graphFormula.id, color: '#2463eb', visible: true }],
      viewport: { xMin: -2, xMax: 2, yMin: -10, yMax: 10, equalScale: true, axesVisible: true, gridVisible: true },
    };
    const original = {
      [definition.id]: definition,
      [dependent.id]: dependent,
      [graphFormula.id]: graphFormula,
      [graph.id]: graph,
    };

    const preview = createScrubPreviewElements(original, {
      elementId: definition.id,
      latex: 'a=4',
    }, { angleMode: 'degrees', resultMode: 'suggest' });

    expect(preview).not.toBe(original);
    expect((preview[definition.id] as MathElementV3).result.exactLatex).toBe('4');
    expect((preview[dependent.id] as MathElementV3).result.exactLatex).toBe('5');
    expect((preview[dependent.id] as MathElementV3).dependencies).toMatchObject({
      references: ['a'], dependsOnElementIds: [definition.id], state: 'valid',
    });
    expect(mathElementLatex(preview[definition.id] as MathElementV3)).toBe('a=4');
    expect(mathElementLatex(original[definition.id] as MathElementV3)).toBe('a=2');
    const series = graphSeriesWithoutDeadline(graph, preview, 'degrees');
    expect(series[0]?.points.find((point) => point.x === 1)?.y).toBe(5);
  });

  it('splits discontinuous graphs instead of connecting across a null sample', () => {
    const math: MathElementV3 = {
      ...createTypedMathElement('reciprocal', '2026-08-03T00:00:00.000Z'), typedLatex: 'y=1/x',
    };
    const graph: GraphElementV3 = {
      id: 'reciprocal-graph', kind: 'graph', frame: { x: 0, y: 0, width: 400, height: 300, rotation: 0 },
      createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z', locked: false,
      series: [{ id: 'reciprocal-series', sourceMathElementId: math.id, color: '#2463eb', visible: true }],
      viewport: { xMin: -2, xMax: 2, yMin: -10, yMax: 10, equalScale: true, axesVisible: true, gridVisible: true },
    };
    const series = graphSeriesWithoutDeadline(graph, { [math.id]: math, [graph.id]: graph }, 'degrees');
    expect(series.map((item) => item.id)).toEqual([
      'reciprocal-series:segment:0', 'reciprocal-series:segment:1',
    ]);
    expect(series[0]?.points.every((point) => point.x < 0)).toBe(true);
    expect(series[1]?.points.every((point) => point.x > 0)).toBe(true);
  });

  it('renders implicit circle and line paths as stable numeric series', () => {
    const circle = { ...createTypedMathElement('circle', TIME), typedLatex: 'x^2+y^2=4' };
    const line = { ...createTypedMathElement('line', TIME), typedLatex: 'x+y=0' };
    const graph: GraphElementV3 = {
      id: 'implicit', kind: 'graph', frame: { x: 0, y: 0, width: 400, height: 300, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false,
      series: [
        { id: 'circle-series', sourceMathElementId: circle.id, color: '#2463eb', visible: true },
        { id: 'line-series', sourceMathElementId: line.id, color: '#dc2626', visible: true },
      ],
      viewport: { xMin: -3, xMax: 3, yMin: -3, yMax: 3, equalScale: true, axesVisible: true, gridVisible: true },
    };
    const series = graphSeriesWithoutDeadline(graph, { circle, line, implicit: graph }, 'radians');
    expect(series.map((item) => item.id)).toEqual(['circle-series:path:0', 'line-series:path:0']);
    expect(series.every((item) => item.points.length > 2 && item.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))).toBe(true);
    expect(formatGraphCoordinate({ x: 1.25, y: -2 })).toMatch(/x = 1[.,]25, y = -2/);
  });

  it('builds safe typed conversion LaTeX from closed unit and currency identifiers', () => {
    expect(conversionPayloadLatex({
      expression: { kind: 'unit-conversion', value: 1, sourceUnitId: 'meter', targetUnitId: 'centimeter' },
      visibleResult: '100 centimeter', numberMode: 'decimal', angleMode: 'degrees',
    })).toBe('1\\,\\mathrm{meter}\\;\\longrightarrow\\;\\mathrm{centimeter}');
  });

  it('mounts the Math sidebar without accepting credentials in the web build', () => {
    const fixture = page();
    const markup = renderToStaticMarkup(createElement(LiveCanvasEditor, {
      handle: { doc: () => Automerge.from(fixture) } as DocHandle<LivePageDocV2>,
      page: fixture,
      deviceId: 'math-sidebar-device',
      initialMathSidebarOpen: true,
      mathFeaturesEnabled: true,
      onChange: () => true,
    }));
    expect(markup).toContain('aria-label="Mathe-Seitenleiste"');
    expect(markup).toContain('data-math-sidebar-open="true"');
    expect(markup).toContain('aria-label="Rechnerpalette"');
    expect(markup).toContain('Rechenverlauf');
    expect(markup).toContain('Handschrifterkennung');
    expect(markup).toContain('Externe Handschrifterkennung und Zugangsdaten sind nur in der Desktop-App verfügbar.');
    expect(markup).not.toContain('Mathpix App-ID');
    expect(markup).not.toContain('Bearer-Token');
  });

  it('makes compatible and Mathpix recognition explicitly selectable on desktop', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    try {
      const fixture = page();
      const markup = renderToStaticMarkup(createElement(LiveCanvasEditor, {
        handle: { doc: () => Automerge.from(fixture) } as DocHandle<LivePageDocV2>,
        page: fixture,
        deviceId: 'desktop-provider-device',
        initialMathSidebarOpen: true,
        mathFeaturesEnabled: true,
        onChange: () => true,
      }));
      expect(markup).toContain('Aktiver Erkennungsanbieter');
      expect(markup).toContain('<option value="compatible" selected="">Compatible / TexTeller</option>');
      expect(markup).toContain('<option value="mathpix">Mathpix</option>');
      expect(markup).toContain('Mathpix App-ID');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("presence viewport", () => {
  const size = { width: 1000, height: 600 };
  const offset = { x: 24, y: 24 };

  it("reports the visible page rect in page coordinates", () => {
    expect(exactVisiblePageRect({ zoom: 1, panX: 0, panY: 0 }, size, offset)).toEqual({ x: -24, y: -24, width: 1000, height: 600 });
    expect(exactVisiblePageRect({ zoom: 2, panX: -400, panY: -200 }, size, offset)).toEqual({ x: 188, y: 88, width: 500, height: 300 });
  });

  it("shows a target centred, as large as fits, and round-trips through the reported rect", () => {
    const target = { x: 1000, y: 2000, width: 500, height: 300 };
    const view = viewportShowing(target, size, offset);
    expect(view.zoom).toBe(2);
    const seen = exactVisiblePageRect(view, size, offset);
    expect(seen.x + seen.width / 2).toBeCloseTo(1250);
    expect(seen.y + seen.height / 2).toBeCloseTo(2150);
  });

  it("stays within the zoom limits for a huge or tiny window", () => {
    expect(viewportShowing({ x: 0, y: 0, width: 100_000, height: 100_000 }, size, offset).zoom).toBe(0.25);
    expect(viewportShowing({ x: 0, y: 0, width: 10, height: 10 }, size, offset).zoom).toBe(2.5);
  });
});
