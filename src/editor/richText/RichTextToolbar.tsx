import { useState, type FormEvent, type MouseEvent } from 'react';
import {
  Bold,
  CheckCheck,
  Code,
  Italic,
  Link,
  List,
  ListOrdered,
  SquareCheck,
  Strikethrough,
  Table,
  Underline,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import type { MarkType, NodeType } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { useI18n, type TranslationKey, type TranslationParameters } from '../../i18n';
import {
  insertCheckItem,
  insertTable,
  listCommands,
  removeLink,
  richTextTableCommands,
  setHeading,
  setLink,
  setParagraph,
  toggleEmphasis,
  toggleCurrentCheckItem,
  toggleInlineCode,
  toggleStrike,
  toggleStrong,
  toggleUnderline,
} from './commands';
import {
  INLINE_CODE_MARK,
  STRIKE_MARK,
  UNDERLINE_MARK,
  safeLink,
} from './schema';

export interface RichTextToolbarSnapshot {
  block: 'paragraph' | `heading-${number}` | 'other';
  strong: boolean;
  emphasis: boolean;
  underline: boolean;
  strike: boolean;
  inlineCode: boolean;
  bulletList: boolean;
  orderedList: boolean;
  checkItem: boolean;
  table: boolean;
  link: { href: string; title: string | null } | null;
  hasTextSelection: boolean;
}

function headingBlock(level: unknown): RichTextToolbarSnapshot['block'] {
  if (level === 1) return 'heading-1';
  if (level === 2) return 'heading-2';
  if (level === 3) return 'heading-3';
  if (level === 4) return 'heading-4';
  if (level === 5) return 'heading-5';
  if (level === 6) return 'heading-6';
  return 'other';
}

function markActive(state: EditorState, type: MarkType | undefined): boolean {
  if (!type) return false;
  const { from, to, empty, $from } = state.selection;
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
  return state.doc.rangeHasMark(from, to, type);
}

function ancestorActive(state: EditorState, type: NodeType | undefined): boolean {
  if (!type) return false;
  for (let depth = state.selection.$from.depth; depth > 0; depth -= 1) {
    if (state.selection.$from.node(depth).type === type) return true;
  }
  return false;
}

function activeLink(state: EditorState): RichTextToolbarSnapshot['link'] {
  const link = state.schema.marks.link;
  let mark = link.isInSet(state.storedMarks ?? state.selection.$from.marks());
  if (!mark && !state.selection.empty) {
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
      mark ??= link.isInSet(node.marks);
      return mark === undefined;
    });
  }
  if (!mark || typeof mark.attrs.href !== 'string') return null;
  const parsed = safeLink(mark.attrs.href, mark.attrs.title);
  return parsed ?? null;
}

export function richTextToolbarSnapshot(state: EditorState): RichTextToolbarSnapshot {
  const parent = state.selection.$from.parent;
  const block = parent.type === state.schema.nodes.heading
    ? headingBlock(parent.attrs.level)
    : parent.type === state.schema.nodes.paragraph
      ? 'paragraph'
      : 'other';
  return {
    block,
    strong: markActive(state, state.schema.marks.strong),
    emphasis: markActive(state, state.schema.marks.em),
    underline: markActive(state, state.schema.marks[UNDERLINE_MARK]),
    strike: markActive(state, state.schema.marks[STRIKE_MARK]),
    inlineCode: markActive(state, state.schema.marks[INLINE_CODE_MARK]),
    bulletList: ancestorActive(state, state.schema.nodes.bullet_list),
    orderedList: ancestorActive(state, state.schema.nodes.ordered_list),
    checkItem: ancestorActive(state, state.schema.nodes.check_item),
    table: ancestorActive(state, state.schema.nodes.table),
    link: activeLink(state),
    hasTextSelection: !state.selection.empty,
  };
}

function commandAvailable(view: EditorView | null, editable: boolean, command: Command): boolean {
  if (!view || !editable) return false;
  try {
    return command(view.state, undefined, view);
  } catch {
    return false;
  }
}

