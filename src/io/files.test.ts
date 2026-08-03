import { describe, expect, it } from 'vitest';
import { createDefaultWorkspace } from '../domain/sample';
import { activatePage, getActiveContext } from '../domain/workspace';
import type {
  ImageElement,
  Notebook,
  Page,
  Section,
  TrashEntry,
} from '../domain/types';
import {
  createPagePdf,
  markdownToPage,
  pointsToBounds,
  validateWorkspaceAssetPreviews,
} from './files';

describe('portable files', () => {
  it('turns Markdown into an editable page', () => {
    const page = markdownToPage('# Imported\n\nA note.', 'sample.md');
    expect(page.title).toBe('sample');
    expect(page.elements[0]).toMatchObject({ kind: 'text', text: '# Imported\n\nA note.' });
  });

  it('computes pressure-sample bounds without mutating them', () => {
    const workspace = createDefaultWorkspace();
    const notebook = workspace.notebooks[0];
    const section = notebook.sections.find((item) => item.title === 'Examples')!;
    const page = section.pages.find((item) => item.title === 'Start here')!;
    const context = getActiveContext(
      activatePage(workspace, notebook.id, section.id, page.id),
    )!;
    const stroke = context.page.elements.find((element) => element.kind === 'stroke');
    expect(stroke?.kind).toBe('stroke');
    if (!stroke || stroke.kind !== 'stroke') return;

    const before = structuredClone(stroke.points);
    expect(pointsToBounds(stroke.points)).toMatchObject({ minX: 94, maxX: 308 });
    expect(stroke.points).toEqual(before);
  });

  it('embeds image objects in vector PDF output', async () => {
    const context = getActiveContext(createDefaultWorkspace())!;
    const now = new Date().toISOString();
    const image: ImageElement = {
      id: 'pdf-export-image',
      kind: 'image',
      x: 40,
      y: 40,
      width: 100,
      height: 100,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      name: 'pixel.png',
      alt: 'Pixel',
      createdAt: now,
      updatedAt: now,
    };
    context.page.elements = [image];

    const pdf = await createPagePdf(context);
    const bytes = new Uint8Array(pdf.output('arraybuffer'));
    const contents = new TextDecoder('latin1').decode(bytes);

    expect(contents).toContain('/Subtype /Image');
  });

  it('fails PDF export instead of silently dropping an unsupported image', async () => {
    const context = getActiveContext(createDefaultWorkspace())!;
    const now = new Date().toISOString();
    context.page.elements = [
      {
        id: 'unsupported-pdf-image',
        kind: 'image',
        x: 40,
        y: 40,
        width: 100,
        height: 100,
        dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
        name: 'unsupported.svg',
        alt: 'Unsupported image',
        createdAt: now,
        updatedAt: now,
      },
    ];

    await expect(createPagePdf(context)).rejects.toThrow(
      'Unsupported PDF image preview format.',
    );
  });

  it.each(['element', 'page', 'section', 'notebook'] as const)(
    'rejects invalid image previews inside a trashed %s',
    async (kind) => {
      const workspace = createDefaultWorkspace();
      const now = new Date().toISOString();
      const invalidImage: ImageElement = {
        id: `bad-image-${kind}`,
        kind: 'image',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        dataUrl: 'data:image/png;base64,not-valid-base64',
        name: 'invalid.png',
        alt: '',
        createdAt: now,
        updatedAt: now,
      };
      const page: Page = {
        id: `trash-page-${kind}`,
        title: 'Trashed page',
        mode: 'free',
        createdAt: now,
        updatedAt: now,
        elements: [invalidImage],
      };
      const section: Section = {
        id: `trash-section-${kind}`,
        title: 'Trashed section',
        createdAt: now,
        updatedAt: now,
        pages: [page],
      };
      const notebook: Notebook = {
        id: `trash-notebook-${kind}`,
        title: 'Trashed notebook',
        color: '#d7653b',
        createdAt: now,
        updatedAt: now,
        sections: [section],
      };
      const items = {
        element: invalidImage,
        page,
        section,
        notebook,
      };
      const entry: TrashEntry = {
        id: `trash-${kind}`,
        kind,
        deletedAt: now,
        origin: {},
        item: items[kind],
      };
      workspace.trash = [entry];

      await expect(validateWorkspaceAssetPreviews(workspace)).rejects.toThrow(
        'invalid base64 data',
      );
    },
  );
});
