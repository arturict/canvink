import { describe, expect, it } from 'vitest';
import type { PageElementV3 } from '../../domain/v3';
import { ruleLineColor } from '../../editor/paper';
import { applyOneNoteImportApplication, prepareOneNoteImportApplication } from '../apply/application';
import { selectOneNoteImportOutline } from '../apply/sources';
import { MemoryOneNoteApplyTarget } from '../apply/testing';
import {
  desktopExportFilesFromEntries,
  desktopExportFilesFromZip,
  openOneNoteDesktopExport,
  type DesktopExportFiles,
} from './convert';
import type { OneNoteDesktopExportManifest } from './exportFormat';
import { NOTES_INK, WORKSHEET_INK, notesPageXml, syntheticDesktopExport, worksheetPageXml } from './fixtures';
import { parseOneNoteInlineHtml } from './inlineHtml';
import { POINTS_TO_PX, convertDesktopPageXml, inkStrokesAt, simplifyInkPoints } from './pageXml';
import { parseXml } from './xml';
import { openZipArchive, readZipEntries } from './zip';

const ASSETS = {
  asset: (path: string) => (path.startsWith('assets/')
    ? { resourceId: path, mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
    : { resourceId: path, mediaType: 'application/pdf', bytes: 30, originalName: 'brueche.pdf' }),
};

const CREATED_AT = '2026-09-24T10:00:00.000Z';

/** Opens, reviews and applies a desktop export into an in-memory target. */
async function importExport(files: DesktopExportFiles, sectionIds?: ReadonlySet<string>) {
  const acquisition = await openOneNoteDesktopExport(files, { createdAt: CREATED_AT });
  const target = new MemoryOneNoteApplyTarget();
  const [notebook] = acquisition.outline.notebooks;
  const outline = selectOneNoteImportOutline(
    acquisition.outline,
    notebook.sourceId,
    sectionIds ?? new Set(notebook.sections.map((section) => section.sourceId)),
    { notebookUnavailable: 'unavailable', sectionRequired: 'required' },
  );
  const stage = await prepareOneNoteImportApplication({ outline, source: acquisition.reader, target });
  const result = await applyOneNoteImportApplication(target, stage, {
    approvalArtifactFingerprint: stage.review.approvalArtifactFingerprint,
  });
  return { acquisition, stage, result, target };
}

describe('XML reader', () => {
  it('reads namespaced elements, attributes, CDATA and entities, and refuses DOCTYPEs', () => {
    const root = parseXml('﻿<?xml version="1.0"?><one:Page a="x &amp; y"><!-- c --><one:T><![CDATA[<b>fett</b>]]></one:T><one:E/></one:Page>');
    expect(root.name).toBe('one:Page');
    expect(root.attributes.a).toBe('x & y');
    expect(root.children).toHaveLength(2);
    expect((root.children[0] as { children: string[] }).children[0]).toBe('<b>fett</b>');
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')).toThrow(/DOCTYPE/);
    expect(() => parseXml('<a><b></a>')).toThrow(/Mismatched/);
  });
});

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('ZIP reader', () => {
  it('reads stored and deflated entries of an export archive', async () => {
    const encoder = new TextEncoder();
    const entries: Array<{ name: string; data: Uint8Array; method: 0 | 8 }> = [
      { name: 'bm-export/manifest.json', data: encoder.encode('{"a":1}'), method: 0 },
      { name: 'bm-export/pages/0001.xml', data: encoder.encode('<x>'.repeat(200)), method: 8 },
    ];
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const body = entry.method === 8 ? await deflateRaw(entry.data) : entry.data;
      const local = new Uint8Array(30 + name.length + body.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(8, entry.method, true);
      view.setUint32(18, body.length, true);
      view.setUint32(22, entry.data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      local.set(body, 30 + name.length);
      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(10, entry.method, true);
      centralView.setUint32(20, body.length, true);
      centralView.setUint32(24, entry.data.length, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint32(42, offset, true);
      central.set(name, 46);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    }
    const directorySize = centrals.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, offset, true);
    const archive = new Uint8Array([...locals.flatMap((item) => [...item]), ...centrals.flatMap((item) => [...item]), ...end]);
    const read = await readZipEntries(archive);
    const files = desktopExportFilesFromEntries(read);
    expect(new TextDecoder().decode(await files.read('manifest.json'))).toBe('{"a":1}');
    expect(new TextDecoder().decode(await files.read('pages/0001.xml'))).toBe('<x>'.repeat(200));
    // The lazy reader keeps the archive as a Blob and inflates an entry only when it is read.
    const lazy = desktopExportFilesFromZip(await openZipArchive(new Blob([archive])));
    expect(lazy.has('pages/0001.xml')).toBe(true);
    expect(lazy.size?.('pages/0001.xml')).toBe(600);
    expect(new TextDecoder().decode(await lazy.read('pages/0001.xml'))).toBe('<x>'.repeat(200));
    await expect(lazy.read('pages/0002.xml')).rejects.toThrow('missing');
  });
});

describe('OneNote inline HTML', () => {
  it('keeps marks and links, splits appearance the span model cannot hold, and flags equations', () => {
    const result = parseOneNoteInlineHtml(
      `a <span style='font-weight:bold;color:#1E4E79'>b</span><br><a href="https://example.test">c</a>`
      + `<a href="onenote:#x">d</a><!--[if mathML]><math><mi>x</mi></math><![endif]-->x`,
    );
    expect(result.spans.map((span) => span.text).join('')).toBe('a b\ncdx');
    expect(result.spans[1]).toMatchObject({ text: 'b', marks: [{ type: 'bold' }], style: { color: '#1e4e79' } });
    expect(result.spans.find((span) => span.text === 'c')?.marks).toEqual([{ type: 'link', href: 'https://example.test/' }]);
    expect(result.droppedUnsafeLink).toBe(true);
    expect(result.hadEquation).toBe(true);
  });
});

describe('OneNote desktop page conversion', () => {
  it('puts printout pages behind the handwriting as locked PDF pages linked to the original file', () => {
    const page = convertDesktopPageXml(parseXml(worksheetPageXml('assets/p.png', 'files/w.pdf')), { ...ASSETS, ink: WORKSHEET_INK });
    expect(page.title).toBe('Arbeitsblatt Brüche');
    const printouts = page.blocks.filter((block) => block.type === 'pdfPage');
    expect(printouts).toHaveLength(2);
    expect(printouts.map((block) => block.type === 'pdfPage' && [block.pageNumber, block.pageCount, block.originalResourceId]))
      .toEqual([[1, 2, 'files/w.pdf'], [2, 2, 'files/w.pdf']]);
    expect(page.blocks.slice(0, 2).every((block) => block.type === 'pdfPage')).toBe(true);
    // OneNote's title band above y = 86.4 pt is removed; the file icon at 86.4 pt now starts 24 px from the top.
    const attachment = page.blocks.find((block) => block.type === 'attachment');
    expect(attachment?.position?.y).toBeCloseTo(24);
    expect(printouts[0].position).toMatchObject({ x: 36 * POINTS_TO_PX, width: 595 * POINTS_TO_PX, height: 842 * POINTS_TO_PX });
    expect(printouts[0].position!.y! - attachment!.position!.y!).toBeCloseTo((160 - 86.4) * POINTS_TO_PX);
    expect(page.blocks.find((block) => block.type === 'attachment')).toMatchObject({ fileName: 'brueche.pdf' });
    expect(page.counts).toMatchObject({ printoutPages: 2, inkObjects: 2, inkStrokes: 3, attachments: 1 });
    expect(page.issues).toEqual([]);
  });

  it('reports printout pages that OneNote has not downloaded instead of importing empty pictures', () => {
    const page = convertDesktopPageXml(parseXml(worksheetPageXml('assets/empty.png', 'files/w.pdf')), {
      asset: (path) => (path === 'assets/empty.png'
        ? { resourceId: path, mediaType: 'image/png', bytes: 0 }
        : ASSETS.asset(path)),
      ink: WORKSHEET_INK,
    });
    expect(page.blocks.some((block) => block.type === 'pdfPage')).toBe(false);
    expect(page.issues).toEqual([expect.objectContaining({ code: 'resource-not-downloaded', severity: 'unsupported' })]);
    expect(page.counts.inkStrokes).toBe(3);
  });

  it('links printouts to a PDF that sits inside a text box', () => {
    const xml = worksheetPageXml('assets/p.png', 'files/w.pdf')
      .replace(/ xpsFileIndex="\d+"| originalPageNumber="\d+"|<one:Printout[^>]*\/>/g, '')
      .replace(/<one:InsertedFile([^>]*)>\s*<one:Position[^>]*\/><one:Size[^>]*\/>\s*<\/one:InsertedFile>/,
        '<one:Outline><one:Position x="36.0" y="86.4" z="0"/><one:Size width="200" height="40"/><one:OEChildren><one:OE><one:InsertedFile$1/></one:OE></one:OEChildren></one:Outline>');
    expect(xml).toContain('<one:OE><one:InsertedFile');
    const page = convertDesktopPageXml(parseXml(xml), { ...ASSETS, ink: WORKSHEET_INK });
    expect(page.blocks.filter((block) => block.type === 'pdfPage').map((block) => block.type === 'pdfPage' && block.originalResourceId))
      .toEqual(['files/w.pdf', 'files/w.pdf']);
  });

  it('links printouts to their file by document order when OneNote recorded no printout index', () => {
    const legacy = worksheetPageXml('assets/p.png', 'files/w.pdf')
      .replace(/ xpsFileIndex="\d+"| originalPageNumber="\d+"|<one:Printout[^>]*\/>/g, '');
    const page = convertDesktopPageXml(parseXml(legacy), { ...ASSETS, ink: WORKSHEET_INK });
    expect(page.blocks.filter((block) => block.type === 'pdfPage').map((block) => block.type === 'pdfPage' && block.pageNumber))
      .toEqual([1, 2]);
  });

  it('keeps ink at its ISF page coordinates and moves, never scales, ink that lies elsewhere', () => {
    const [handwriting, highlighter] = [WORKSHEET_INK.objects.i0, WORKSHEET_INK.objects.i1];
    // Within rounding of OneNote's position the points are used as they are.
    const exact = inkStrokesAt(handwriting, { x: 1002, y: 1999 });
    expect(exact[0].points[0]).toEqual({ x: 1000, y: 2000, pressure: 0.3 });
    const moved = inkStrokesAt(handwriting, { x: 160, y: 400 });
    expect(moved[0]).toMatchObject({ tool: 'pen', color: '#1f3a93', hasPressure: true, size: 2 });
    expect(moved[0].points[0]).toEqual({ x: 160, y: 400, pressure: 0.3 });
    expect(moved[0].points.at(-1)).toEqual({ x: 260, y: 440, pressure: 0.8 });
    // Constant pressure is mouse or finger ink, which Canvink simulates instead.
    expect(moved[1].hasPressure).toBe(false);
    const [band] = inkStrokesAt(highlighter, { x: 0, y: 0 });
    expect(band).toMatchObject({ tool: 'highlighter', size: 12, hasPressure: false });
    expect(band.opacity).toBeLessThan(1);
  });

  it('drops only pen samples that do not change the drawn stroke', () => {
    const line = Array.from({ length: 101 }, (_, index) => ({ x: index, y: 0, pressure: 0.5 }));
    expect(simplifyInkPoints(line, 2)).toEqual([line[0], line[100]]);
    const corner = [...line.slice(0, 51), ...Array.from({ length: 50 }, (_, index) => ({ x: 50, y: index + 1, pressure: 0.5 }))];
    expect(simplifyInkPoints(corner, 2).map((point) => [point.x, point.y])).toEqual([[0, 0], [50, 0], [50, 50]]);
    const pressing = line.map((point, index) => ({ ...point, pressure: index < 50 ? 0.2 : 0.9 }));
    expect(simplifyInkPoints(pressing, 2).length).toBeGreaterThan(2);
  });

  it('converts outlines into rich text with headings, lists, to-dos and tables, split around flow pictures and ink', () => {
    const page = convertDesktopPageXml(parseXml(notesPageXml('assets/p.png')), { ...ASSETS, ink: NOTES_INK });
    expect(page.title).toBe('Zusammenfassung & Übungen');
    expect(page.taskState).toBe('done');
    expect(page.tags).toContain('wichtig');
    const frames = page.blocks.filter((block) => block.type === 'textFrame');
    expect(frames).toHaveLength(2);
    const first = frames[0].type === 'textFrame' ? frames[0].blocks : [];
    expect(first.map((block) => block.type)).toEqual(['heading', 'paragraph', 'paragraph', 'list', 'list', 'checklist', 'table']);
    expect(first[1]).toMatchObject({ content: [{ text: 'Ein ' }, { text: 'Bruch', marks: [{ type: 'bold' }] }, { text: ' hat ' }, { text: 'Zähler', marks: [{ type: 'italic' }] }, { text: ' und ' }, { text: 'Nenner' }, { text: '.' }] });
    expect(first[2]).toMatchObject({ content: [{ text: 'Zweite Zeile' }] });
    expect(first[4]).toMatchObject({ ordered: true });
    expect(first[5]).toMatchObject({ items: [{ checked: true, content: [{ text: 'Serie 3 lösen' }] }] });
    expect(first[6]).toMatchObject({ rows: [[{ blocks: [{ content: [{ text: 'a' }, { text: '\n' }, { text: 'b' }] }] }, { blocks: [{ content: [{ text: 'a) ' }, { text: '1/2' }] }] }]] });
    // Text after the flow picture and ink continues below them.
    const picture = page.blocks.find((block) => block.type === 'image' && !block.background);
    const second = frames[1];
    expect(second.position!.y!).toBeGreaterThan(picture!.position!.y! + picture!.position!.height!);
    expect(page.blocks.find((block) => block.type === 'ink')).toBeDefined();
    // The picture set as background sits at x = -10pt, so the whole page is shifted right by 10pt.
    expect(page.blocks[0]).toMatchObject({ type: 'image', background: true, position: { x: 0 } });
    expect(frames[0].position!.x).toBeCloseTo(46 * POINTS_TO_PX);
    expect(page.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'style-dropped', 'list-nesting-flattened', 'layout-estimated', 'unsafe-url-dropped',
    ]));
  });
});

