import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { adoptSourceChunks, loadSourceTransaction, parseMarkdown, serializeMarkdown } from './markdownConvert';
import { markdownSchema } from './markdownSchema';

const canonical: Record<string, string> = {
  heading1: '# Titel\n',
  heading3: '### Klein\n',
  paragraph: 'Ein Absatz mit **fett**, *kursiv*, `code` und ~~durchgestrichen~~.\n',
  link: 'Siehe [Canvink](https://example.com/a "Titel") oder <https://example.com>.\n',
  bullets: '- eins\n- zwei\n- drei\n',
  loose: '- eins\n\n- zwei\n',
  numbered: '1. eins\n2. zwei\n',
  numberedFrom: '3. drei\n4. vier\n',
  nested: '- eins\n  - innen\n- zwei\n',
  todos: '- [ ] offen\n- [x] erledigt\n',
  quote: '> Zitat\n> zweite Zeile\n',
  quoteWithList: '> Liste\n>\n> - a\n> - b\n',
  code: '```ts\nconst a = 1;\n\nconst b = 2;\n```\n',
  rule: '---\n',
  table: '| Name | Wert |\n| --- | ---: |\n| a | 1 |\n| b | 2 |\n',
  aligned: '| L | M | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n',
  hardBreak: 'Zeile eins\\\nZeile zwei\n',
  softBreak: 'Zeile eins\nZeile zwei\n',
  mixed: '# Titel\n\nText\n\n- a\n- b\n\n> Zitat\n\n```\ncode\n```\n\n---\n\nEnde\n',
};

