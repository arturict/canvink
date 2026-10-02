import { describe, expect, it } from 'vitest';
import { convertOneNoteHtml } from './onenoteHtml';
import type { GraphResourceInput } from './types';

const resources: GraphResourceInput[] = [
  {
    id: 'image-1',
    contentUrl: 'https://graph.microsoft.com/v1.0/me/onenote/resources/image-1/content',
    mediaType: 'image/png',
    fileName: 'diagram.png',
    byteLength: 120,
  },
  {
    id: 'file-1',
    contentUrl: 'https://graph.microsoft.com/v1.0/me/onenote/resources/file-1/content',
    mediaType: 'application/pdf',
    fileName: 'worksheet.pdf',
    byteLength: 900,
  },
];

describe('convertOneNoteHtml', () => {
  it('preserves allowlisted rich content, lists, checklists, and tables', () => {
    const result = convertOneNoteHtml(`
      <html><head><title>Ignored title</title></head><body>
        <h2>Newton's <strong>laws</strong></h2>
        <p>Use <em>vectors</em>, <u>units</u>, and <a href="https://example.edu/reference">a reference</a>.</p>
        <ul><li>Force</li><li>Mass</li></ul>
        <ol start="3"><li>Acceleration</li></ol>
        <ul><li data-tag="to-do">Read</li><li data-tag="to-do:completed">Practice</li></ul>
        <table><thead><tr><th>Symbol</th><th>Unit</th></tr></thead><tbody><tr><td rowspan="2">F</td><td>N</td></tr></tbody></table>
      </body></html>
    `, resources);

    expect(result.issues).toEqual([]);
    expect(result.blocks.map((block) => block.type)).toEqual([
      'heading', 'paragraph', 'list', 'list', 'checklist', 'table',
    ]);
    expect(result.blocks[0]).toMatchObject({
      type: 'heading',
      level: 2,
      content: [
        { text: "Newton's ", marks: [] },
        { text: 'laws', marks: [{ type: 'bold' }] },
      ],
    });
    expect(result.blocks[1]).toMatchObject({
      type: 'paragraph',
      content: expect.arrayContaining([
        { text: 'vectors', marks: [{ type: 'italic' }] },
        { text: 'units', marks: [{ type: 'underline' }] },
        { text: 'a reference', marks: [{ type: 'link', href: 'https://example.edu/reference' }] },
      ]),
    });
    expect(result.blocks[3]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(result.blocks[4]).toMatchObject({
      type: 'checklist',
      items: [
        { checked: false, content: [{ text: 'Read', marks: [] }] },
        { checked: true, content: [{ text: 'Practice', marks: [] }] },
      ],
    });
    expect(result.blocks[5]).toMatchObject({
      type: 'table',
      rows: [
        [{ header: true }, { header: true }],
        [{ header: false, rowSpan: 2, colSpan: 1 }, { header: false }],
      ],
    });
  });

  it('resolves only supplied Graph resources and preserves spatial metadata', () => {
    const result = convertOneNoteHtml(`
      <body>
        <div data-id="container-1" style="position:absolute;left:120px;top:40px;width:360px;height:240px;z-index:2">
          <img data-fullres-src="https://graph.microsoft.com/v1.0/me/onenote/resources/image-1/$value"
               src="https://graph.microsoft.com/v1.0/me/onenote/resources/image-1/content"
               data-fullres-src-type="image/png" alt="force diagram" width="300" height="180" />
          <object data="https://graph.microsoft.com/v1.0/me/onenote/resources/file-1/$value"
                  data-attachment="forces.pdf" type="application/pdf" style="position:absolute;left:8px;top:190px" />
        </div>
      </body>
    `, resources);

    expect(result.issues).toEqual([]);
    expect(result.blocks).toMatchObject([{
      type: 'spatialGroup',
      sourceId: 'container-1',
      position: { x: 120, y: 40, width: 360, height: 240, zIndex: 2 },
      blocks: [
        { type: 'image', resourceId: 'image-1', mediaType: 'image/png', alt: 'force diagram', position: { width: 300, height: 180 } },
        { type: 'attachment', resourceId: 'file-1', mediaType: 'application/pdf', fileName: 'forces.pdf', position: { x: 8, y: 190 } },
      ],
    }]);
  });

  it('drops executable content, event handlers, unsafe URLs, and non-allowlisted styles', () => {
    const result = convertOneNoteHtml(`
      <body onload="steal()">
        <script>secretScriptPayload()</script>
        <iframe src="https://attacker.invalid">secretFramePayload</iframe>
        <p onclick="steal()" style="background-image:url(javascript:steal());position:fixed;left:expression(1)">
          Safe <a href="javascript:steal()">link text</a>
        </p>
        <img src="data:image/svg+xml,&lt;svg onload=steal()&gt;" />
        <object data="https://attacker.invalid/file" data-attachment="bad.exe" type="application/octet-stream" />
      </body>
    `, resources);

    const serialized = JSON.stringify(result.blocks);
    expect(serialized).not.toContain('secretScriptPayload');
    expect(serialized).not.toContain('secretFramePayload');
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('background-image');
    expect(result.blocks).toMatchObject([{ type: 'paragraph', content: [{ text: 'Safe link text', marks: [] }] }]);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'unsupported-element',
      'style-dropped',
      'invalid-position',
      'unsafe-url-dropped',
      'image-resource-missing',
      'attachment-resource-missing',
    ]));
  });

  it('fails closed when parser limits are exceeded', () => {
    const result = convertOneNoteHtml('<p>123456789</p>', resources, { maxHtmlBytes: 8 });
    expect(result.blocks).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'content-limit-exceeded', severity: 'unsupported' })]);
  });

  it('keeps media nested in a paragraph while sanitizing attachment display names', () => {
    const result = convertOneNoteHtml(`
      <p>Diagram:
        <img src="https://graph.microsoft.com/v1.0/me/onenote/resources/image-1/content" alt="diagram" />
        <object data="https://graph.microsoft.com/v1.0/me/onenote/resources/file-1/content" data-attachment="../../worksheet.pdf" />
      </p>
    `, resources);

    expect(result.blocks.map((block) => block.type)).toEqual(['paragraph', 'image', 'attachment']);
    expect(result.blocks[2]).toMatchObject({ type: 'attachment', fileName: '.._.._worksheet.pdf' });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unsafe-file-name' }));
  });

  it('normalizes OneNote data-tag variants into page tags, task state, and checklists', () => {
    const result = convertOneNoteHtml(`
      <body>
        <p data-tag="To_Do">Open task</p>
        <p data-tag="todo:done, IMPORTANT; Customer Follow Up">Done task</p>
        <ul><li data-tag="task:checked">Checked list item</li></ul>
      </body>
    `, resources);

    expect(result.blocks).toMatchObject([
      { type: 'checklist', items: [{ checked: false }] },
      { type: 'checklist', items: [{ checked: true }] },
      { type: 'checklist', items: [{ checked: true }] },
    ]);
    expect(result.tags).toEqual(['important', 'onenote:customer-follow-up', 'todo']);
    expect(result.taskState).toBe('open');
    expect(result.issues).toEqual([]);
  });

  it('reports a data-tag that cannot be normalized safely', () => {
    const result = convertOneNoteHtml('<p data-tag="☃">Keep the text</p>', resources);
    expect(result.blocks).toMatchObject([{ type: 'paragraph', content: [{ text: 'Keep the text' }] }]);
    expect(result.tags).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'data-tag-unsupported',
      severity: 'simplified',
    }));
  });
});
