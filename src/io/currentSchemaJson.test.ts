import { describe, expect, it } from 'vitest';
import type { NotebookDoc, PageDoc } from '../domain/v2';
import type { NotebookDocV3, PageDocV3 } from '../domain/v3';
import {
  CURRENT_SCHEMA_JSON_LIMITS,
  exportCurrentSchemaJson,
  importCurrentSchemaJson,
} from './currentSchemaJson';

const TIME = '2026-08-03T00:00:00.000Z';

function notebookV3(): NotebookDocV3 {
  return {
    schemaVersion: 3, documentId: 'notebook:n', kind: 'notebook', notebookId: 'n', title: 'Math', color: '#fff',
    createdAt: TIME, updatedAt: TIME,
    sections: [{ id: 's', title: 'Algebra', createdAt: TIME, updatedAt: TIME, pageDocumentIds: ['page:p'] }],
    settings: { defaultPageType: 'free' }, version: { protocol: 'automerge', heads: ['head'] },
  };
}

function pageV3(): PageDocV3 {
  const point = { x: 1, y: 2, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' };
  return {
    schemaVersion: 3, documentId: 'page:p', kind: 'page', notebookId: 'n', sectionId: 's', pageId: 'p',
    title: 'Quadratic', tags: ['school'], pageType: 'free', background: { type: 'grid', color: '#fff' },
    createdAt: TIME, updatedAt: TIME,
    mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
    elementsById: {
      math: {
        id: 'math', kind: 'math', frame: { x: 0, y: 0, width: 160, height: 60, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'converted-ink', autoRecognition: 'inherit',
        rawInk: { captureFrame: { x: 0, y: 0, width: 20, height: 20, rotation: 0 }, sourceStrokes: [{
          id: 'raw', kind: 'stroke', frame: { x: 0, y: 0, width: 20, height: 20, rotation: 0 },
          createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', points: [point], color: '#000000', size: 2, opacity: 1,
        }] },
        recognizedLatex: 'y=x^2', correctedLatex: 'y=x^{2}',
        recognition: { state: 'recognized', alternatives: ['y=x^2'], warnings: [], provider: { kind: 'mathpix', apiVersion: 'v1', modelVersion: 'm', durationMs: 20 } },
        result: { state: 'valid', exactLatex: 'x^2', decimalText: 'x^2', diagnostics: [] },
        dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
      },
      graph: {
        id: 'graph', kind: 'graph', frame: { x: 0, y: 80, width: 320, height: 200, rotation: 0 },
        createdAt: TIME, updatedAt: TIME, locked: false,
        series: [{ id: 'series', sourceMathElementId: 'math', color: '#3366cc', visible: true }],
        viewport: { xMin: -5, xMax: 5, yMin: -5, yMax: 25, equalScale: false, axesVisible: false, gridVisible: true },
      },
    },
    zOrder: ['math', 'graph'], version: { protocol: 'automerge', heads: ['head'] },
  };
}

describe('portable current-schema JSON', () => {
  it('round-trips v3 Math/Graph state losslessly without credentials or endpoint configuration', () => {
    const notebook = notebookV3();
    const page = pageV3();
    const serialized = exportCurrentSchemaJson({ notebook, pages: [page], exportedAt: TIME });
    const restored = importCurrentSchemaJson(serialized);
    expect(restored.notebook).toEqual(notebook);
    expect(restored.pages).toEqual([page]);
    expect((restored.pages[0].elementsById.graph as PageDocV3['elementsById'][string] & { viewport: { axesVisible: boolean; gridVisible: boolean } }).viewport)
      .toMatchObject({ axesVisible: false, gridVisible: true });
    expect(serialized).toContain('sourceStrokes');
    expect(serialized).toContain('correctedLatex');
    expect(serialized).not.toMatch(/apiKey|endpoint|providerConfig|token/i);
  });

  it('round-trips paper size and rule line settings and rejects malformed ones', () => {
    const page = pageV3();
    page.pageType = 'a4';
    page.paper = { size: 'a5', orientation: 'landscape' };
    page.background = { type: 'grid', color: '#fff', spacing: 19, lineColor: '#16a34a', lineStrength: 'strong' };
    const serialized = exportCurrentSchemaJson({ notebook: notebookV3(), pages: [page], exportedAt: TIME });
    const restored = importCurrentSchemaJson(serialized).pages[0];
    expect(restored.paper).toEqual({ size: 'a5', orientation: 'landscape' });
    expect(restored.background).toEqual(page.background);

    const malformed = JSON.parse(serialized) as { pages: Array<Record<string, unknown>> };
    malformed.pages[0].paper = { size: 'a3', orientation: 'portrait' };
    expect(() => importCurrentSchemaJson(JSON.stringify(malformed))).toThrow(/paper is malformed/);
    malformed.pages[0].paper = { size: 'a4', orientation: 'portrait' };
    malformed.pages[0].background = { type: 'grid', color: '#fff', lineStrength: 'bold' };
    expect(() => importCurrentSchemaJson(JSON.stringify(malformed))).toThrow(/rule lines are malformed/);
  });

  it('round-trips an optional section colour and rejects a malformed one', () => {
    const notebook = notebookV3();
    notebook.sections[0].color = '#c2185b';
    const serialized = exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME });
    expect(importCurrentSchemaJson(serialized).notebook.sections[0].color).toBe('#c2185b');

    notebook.sections[0].color = 'red; background: url(x)';
    expect(() => exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }))
      .toThrow(/colour is malformed/);
  });

  it('round-trips the notebook settings and still reads a notebook that only has the page type', () => {
    const notebook = notebookV3();
    notebook.settings = { defaultPageType: 'a4' };
    expect(importCurrentSchemaJson(
      exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }),
    ).notebook.settings).toEqual({ defaultPageType: 'a4' });

    notebook.settings = {
      defaultPageType: 'free',
      icon: '🎓',
      newPage: { pageType: 'free', ruling: 'lined', spacing: 28, paperColor: '#fdf6e3', template: 'builtin:lesson-notes' },
      sort: { pages: 'title' },
    };
    expect(importCurrentSchemaJson(
      exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }),
    ).notebook.settings).toEqual(notebook.settings);

    notebook.settings = { defaultPageType: 'a4', newPage: { paperColor: 'red; background: url(x)' } };
    expect(() => exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }))
      .toThrow(/settings are malformed/);
  });

  it('round-trips optional section groups and still reads notebooks without them', () => {
    const notebook = notebookV3();
    expect('sectionGroups' in importCurrentSchemaJson(
      exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }),
    ).notebook).toBe(false);

    notebook.sectionGroups = [
      { id: 'g-math', title: 'Mathematik', createdAt: TIME, updatedAt: TIME },
      { id: 'g-old', title: 'Abgeschlossen', parentGroupId: 'g-math', createdAt: TIME, updatedAt: TIME },
    ];
    notebook.sections[0].groupId = 'g-old';
    const restored = importCurrentSchemaJson(exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }));
    expect(restored.notebook.sectionGroups).toEqual(notebook.sectionGroups);
    expect(restored.notebook.sections[0].groupId).toBe('g-old');

    const withUnknownField = { id: 'g-math', title: 'Mathematik', createdAt: TIME, updatedAt: TIME, extra: 1 };
    notebook.sectionGroups = [withUnknownField];
    expect(() => exportCurrentSchemaJson({ notebook, pages: [pageV3()], exportedAt: TIME }))
      .toThrow(/unsupported field extra/);
  });

  it('round-trips strict Markdown page content only in schema v3', () => {
    const page = pageV3();
    page.pageContent = { version: 1, kind: 'markdown', source: '# Vektoren\n\n- Betrag\n- Richtung\n' };
    const serialized = exportCurrentSchemaJson({ notebook: notebookV3(), pages: [page], exportedAt: TIME });
    expect(importCurrentSchemaJson(serialized).pages[0].pageContent).toEqual(page.pageContent);

    const v2Notebook: NotebookDoc = { ...notebookV3(), schemaVersion: 2 };
    const v2Page = { ...page, schemaVersion: 2, elementsById: {}, zOrder: [] };
    delete (v2Page as Partial<PageDocV3>).mathSettings;
    expect(() => importCurrentSchemaJson(JSON.stringify({
      format: 'canvink-portable-json-v2', schemaVersion: 2, exportedAt: TIME,
      notebook: v2Notebook, pages: [v2Page],
    }))).toThrow(/unsupported field pageContent/);
  });

  it('imports a strict portable v2 graph and upgrades it to schema v3 without interpreting ink', () => {
    const notebook: NotebookDoc = { ...notebookV3(), schemaVersion: 2 };
    const page: PageDoc = {
      ...pageV3(), schemaVersion: 2, elementsById: {}, zOrder: [],
    };
    delete (page as unknown as Partial<PageDocV3>).mathSettings;
    const serialized = JSON.stringify({
      format: 'canvink-portable-json-v2', schemaVersion: 2, exportedAt: TIME, notebook, pages: [page],
    });
    const restored = importCurrentSchemaJson(serialized);
    expect(restored.schemaVersion).toBe(3);
    expect(restored.notebook.schemaVersion).toBe(3);
    expect(restored.pages[0]).toMatchObject({ schemaVersion: 3, elementsById: {} });
    expect(restored.pages[0].mathSettings).toBeUndefined();
    expect(restored.pages[0].pageContent).toBeUndefined();
  });

  it('rejects malformed, unknown, secret-bearing, and orphaned Graph input', () => {
    expect(() => importCurrentSchemaJson('{bad')).toThrow(/malformed/);
    const valid = JSON.parse(exportCurrentSchemaJson({ notebook: notebookV3(), pages: [pageV3()], exportedAt: TIME }));
    valid.unknown = true;
    expect(() => importCurrentSchemaJson(JSON.stringify(valid))).toThrow(/unsupported field/);

    delete valid.unknown;
    valid.pages[0].elementsById.math.providerConfig = { endpoint: 'https://secret.invalid', apiKey: 'secret' };
    expect(() => importCurrentSchemaJson(JSON.stringify(valid))).toThrow(/forbidden secret\/configuration/);

    delete valid.pages[0].elementsById.math.providerConfig;
    valid.pages[0].elementsById.graph.series[0].sourceMathElementId = 'missing';
    expect(() => importCurrentSchemaJson(JSON.stringify(valid))).toThrow(/missing or non-math source/);
  });

  it('rejects oversized strings and raw-ink samples before accepting a workspace', () => {
    const page = pageV3();
    page.title = 'x'.repeat(CURRENT_SCHEMA_JSON_LIMITS.stringBytes + 1);
    expect(() => exportCurrentSchemaJson({ notebook: notebookV3(), pages: [page], exportedAt: TIME }))
      .toThrow(/string budget/);

    const raw = pageV3();
    const math = raw.elementsById.math;
    if (math.kind !== 'math' || !math.rawInk) throw new Error('fixture math missing');
    math.rawInk.sourceStrokes[0].points = Array.from({ length: 50_001 }, (_, index) => ({
      x: index, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, time: index, pointerType: 'pen',
    }));
    expect(() => exportCurrentSchemaJson({ notebook: notebookV3(), pages: [raw], exportedAt: TIME }))
      .toThrow(/points exceeds its limit/);
  });
});