describe('Markdown conversion', () => {
  it.each(Object.entries(canonical))('round-trips %s through the serializer alone', (_name, source) => {
    const doc = parseMarkdown(source);
    const written = serializeMarkdown(doc, { keepSource: false });
    expect(written).toBe(source);
    expect(parseMarkdown(written).eq(doc)).toBe(true);
  });

  it.each(Object.entries(canonical))('writes %s back unchanged when nothing was edited', (_name, source) => {
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  const messy = [
    '#Kein Heading\n\nSetext\n=====\n\n* stern\n+ plus\n\n1) klammer\n\n    eingerueckt\n\n~~~\ntilde\n~~~\n\n__fett__ und _kursiv_\n',
    'Text mit \\* Escapes \\[x\\] und snake_case_name und 2 * 3\n',
    '- [ ] Aufgabe\n  - [ ] verschachtelt\n- normal\n',
    '* * *\n\n___\n',
    '\n\n\nDrei Leerzeilen davor\n\n\n\nund vier dazwischen\n\n\n',
    'Ohne Zeilenende am Schluss',
    'Windows\r\nZeilen\r\n',
  ];

  it.each(messy)('normalizes to a stable form without changing the parsed document: %j', (source) => {
    const doc = parseMarkdown(source);
    const normalized = serializeMarkdown(doc, { keepSource: false });
    const reparsed = parseMarkdown(normalized);
    expect(reparsed.eq(doc)).toBe(true);
    expect(serializeMarkdown(reparsed, { keepSource: false })).toBe(normalized);
  });

  it.each(messy)('opening does not rewrite the source: %j', (source) => {
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source.replaceAll('\r\n', '\n'));
  });

  it('escapes text so that it reads back as the same text', () => {
    const samples = [
      '# kein Titel', '- kein Punkt', '1. keine Liste', '> kein Zitat', '* Stern', '+ Plus',
      'a *b* c', 'a_b_c und _x_', '[Link](x) und [x]', '`Code`', '~~x~~', '<div>Tag</div>', '&amp; &copy;',
      'Pfad C:\\temp\\x', '| Pipe |', '```', 'Zeile\n# Titel danach',
    ];
    for (const text of samples) {
      const doc = markdownSchema.nodes.doc.create(null, markdownSchema.nodes.paragraph.create(null, markdownSchema.text(text)));
      const written = serializeMarkdown(doc, { keepSource: false });
      const reparsed = parseMarkdown(written);
      expect(reparsed.firstChild?.textContent, `${JSON.stringify(text)} -> ${JSON.stringify(written)}`).toBe(text);
      expect(reparsed.childCount).toBeGreaterThanOrEqual(1);
      expect(reparsed.firstChild?.type.name).toBe('paragraph');
    }
  });

  it('escapes pipes inside table cells', () => {
    const doc = parseMarkdown('| a | b |\n| --- | --- |\n| x \\| y | `p\\|q` |\n');
    expect(doc.firstChild?.textContent).toContain('x | y');
    expect(serializeMarkdown(doc, { keepSource: false })).toBe('| a | b |\n| --- | --- |\n| x \\| y | `p\\|q` |\n');
  });

  it('reads a to-do list as check items and a mixed list as a list', () => {
    expect(parseMarkdown('- [ ] a\n- [x] b\n').childCount).toBe(2);
    const checked = parseMarkdown('- [ ] a\n- [x] b\n');
    expect(checked.child(0).type.name).toBe('check_item');
    expect(checked.child(1).attrs.checked).toBe(true);
    expect(parseMarkdown('- [ ] a\n- b\n').firstChild?.type.name).toBe('bullet_list');
  });

  it('keeps a trailing paragraph to type on after the last block without writing it', () => {
    const doc = parseMarkdown('```\ncode\n```\n');
    expect(doc.lastChild?.type.name).toBe('paragraph');
    expect(doc.lastChild?.content.size).toBe(0);
    expect(serializeMarkdown(doc)).toBe('```\ncode\n```\n');
  });

  it('turns an empty source into one empty paragraph', () => {
    const doc = parseMarkdown('');
    expect(doc.childCount).toBe(1);
    expect(serializeMarkdown(doc)).toBe('');
  });
});

describe('neighbouring lists stay separate lists', () => {
  it('does not merge a list with the to-dos written after it', () => {
    const doc = parseMarkdown('- a\n- b\n');
    const todos = parseMarkdown('- [ ] c\n- [x] d\n');
    const joined = doc.type.create(null, [doc.child(0), todos.child(0), todos.child(1)]);
    const written = serializeMarkdown(joined, { keepSource: false });
    expect(written).toBe('- a\n- b\n\n* [ ] c\n* [x] d\n');
    expect(parseMarkdown(written).eq(joined)).toBe(true);
  });

  it('does not merge to-dos with the list written after them, or two lists in a row', () => {
    const list = parseMarkdown('- a\n').child(0);
    const todo = parseMarkdown('- [ ] c\n').child(0);
    const first = markdownSchema.nodes.doc.create(null, [todo, list, list.copy(list.content)]);
    const written = serializeMarkdown(first, { keepSource: false });
    expect(written).toBe('- [ ] c\n\n* a\n\n- a\n');
    const reparsed = parseMarkdown(written);
    expect(reparsed.content.toJSON().map((node: { type: string }) => node.type)).toEqual(['check_item', 'bullet_list', 'bullet_list']);
    expect(serializeMarkdown(reparsed, { keepSource: false })).toBe(written);
  });
});

describe('Markdown the editor does not model', () => {
  const html = '<details>\n<summary>Mehr</summary>\n\nText\n\n</details>';
  const definitions = '[ref]: https://example.com/ref "Titel"\n[^1]: Fussnote zu diesem Text.';
  const source = `# Notiz\n\n${html}\n\nBild ![Diagramm](bild.png "T") und <span>inline</span> Html[^1] mit [Link][ref].\n\n${definitions}\n\n<!-- Kommentar -->\n`;

  it('shows HTML blocks and definitions as inert raw blocks', () => {
    const doc = parseMarkdown(source);
    const raw = [] as string[];
    doc.forEach((node) => {
      if (node.type.name === 'raw_block') raw.push(String(node.attrs.text));
    });
    expect(raw).toContain('<details>\n<summary>Mehr</summary>');
    expect(raw).toContain('[ref]: https://example.com/ref "Titel"');
    expect(raw).toContain('[^1]: Fussnote zu diesem Text.');
    expect(raw).toContain('<!-- Kommentar -->');
  });

  it('writes everything back unchanged when nothing is edited', () => {
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  it('keeps every unsupported part when another paragraph is edited', () => {
    const doc = parseMarkdown(source);
    let state = EditorState.create({ doc });
    // Type into the heading, the only block the user touches.
    state = state.apply(state.tr.insertText(' neu', 6));
    const written = serializeMarkdown(state.doc);
    expect(written).toBe(source.replace('# Notiz', '# Notiz neu'));
    expect(written).toContain(html);
    expect(written).toContain(definitions);
    expect(written).toContain('![Diagramm](bild.png "T")');
    expect(written).toContain('<span>inline</span>');
  });

  it('keeps images, inline HTML and links when the paragraph holding them is edited', () => {
    const doc = parseMarkdown(source);
    let paragraphStart = -1;
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph' && node.textContent.startsWith('Bild')) paragraphStart = offset;
    });
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.insertText('Neu: ', paragraphStart + 1));
    const written = serializeMarkdown(state.doc);
    expect(written).toContain('Neu: Bild ![Diagramm](bild.png "T") und <span>inline</span> Html');
    expect(written).toContain('Html[^1] mit [Link](https://example.com/ref "Titel")');
    expect(written).toContain(definitions);
    expect(written).toContain(html);
  });

  it('keeps source it cannot parse as a raw block instead of dropping it', () => {
    const doc = parseMarkdown('[a]: /x\n\n[b]: /y\n');
    expect(serializeMarkdown(doc)).toBe('[a]: /x\n\n[b]: /y\n');
    expect(serializeMarkdown(doc, { keepSource: false })).toBe('[a]: /x\n\n[b]: /y\n');
  });

  it('gives a loaded document the source memory of the parsed one', () => {
    const parsed = parseMarkdown('# A\n\n\n\nText\n');
    const current = parseMarkdown('# A\n\n\n\nText\n');
    // A state whose nodes are different objects than the parsed ones.
    const rebuilt = markdownSchema.nodes.doc.create(null, current.content);
    adoptSourceChunks(rebuilt, parsed);
    expect(serializeMarkdown(rebuilt)).toBe('# A\n\n\n\nText\n');
  });
});