interface ToolbarButtonProps {
  label: string;
  shortLabel?: string;
  /** Icon shown instead of the short label, as in Office ribbons. */
  icon?: LucideIcon;
  shortcut?: string;
  active?: boolean;
  available: boolean;
  onRun: () => void;
}

function ariaShortcut(shortcut: string | undefined): string | undefined {
  if (!shortcut?.startsWith('Strg/⌘') && !shortcut?.startsWith('Ctrl/⌘')) return undefined;
  const suffix = shortcut
    .slice('Strg/⌘'.length)
    .replaceAll('Umschalt', 'Shift')
    .replaceAll('Eingabe', 'Enter');
  return `Control${suffix} Meta${suffix}`;
}

function ToolbarButton({
  label,
  shortLabel,
  icon: Icon,
  shortcut,
  active = false,
  available,
  onRun,
}: ToolbarButtonProps) {
  const { t } = useI18n();
  const title = `${label}${shortcut ? ` (${shortcut})` : ''}${available ? '' : ` – ${t('richText.button.unavailable')}`}`;
  const preserveSelection = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <button
      type="button"
      className="canvink-rich-text-toolbar__button"
      aria-label={label}
      aria-keyshortcuts={ariaShortcut(shortcut)}
      aria-pressed={active}
      disabled={!available}
      title={title}
      onMouseDown={preserveSelection}
      onClick={onRun}
    >
      {Icon ? <Icon size={17} strokeWidth={2.2} aria-hidden="true" /> : shortLabel ?? label}
    </button>
  );
}

export interface RichTextToolbarProps {
  view: EditorView | null;
  /**
   * Shown when no text has focus: the ribbon keeps displaying the full,
   * disabled set of formatting controls, as OneNote's Home tab does.
   */
  idleState?: EditorState;
  editable: boolean;
  revision?: number;
}

