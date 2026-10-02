import { describe, expect, it } from 'vitest';
import { buildDocx } from './docx';

/** Reads the stored (uncompressed) ZIP entries written by writeStoredZip. */
function storedEntries(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength;
    entries.set(name, decoder.decode(bytes.subarray(start, start + size)));
    offset = start + size;
  }
  return entries;
}

describe('buildDocx', () => {
  it('packages a Word document with styles, numbering, links and escaped text', () => {
    const entries = storedEntries(buildDocx([
      { kind: 'title', text: 'Physik <Kräfte> & Bewegung', subtitle: '24.09.2026' },
      { kind: 'rich', block: { id: 'h', type: 'heading', level: 2, spans: [{ text: 'Newton', marks: [] }] } },
      { kind: 'rich', block: { id: 'b', type: 'paragraph', list: 'bullet', spans: [{ text: 'F = m·a', marks: [{ type: 'bold' }] }] } },
      { kind: 'rich', block: { id: 'c', type: 'checkItem', checked: true, spans: [{ text: 'Aufgabe 3', marks: [] }] } },
      { kind: 'rich', block: { id: 'l', type: 'paragraph', spans: [{ text: 'Skript', marks: [{ type: 'link', href: 'https://example.ch/skript' }] }] } },
      { kind: 'rich', block: { id: 't', type: 'table', rows: [[[{ text: 'Fach', marks: [] }], [{ text: 'Aufgabe', marks: [] }]], [[{ text: 'Mt', marks: [] }], []]] } },
    ]));

    expect([...entries.keys()]).toEqual(expect.arrayContaining([
      '[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels',
    ]));
    const document = entries.get('word/document.xml') ?? '';
    expect(document).toContain('Physik &lt;Kräfte&gt; &amp; Bewegung');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('☑');
    expect(document.match(/<w:tc>/g)).toHaveLength(4);
    expect(entries.get('word/_rels/document.xml.rels')).toContain('Target="https://example.ch/skript" TargetMode="External"');
  });

  it('restarts numbering for each separate numbered list', () => {
    const item = (id: string) => ({ kind: 'rich' as const, block: { id, type: 'paragraph' as const, list: 'ordered' as const, spans: [{ text: id, marks: [] }] } });
    const entries = storedEntries(buildDocx([
      item('a'), item('b'),
      { kind: 'rich', block: { id: 'p', type: 'paragraph', spans: [{ text: 'dazwischen', marks: [] }] } },
      item('c'),
    ]));
    const document = entries.get('word/document.xml') ?? '';
    expect(document.match(/<w:numId w:val="11"\/>/g)).toHaveLength(2);
    expect(document.match(/<w:numId w:val="12"\/>/g)).toHaveLength(1);
    expect(entries.get('word/numbering.xml')).toContain('<w:num w:numId="12">');
  });
});