describe('loading a source that came from elsewhere', () => {
  const before = '# Titel\n\nErster Absatz\n\nZweiter Absatz\n';

  function stateWithCaretIn(text: string, offset: number): EditorState {
    const doc = parseMarkdown(before);
    let position = 0;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === text) position = pos + offset;
    });
    const state = EditorState.create({ doc });
    return state.apply(state.tr.setSelection(TextSelection.create(doc, position)));
  }

  function load(state: EditorState, source: string): EditorState {
    const { transaction, parsed } = loadSourceTransaction(state, source);
    if (!transaction) throw new Error('The source should differ from the document.');
    const next = state.apply(transaction);
    adoptSourceChunks(next.doc, parsed);
    return next;
  }

  it('keeps the caret in place when text before it changes', () => {
    let state = stateWithCaretIn('Zweiter Absatz', 7);
    const after = '# Neuer Titel\n\nErster Absatz\n\nZweiter Absatz\n';
    state = load(state, after);
    expect(state.doc.eq(parseMarkdown(after))).toBe(true);
    expect(state.selection.$from.parent.textContent).toBe('Zweiter Absatz');
    expect(state.selection.$from.parentOffset).toBe(7);
    expect(serializeMarkdown(state.doc)).toBe(after);
  });

  it('keeps the caret when a block is added or removed elsewhere', () => {
    let state = stateWithCaretIn('Erster Absatz', 3);
    const after = '# Titel\n\nErster Absatz\n';
    state = load(state, after);
    expect(state.selection.$from.parentOffset).toBe(3);
    expect(state.selection.$from.parent.textContent).toBe('Erster Absatz');
    expect(serializeMarkdown(state.doc)).toBe(after);
  });

  it('does nothing when the document already shows the source', () => {
    const state = stateWithCaretIn('Erster Absatz', 3);
    expect(loadSourceTransaction(state, before).transaction).toBeNull();
  });

  it('does not put the loaded change into the undo history', () => {
    const state = stateWithCaretIn('Erster Absatz', 3);
    const { transaction } = loadSourceTransaction(state, `${before}Neu\n`);
    expect(transaction?.getMeta('addToHistory')).toBe(false);
  });
});