export function RichTextToolbar({ view, editable, revision = 0, idleState }: RichTextToolbarProps) {
  const { language, t } = useI18n();
  void revision;
  const state = view?.state ?? idleState;
  const snapshot = state ? richTextToolbarSnapshot(state) : null;
  const schema = state?.schema;
  const [status, setStatus] = useState<{
    key: TranslationKey;
    parameters?: TranslationParameters;
  }>({ key: 'richText.status.selection' });
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [href, setHref] = useState('https://');
  const [title, setTitle] = useState('');

  const visibleStatus = editable
    ? t(status.key, status.parameters)
    : t('richText.status.readOnly');

  const run = (label: string, command: Command) => {
    if (!view || !editable || !command(view.state, view.dispatch, view)) {
      setStatus({ key: 'richText.status.unavailable', parameters: { label } });
      return;
    }
    view.focus();
    setStatus({ key: 'richText.status.applied', parameters: { label } });
  };

  const blockCommands = schema
    ? {
        paragraph: setParagraph(schema),
        heading1: setHeading(schema, 1),
        heading2: setHeading(schema, 2),
        heading3: setHeading(schema, 3),
        heading4: setHeading(schema, 4),
        heading5: setHeading(schema, 5),
        heading6: setHeading(schema, 6),
      }
    : null;
  const lists = schema ? listCommands(schema) : null;
  const selectedBlock = snapshot?.block === 'paragraph' || snapshot?.block === 'other'
    ? 'paragraph'
    : snapshot?.block.replace('heading-', 'heading') ?? 'paragraph';

  const openLinkEditor = () => {
    if (!snapshot?.hasTextSelection) {
      setStatus({ key: 'richText.status.selectLinkText' });
      return;
    }
    setHref(snapshot.link?.href ?? 'https://');
    setTitle(snapshot.link?.title ?? '');
    setLinkEditorOpen(true);
    setStatus({ key: 'richText.status.enterLink' });
  };

  const submitLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!view || !schema || !editable) return;
    const parsed = safeLink(href, title || null);
    if (!parsed) {
      setStatus({ key: 'richText.status.unsafeLink' });
      return;
    }
    run(t('richText.link.short'), setLink(schema, parsed.href, parsed.title));
    setLinkEditorOpen(false);
  };

  const markButtons = schema ? [
    { label: t('richText.bold'), shortLabel: language === 'de' ? 'F' : 'B', icon: Bold, shortcut: language === 'de' ? 'Strg/⌘+B' : 'Ctrl/⌘+B', active: snapshot?.strong, command: toggleStrong(schema) },
    { label: t('richText.italic'), shortLabel: language === 'de' ? 'K' : 'I', icon: Italic, shortcut: language === 'de' ? 'Strg/⌘+I' : 'Ctrl/⌘+I', active: snapshot?.emphasis, command: toggleEmphasis(schema) },
    { label: t('richText.underline'), shortLabel: 'U', icon: Underline, shortcut: language === 'de' ? 'Strg/⌘+U' : 'Ctrl/⌘+U', active: snapshot?.underline, command: toggleUnderline(schema) },
    { label: t('richText.strike'), shortLabel: 'S', icon: Strikethrough, shortcut: language === 'de' ? 'Strg/⌘+Umschalt+X' : 'Ctrl/⌘+Shift+X', active: snapshot?.strike, command: toggleStrike(schema) },
    { label: t('richText.inlineCode'), shortLabel: '</>', icon: Code, shortcut: language === 'de' ? 'Strg/⌘+`' : 'Ctrl/⌘+`', active: snapshot?.inlineCode, command: toggleInlineCode(schema) },
  ] : [];

  return (
    <div
      className="canvink-rich-text-toolbar"
      role="toolbar"
      aria-label={t('richText.toolbar')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="canvink-rich-text-toolbar__row">
        <label className="canvink-rich-text-toolbar__field">
          <span className="sr-only">{t('richText.block.label')}</span>
          <select
            aria-label={t('richText.block.label')}
            value={selectedBlock}
            disabled={!editable || !view || !blockCommands}
            onChange={(event) => {
              const command = blockCommands?.[event.target.value as keyof typeof blockCommands];
              if (command) run(event.target.selectedOptions[0]?.textContent ?? t('richText.block.label'), command);
            }}
          >
            <option value="paragraph">{t('richText.block.paragraph')}</option>
            <option value="heading1">{t('richText.block.heading1')}</option>
            <option value="heading2">{t('richText.block.heading2')}</option>
            <option value="heading3">{t('richText.block.heading3')}</option>
            <option value="heading4">{t('richText.block.heading4')}</option>
            <option value="heading5">{t('richText.block.heading5')}</option>
            <option value="heading6">{t('richText.block.heading6')}</option>
          </select>
        </label>

        {markButtons.map(({ command, ...button }) => (
          <ToolbarButton
            key={button.label}
            {...button}
            active={button.active === true}
            available={commandAvailable(view, editable, command)}
            onRun={() => run(button.label, command)}
          />
        ))}

        {schema && lists ? (
          <>
            <ToolbarButton
              label={t('richText.bulletList')}
              shortLabel={t('richText.bulletList.short')}
              icon={List}
              shortcut={language === 'de' ? 'Strg/⌘+.' : 'Ctrl/⌘+.'}
              active={snapshot?.bulletList}
              available={commandAvailable(view, editable, lists.bullet)}
              onRun={() => run(t('richText.bulletList'), lists.bullet)}
            />
            <ToolbarButton
              label={t('richText.orderedList')}
              shortLabel={t('richText.orderedList.short')}
              icon={ListOrdered}
              shortcut={language === 'de' ? 'Strg/⌘+/' : 'Ctrl/⌘+/'}
              active={snapshot?.orderedList}
              available={commandAvailable(view, editable, lists.ordered)}
              onRun={() => run(t('richText.orderedList'), lists.ordered)}
            />
            <ToolbarButton
              label={t('richText.check.insert')}
              shortLabel={t('richText.check.insert.short')}
              icon={SquareCheck}
              shortcut={language === 'de' ? 'Strg/⌘+1' : 'Ctrl/⌘+1'}
              active={snapshot?.checkItem}
              available={commandAvailable(view, editable, insertCheckItem(schema))}
              onRun={() => run(t('richText.check.item'), insertCheckItem(schema))}
            />
            <ToolbarButton
              label={t('richText.check.toggle')}
              shortLabel={t('richText.check.toggle.short')}
              icon={CheckCheck}
              shortcut={language === 'de' ? 'Strg/⌘+Eingabe' : 'Ctrl/⌘+Enter'}
              active={snapshot?.checkItem}
              available={snapshot?.checkItem === true && commandAvailable(view, editable, toggleCurrentCheckItem)}
              onRun={() => run(t('richText.check.status'), toggleCurrentCheckItem)}
            />
          </>
        ) : null}

        <ToolbarButton
          label={t('richText.link.edit')}
          shortLabel={t('richText.link.short')}
              icon={Link}
          active={snapshot?.link !== null}
          available={editable && snapshot?.hasTextSelection === true}
          onRun={openLinkEditor}
        />
        {schema ? (
          <ToolbarButton
            label={t('richText.link.remove')}
            shortLabel={t('richText.link.remove.short')}
              icon={Unlink}
            available={editable && snapshot?.hasTextSelection === true && snapshot.link !== null}
            onRun={() => run(t('richText.link.removed'), removeLink(schema))}
          />
        ) : null}

        {schema ? (
          <ToolbarButton
            label={t('richText.table.insert')}
            shortLabel={t('richText.table.insert.short')}
              icon={Table}
            available={commandAvailable(view, editable, insertTable(schema, 2, 2, true))}
            onRun={() => run(t('richText.table.label'), insertTable(schema, 2, 2, true))}
          />
        ) : null}
      </div>

      {snapshot?.table ? <div className="canvink-rich-text-toolbar__row" aria-label={t('richText.table.actions')}>
        {([
          [t('richText.table.rowBefore'), t('richText.table.rowBefore.short'), richTextTableCommands.addRowBefore],
          [t('richText.table.rowAfter'), t('richText.table.rowAfter.short'), richTextTableCommands.addRowAfter],
          [t('richText.table.deleteRow'), t('richText.table.deleteRow.short'), richTextTableCommands.deleteRow],
          [t('richText.table.columnBefore'), t('richText.table.columnBefore.short'), richTextTableCommands.addColumnBefore],
          [t('richText.table.columnAfter'), t('richText.table.columnAfter.short'), richTextTableCommands.addColumnAfter],
          [t('richText.table.deleteColumn'), t('richText.table.deleteColumn.short'), richTextTableCommands.deleteColumn],
          [t('richText.table.delete'), t('richText.table.delete'), richTextTableCommands.deleteTable],
        ] as const).map(([label, shortLabel, command]) => (
          <ToolbarButton
            key={label}
            label={label}
            shortLabel={shortLabel}
            available={commandAvailable(view, editable, command)}
            onRun={() => run(label, command)}
          />
        ))}
      </div> : null}

      {linkEditorOpen ? (
        <form className="canvink-rich-text-toolbar__link" aria-label={t('richText.link.edit')} onSubmit={submitLink}>
          <label>
            <span>{t('richText.link.address')}</span>
            <input
              type="url"
              value={href}
              autoFocus
              required
              inputMode="url"
              autoComplete="url"
              onChange={(event) => setHref(event.target.value)}
            />
          </label>
          <label>
            <span>{t('richText.link.title')}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <button type="submit">{t('richText.link.apply')}</button>
          <button type="button" onClick={() => setLinkEditorOpen(false)}>{t('common.cancel')}</button>
        </form>
      ) : null}

      <p className="canvink-rich-text-toolbar__status" role="status" aria-live="polite">
        {visibleStatus}
      </p>
    </div>
  );
}