describe('OneNote desktop export import', () => {
  it('skips the hidden OneNote recycle bin group unless asked', async () => {
    const entries = await syntheticDesktopExport();
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    manifest.sections.push({
      id: '{S9}{1}{B0}',
      name: 'Gelöschte Seiten',
      groupPath: ['OneNote_RecycleBin'],
      pages: [{ id: '{P9}{1}{B0}', name: 'Weg', level: 1, error: 'gone' }],
    });
    entries.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
    const names = async (includeRecycleBin?: boolean) => {
      const acquisition = await openOneNoteDesktopExport(desktopExportFilesFromEntries(entries), { createdAt: CREATED_AT, includeRecycleBin });
      return acquisition.outline.notebooks[0].sections.map((section) => section.displayName);
    };
    expect(await names()).toEqual(['Mathe', 'Geschützt']);
    expect(await names(true)).toContain('Gelöschte Seiten');
  });

  it('reviews an export from its manifest alone and writes native Canvink elements page by page', async () => {
    const entries = await syntheticDesktopExport();
    const reads: string[] = [];
    const inner = desktopExportFilesFromEntries(entries);
    const files: DesktopExportFiles = { ...inner, read: (path) => { reads.push(path); return inner.read(path); } };
    const acquisition = await openOneNoteDesktopExport(files, { createdAt: CREATED_AT });
    // The review reads nothing but the manifest.
    expect(reads).toEqual(['manifest.json']);
    const [notebook] = acquisition.outline.notebooks;
    expect(notebook.sections.map((section) => [section.displayName, section.groupPath])).toEqual([
      ['Mathe', ['Semester 1']], ['Geschützt', undefined],
    ]);
    expect(notebook.sections[0].pages.map((page) => [page.title, page.level])).toEqual([
      ['Arbeitsblatt Brüche', 0], ['Zusammenfassung', 0], ['Ohne Titel', 1],
    ]);
    expect(acquisition.summary).toMatchObject({ sections: 2, pages: 4, pagesWithErrors: 1, images: 1, files: 1 });
    expect(acquisition.outline.warnings).toEqual([{ pageId: '{P4}{1}{B0}', message: 'The section is password protected.' }]);

    const { stage, result, target } = await importExport(files);
    expect(result.fidelity.find((report) => report.pageId === '{P4}{1}{B0}')?.status).toBe('unsupported');
    expect(result.pageTitles['{P2}{1}{B0}']).toBe('Zusammenfassung & Übungen');
    expect(result.stats).toMatchObject({ pages: 4, strokes: 4, assets: 2 });
    expect(stage.review.resourceTotalsExact).toBe(false);
    const [worksheet, notes, subpage] = target.pages;
    // OneNote's 12 pt squares become Canvink's squared paper with the same
    // spacing, and line settings that draw OneNote's line colour.
    expect(worksheet.background).toEqual({ type: 'grid', color: '#ffffff', spacing: 16, lineColor: '#81cffa', lineStrength: 'medium' });
    expect(ruleLineColor(worksheet.background)).toBe('rgba(129, 207, 250, 0.42)');
    expect(notes.background).toEqual({ type: 'plain', color: '#ffffff' });
    expect(target.notebook?.sections[0].color).toBe('#8aa8e4');
    expect(worksheet.createdAt).toBe('2026-03-02T08:00:00.000Z');
    expect(subpage.parentPageId).toBe(notes.pageId);
    const elements = (page: typeof worksheet): PageElementV3[] => page.zOrder.map((id) => page.elementsById[id]);
    const worksheetElements = elements(worksheet);
    expect(worksheetElements.slice(0, 2).map((element) => element.kind)).toEqual(['pdf', 'pdf']);
    expect(worksheetElements[0]).toMatchObject({ locked: true, sourcePageNumber: 1, pageCount: 2, sourceAvailability: 'original' });
    const strokes = worksheetElements.filter((element) => element.kind === 'stroke');
    expect(strokes).toHaveLength(3);
    expect(strokes[0]).toMatchObject({ tool: 'pen', color: '#1f3a93', locked: false });
    expect(strokes[0].kind === 'stroke' && strokes[0].points[0].pointerType).toBe('pen');
    expect(strokes[2]).toMatchObject({ tool: 'highlighter' });
    // Ink without pressure variation keeps an even width instead of speed-simulated pressure.
    expect(strokes[1].kind === 'stroke' && strokes[1].points.every((point) => point.pressure === 0.5 && point.pointerType === 'pen')).toBe(true);
    const text = elements(notes).find((element) => element.kind === 'richText');
    expect(text).toMatchObject({ style: { fontFamily: expect.stringContaining('Calibri'), fontSize: expect.closeTo(14.67, 1) } });
    expect(text?.kind === 'richText' && text.content.blocks.map((block) => block.type))
      .toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'checkItem', 'table']);
    expect(target.assets).toHaveLength(2);
  });

  it('refuses a page file that changed after the review', async () => {
    const inner = desktopExportFilesFromEntries(await syntheticDesktopExport());
    let changed = false;
    const files: DesktopExportFiles = {
      ...inner,
      read: async (path) => (changed && path === 'pages/0002.xml' ? new TextEncoder().encode('<changed/>') : inner.read(path)),
    };
    const acquisition = await openOneNoteDesktopExport(files, { createdAt: CREATED_AT });
    changed = true;
    const outline = acquisition.outline.notebooks[0].sections[0].pages[1];
    await expect(acquisition.reader.readPage(outline)).rejects.toThrow('changed after the review');
  });

  it('turns OneNote section groups into nested Canvink groups with stable ids and plain section titles', async () => {
    const regroup = (groups: Array<{ name: string; groupPath: string[] }>) => async () => {
      const entries = await syntheticDesktopExport();
      const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json'))) as OneNoteDesktopExportManifest;
      const [first, second] = manifest.sections;
      manifest.sections = groups.map((group, index) => ({
        ...(index === 0 ? first : { ...second, id: `{S${index + 1}}{1}{B0}`, pages: second.pages.map((page) => ({ ...page, id: `${page.id}-${index}` })) }),
        ...group,
      }));
      entries.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
      const acquisition = await openOneNoteDesktopExport(desktopExportFilesFromEntries(entries), { createdAt: CREATED_AT });
      const stage = await prepareOneNoteImportApplication({
        outline: acquisition.outline,
        source: acquisition.reader,
        target: new MemoryOneNoteApplyTarget(),
      });
      return { acquisition, notebook: stage.notebook };
    };
    const grouped = regroup([
      { name: 'Algebra', groupPath: ['Mathematik'] },
      { name: 'Physik', groupPath: ['z_Abgeschlossen', 'Naturwissenschaft'] },
      { name: 'Notizen', groupPath: [] },
      { name: 'Geometrie', groupPath: ['Mathematik'] },
    ]);
    const { acquisition, notebook } = await grouped();
    expect(acquisition.outline.notebooks[0].sections.map((section) => [section.displayName, section.groupPath])).toEqual([
      ['Algebra', ['Mathematik']],
      ['Physik', ['z_Abgeschlossen', 'Naturwissenschaft']],
      ['Notizen', undefined],
      ['Geometrie', ['Mathematik']],
    ]);

    const groups = notebook.sectionGroups ?? [];
    expect(groups.map((group) => group.title)).toEqual(['Mathematik', 'z_Abgeschlossen', 'Naturwissenschaft']);
    const [mathematik, abgeschlossen, naturwissenschaft] = groups;
    expect(mathematik.parentGroupId).toBeUndefined();
    expect(abgeschlossen.parentGroupId).toBeUndefined();
    expect(naturwissenschaft.parentGroupId).toBe(abgeschlossen.id);
    expect(notebook.sections.map((section) => [section.title, section.groupId])).toEqual([
      ['Algebra', mathematik.id],
      ['Physik', naturwissenschaft.id],
      ['Notizen', undefined],
      ['Geometrie', mathematik.id],
    ]);
    expect(notebook.sections[2]).not.toHaveProperty('groupId');

    // A second import of the same export names the same groups.
    const again = await grouped();
    expect(again.notebook.sectionGroups).toEqual(notebook.sectionGroups);
    expect(again.notebook.notebookId).toBe(notebook.notebookId);

    const flat = await regroup([{ name: 'Algebra', groupPath: [] }, { name: 'Physik', groupPath: [] }])();
    expect(flat.notebook).not.toHaveProperty('sectionGroups');
    expect(flat.notebook.sections.every((section) => !('groupId' in section))).toBe(true);
  });
});
