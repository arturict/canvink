# Canvink rich text

Canvink's production rich-text boundary is `src/editor/richText`. It binds a ProseMirror document to one stable string path in an Automerge Repo `DocHandle` using `@automerge/prosemirror` 0.2.0.

## Schema and interoperability

The adapter uses the standard Automerge names `paragraph`, `heading`, `ordered-list-item`, `unordered-list-item`, `strong`, `em`, and `link`. Canvink-specific constructs use collision-resistant names:

- Marks: `__ext__canvink_inline-code`, `__ext__canvink_underline`, and `__ext__canvink_strike`.
- Blocks: `__ext__canvink_check-item`, `__ext__canvink_table`, `__ext__canvink_table-row`, `__ext__canvink_table-cell`, and `__ext__canvink_table-header`.

The ProseMirror schema key and Automerge mark name are intentionally identical for all three extension marks. Version 0.2.0 sometimes uses the ProseMirror name directly for mark operations, so aliases would make add/remove behavior inconsistent.

Checklist blocks persist `checked` and `blockId`. Tables use the node specifications and commands from `prosemirror-tables`; cells retain colspan, rowspan, and column-width attributes. Unknown Automerge blocks, attributes, and marks use the binding's unknown-content nodes and round trip without being flattened.

## Commands and safety

The module exports commands for paragraphs, six heading levels, standard and extension marks, toggleable bullet/ordered lists, checklist insertion/toggling, table insertion, and row/column operations. Key bindings include conventional bold, italic, underline, inline-code, strike, bullet/numbered/check lists, checklist completion, undo/redo, list indentation, and block splitting.

Links accept only absolute `https:`, `http:`, and `mailto:` URLs, with bounded href/title lengths. Invalid pasted or remote links render as inert text; malicious `javascript:` and `data:` links never become clickable DOM anchors.

## Visible toolbar

Every mounted `RichTextEditor` renders one contextual, German-first toolbar backed directly by the current `EditorView` selection. It exposes paragraph/H1-H6 selection, bold, italic, underline, strike, inline code, bullet and numbered lists, checklist insertion and completion, safe link editing/unlinking, 2×2 table insertion, and row/column deletion or insertion. Table actions remain disabled until the selection is inside a table.

Buttons expose pressed state, native disabled state, German labels, shortcut metadata, tooltips, and a polite status message. The toolbar preserves the ProseMirror selection when buttons are pressed. Link editing uses an inline labelled form; it never calls `window.prompt`, and unsafe addresses are rejected before a transaction is dispatched. Read-only viewers can focus and inspect the editor but every mutating control remains disabled.

The toolbar stores only transient UI concerns such as whether the link form is open. Formatting, selection-derived state, tables, and checklist values remain authoritative at the existing Automerge string path. Component/command tests cover labels, read-only state, active marks, safe links, list toggling, and table operations. The browser scenario formats content, adds a table row and column, reloads it, and verifies that later editing sessions retain the exact formatting, table dimensions, and cell content.

## Projections

ProseMirror documents project to the schema-v2 `RichTextDocument`, plain text, Markdown, and normalized search text. The portable-v2 projection supports headings, paragraphs, marks, lists, check items, and table cell content. Unknown top-level ProseMirror blocks can be carried in the `PortableRichTextProjection.unknownBlocks` sidecar and restored exactly.

Two intentional v2-format limitations remain:

- `RichTextBlock.table.rows` has no header metadata, colspan, rowspan, or column-width fields. Automerge and ProseMirror preserve those details, but the current portable v2 table projection cannot.
- The plain-text, Markdown, and search forms are derived projections, not authoritative collaborative data. Markdown underline uses `<u>` because CommonMark has no underline syntax.

## Live CRDT authority and migration

Portable `RichTextElementV2.content` exists only at import/export and migration
boundaries. A live page stores no copy of that structure: its canonical value
is the Automerge rich-text string at `elementsById[elementId].text`. Document
heads likewise remain external to the live root.

V1 materialization runs `portableToProseMirror`, `pmNodeToSpans`, and
`Automerge.updateSpans` for every rich-text element, then reloads the binary and
compares reconstructed portable semantics. Explicit block markers preserve
stable paragraph IDs. List item IDs are carried as preserved Automerge block
attributes because the binding's standard list mapping owns the item marker.
Tests cover embedded and trailing blank lines, lists, checklist state, marks,
stable paths, and two-actor convergence.

## React lifecycle

`RichTextEditor` accepts a ready Repo handle and a path containing only string keys and integer indexes. It derives path identity by value, so a parent recreating an equivalent array does not tear down the editor. The component mounts one `EditorView`, attaches the binding plugin, and destroys the view on handle/path/options changes or unmount. `EditorView.destroy()` invokes the sync plugin's cleanup and removes its `change` listener.

Call `handle.whenReady()` in the owning repository layer before rendering, or pass `ready={false}` until it resolves. The component intentionally does not mutate the document to create a missing path. A missing/non-string path is reported through `onError` rather than silently replacing content.

Local undo uses ProseMirror history. The installed binding tags remote patch transactions with `addToHistory: false`, so undo does not revert another collaborator's change. This behavior is part of the beta binding implementation and must be revalidated on every dependency upgrade.

## Beta boundary

`@automerge/prosemirror` 0.2.0 declares itself beta quality. Canvink therefore pins the exact version, tests schema/span round trips and concurrent edits, and keeps all binding-specific code behind this module. `syncPluginCompat` retains the package's granular ProseMirror-to-Automerge writer for formatting, block changes and text next to marks, and splices plain text edits inside one block (a keystroke, a backspace) into the Automerge text directly, at the position taken from the editor's own document: the stock writer reads all spans of the text before and after every step, in time proportional to the text. A randomised test compares both writers. It also uses a canonical, minimal document diff for incoming handle changes; this avoids the beta reconciler mutating immutable Automerge block-name strings during paragraph-to-heading changes. Upgrade work must rerun custom-mark, unknown-content, table, concurrency, history, and lifecycle tests before changing the pin.

Tables persist the table, every row, and every cell/header as explicit Automerge blocks with stable `blockId` attributes. This gives adjacent rows distinct block boundaries even when their schema parent paths are identical. New, pasted, and `prosemirror-tables`-generated nodes receive identities before synchronization. On opening older ambiguous spans, header-first tables are repaired deterministically from their header width; if an all-body-cell legacy table has no recoverable row-width signal, every cell is retained in one row rather than guessed or discarded. The repaired explicit form is written back once. Repo close/reopen tests cover exact 3×3 dimensions and cell content, and two-actor tests cover concurrent edits in cells on different rows.
