import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { RichTextToolbar } from './RichTextToolbar';
import { canvinkRichTextSchema as schema } from './schema';

function selectedStrongView(): EditorView {
  const strong = schema.marks.strong.create();
  const doc = schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(null, schema.text('Formatiert', [strong])),
  );
  const editorState = EditorState.create({ doc });
  const state = editorState.apply(
    editorState.tr.setSelection(TextSelection.create(doc, 1, doc.textContent.length + 1)),
  );
  return {
    state,
    dispatch: () => undefined,
    focus: () => undefined,
  } as unknown as EditorView;
}

describe('RichTextToolbar', () => {
  it('renders German-first controls, shortcut metadata, and active selection state', () => {
    const markup = renderToStaticMarkup(createElement(RichTextToolbar, {
      view: selectedStrongView(),
      editable: true,
      revision: 1,
    }));

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Text formatieren"');
    expect(markup).toContain('aria-label="Absatzformat"');
    expect(markup).toContain('Überschrift 6');
    expect(markup).toContain('aria-label="Fett"');
    expect(markup).toContain('aria-keyshortcuts="Control+B Meta+B"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Checkpunkt einfügen');
    expect(markup).toContain('aria-label="Tabelle einfügen"');
    // Row and column actions only appear while the caret is inside a table.
    expect(markup).not.toContain('Zeile danach einfügen');
  });

  it('offers row and column actions when the caret is in a table', () => {
    const cell = () => schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text('Zelle')));
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell(), cell()])]),
    );
    const editorState = EditorState.create({ doc });
    const state = editorState.apply(editorState.tr.setSelection(TextSelection.create(doc, 4)));
    const view = { state, dispatch: () => undefined, focus: () => undefined } as unknown as EditorView;
    const markup = renderToStaticMarkup(createElement(RichTextToolbar, { view, editable: true }));

    expect(markup).toContain('Zeile danach einfügen');
    expect(markup).toContain('Spalte danach einfügen');
  });

  it('keeps viewer controls read-only and announces why formatting is unavailable', () => {
    const markup = renderToStaticMarkup(createElement(RichTextToolbar, {
      view: selectedStrongView(),
      editable: false,
    }));

    expect(markup).toContain('Nur Lesen: Formatierung ist deaktiviert.');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('<form');
  });
});
