import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Download, FileCode2 } from 'lucide-react';
import { history } from 'prosemirror-history';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { MAX_TEXT_CHARS } from '../../domain/limits';
import { useI18n } from '../../i18n';
import { SlashMenu } from '../richText/SlashMenuPopover';
import { slashMenuPlugin } from '../richText/slashMenu';
import { SOURCE_LOADED, adoptSourceChunks, loadSourceTransaction, parseMarkdown, serializeMarkdown } from './markdownConvert';
import {
  MARKDOWN_SLASH_ITEMS,
  checkItemClickPlugin,
  markdownInputRules,
  markdownKeymap,
  markdownPastePlugin,
  markdownTablePlugin,
  focusPageEnd,
  pageEndClickPlugin,
  placeholderPlugin,
  trailingParagraphPlugin,
} from './markdownCommands';
import { markdownSchema } from './markdownSchema';
import '../richText/richText.css';
import './MarkdownPageEditor.css';

export type MarkdownEditorView = 'rich' | 'source';

interface MarkdownPageEditorProps {
  title: string;
  source: string;
  editable: boolean;
  onSourceChange: (source: string) => void;
}

function downloadMarkdown(source: string, title: string): void {
  const filename = `${title.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100) || 'canvink'}.md`;
  const blob = new Blob([source], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface RichEditorProps {
  source: string;
  editable: boolean;
  ariaLabel: string;
  onSourceChange: (source: string) => void;
}

function MarkdownRichEditor({ source, editable, ariaLabel, onSourceChange }: RichEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [, setRevision] = useState(0);
  const initial = useRef({ source, editable, ariaLabel });
  const changeRef = useRef(onSourceChange);
  // The Markdown the editor last wrote or loaded, and the writes whose echo
  // has not come back through the `source` prop yet.
  const written = useRef(source);
  const pending = useRef<string[]>([]);

  useEffect(() => {
    changeRef.current = onSourceChange;
  }, [onSourceChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const doc = parseMarkdown(initial.current.source);
    const state = EditorState.create({
      schema: markdownSchema,
      doc,
      plugins: [
        history({ depth: 100, newGroupDelay: 500 }),
        // Before the keymap so Enter and the arrows reach an open "/" menu first.
        slashMenuPlugin(MARKDOWN_SLASH_ITEMS),
        ...markdownInputRules(markdownSchema),
        markdownKeymap(markdownSchema),
        markdownTablePlugin(),
        markdownPastePlugin(markdownSchema),
        checkItemClickPlugin(),
        pageEndClickPlugin(),
        trailingParagraphPlugin(),
        placeholderPlugin(),
      ],
    });
    const created: EditorView = new EditorView(host, {
      state,
      editable: () => initial.current.editable,
      attributes: {
        role: 'textbox',
        'aria-label': initial.current.ariaLabel,
        'aria-multiline': 'true',
        'aria-readonly': String(!initial.current.editable),
        spellcheck: 'true',
        class: 'canvink-rich-text-content markdown-page-editor__content',
      },
      dispatchTransaction: (transaction) => {
        const next = created.state.apply(transaction);
        if (transaction.docChanged && transaction.getMeta(SOURCE_LOADED) !== true) {
          const markdown = serializeMarkdown(next.doc);
          // Like the textarea's maxLength: an edit past the limit does not happen.
          if (markdown.length > MAX_TEXT_CHARS) return;
          created.updateState(next);
          if (markdown !== written.current) {
            written.current = markdown;
            pending.current.push(markdown);
            changeRef.current(markdown);
          }
        } else {
          created.updateState(next);
        }
        setRevision((revision) => revision + 1);
      },
    });
    setView(created);
    return () => {
      created.destroy();
      setView(null);
    };
  }, []);

  useEffect(() => {
    view?.setProps({
      editable: () => editable,
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        'aria-readonly': String(!editable),
        spellcheck: 'true',
        class: 'canvink-rich-text-content markdown-page-editor__content',
      },
    });
  }, [view, editable, ariaLabel]);

  // A source that differs from what this editor wrote came from elsewhere: a
  // remote change, an undo or a restore. Take it in without moving the caret.
  useEffect(() => {
    if (!view) return;
    const echo = pending.current.indexOf(source);
    if (echo >= 0) {
      pending.current.splice(0, echo + 1);
      return;
    }
    if (source === written.current) return;
    written.current = source;
    pending.current = [];
    const { transaction, parsed } = loadSourceTransaction(view.state, source);
    if (transaction) view.dispatch(transaction);
    adoptSourceChunks(view.state.doc, parsed);
  }, [view, source]);

  return (
    <div
      className="markdown-page-editor__page"
      onMouseDown={(event) => {
        // The margins around the column: a click there focuses the end of the page.
        if (!view || !editable || event.target !== event.currentTarget) return;
        event.preventDefault();
        focusPageEnd(view);
      }}
    >
      <div ref={hostRef} className="markdown-page-editor__surface" />
      {editable ? <SlashMenu view={view} items={MARKDOWN_SLASH_ITEMS} /> : null}
    </div>
  );
}

export default function MarkdownPageEditor({
  title,
  source,
  editable,
  onSourceChange,
}: MarkdownPageEditorProps) {
  const { t } = useI18n();
  const [view, setView] = useState<MarkdownEditorView>('rich');
  const toggleSource = useCallback(() => setView((current) => (current === 'rich' ? 'source' : 'rich')), []);
  const style: CSSProperties & { '--markdown-placeholder': string } = {
    '--markdown-placeholder': JSON.stringify(t('markdown.placeholder')),
  };
  return (
    <section
      className="markdown-page-editor"
      aria-label={t('markdown.label', { title })}
      data-view={view}
      style={style}
    >
      <div className="markdown-page-editor__toolbar" role="toolbar" aria-label={t('markdown.label', { title })}>
        <button type="button" aria-pressed={view === 'source'} onClick={toggleSource}>
          <FileCode2 size={15} aria-hidden="true" /> <span>{t('markdown.view.source')}</span>
        </button>
        <button type="button" className="markdown-page-editor__download" onClick={() => downloadMarkdown(source, title)}>
          <Download size={15} aria-hidden="true" /> <span>{t('markdown.download')}</span>
        </button>
      </div>
      <div className="markdown-page-editor__workspace">
        {view === 'source' ? (
          <label className="markdown-page-editor__source">
            <span>{t('markdown.source')}</span>
            <textarea
              value={source}
              readOnly={!editable}
              maxLength={MAX_TEXT_CHARS}
              spellCheck
              onChange={(event) => onSourceChange(event.target.value)}
            />
          </label>
        ) : (
          <MarkdownRichEditor
            source={source}
            editable={editable}
            ariaLabel={t('markdown.editor')}
            onSourceChange={onSourceChange}
          />
        )}
      </div>
    </section>
  );
}
