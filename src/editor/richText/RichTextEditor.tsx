import * as Automerge from '@automerge/automerge';
import {
  pmDocFromSpans,
  pmNodeToSpans,
  type DocHandle as BindingDocHandle,
} from '@automerge/prosemirror';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { history } from 'prosemirror-history';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { richTextInputRules, richTextKeymap, richTextTablePlugin } from './commands';
import { RichTextToolbar } from './RichTextToolbar';
import { SlashMenu } from './SlashMenuPopover';
import { slashMenuPlugin } from './slashMenu';
import { canvinkRichTextSchema, canvinkSchemaAdapter } from './schema';
import { canvinkSyncPlugin } from './syncPluginCompat';
import { useI18n } from '../../i18n';
import {
  normalizePersistentTables,
  repairLegacyTableSpans,
  richTextTableIdentityPlugin,
} from './tablePersistence';
import './richText.css';

export interface RichTextEditorSession {
  view: EditorView;
  destroy: () => void;
}

/** The Repo handle shape used by the binding, with its precise Automerge document return type. */
export type RichTextDocHandle<T> = Omit<BindingDocHandle<T>, 'change' | 'doc'> & {
  doc: () => Automerge.Doc<T>;
};

export type RichTextWriter<T> = (
  callback: (document: Automerge.Doc<T>) => void,
  options: { message: string },
) => void | boolean;

export interface CreateRichTextEditorOptions<T> {
  container: HTMLElement;
  handle: RichTextDocHandle<T>;
  write: RichTextWriter<T>;
  path: readonly Automerge.Prop[];
  ariaLabel: string;
  editable?: boolean;
  onStateChange?: (view: EditorView) => void;
  onWriteError?: (error: Error) => void;
}

export function createRichTextEditorState<T>(
  handle: RichTextDocHandle<T>,
  path: readonly Automerge.Prop[],
  write: RichTextWriter<T>,
  onWriteError?: (error: Error) => void,
): EditorState {
  const stablePath = [...path];
  const storedSpans = Automerge.spans(handle.doc(), stablePath);
  const repairedSpans = repairLegacyTableSpans(storedSpans);
  let loadedDoc = pmDocFromSpans(canvinkSchemaAdapter, repairedSpans.spans);
  if (repairedSpans.changed) {
    const storedLength = storedSpans.reduce(
      (length, span) => length + (span.type === 'block' ? 1 : span.value.length),
      0,
    );
    reportWrite(write((document) => {
      if (storedLength > 0) Automerge.splice(document, stablePath, 0, storedLength, '');
      Automerge.updateSpans(
        document,
        stablePath,
        pmNodeToSpans(canvinkSchemaAdapter, loadedDoc),
        canvinkSchemaAdapter.updateSpansConfig(),
      );
    }, { message: 'Repair legacy rich text table spans' }), onWriteError);
  }
  const normalized = normalizePersistentTables(loadedDoc);
  if (normalized.changed) {
    reportWrite(write((document) => {
      Automerge.updateSpans(
        document,
        stablePath,
        pmNodeToSpans(canvinkSchemaAdapter, normalized.doc),
        canvinkSchemaAdapter.updateSpansConfig(),
      );
    }, { message: 'Normalize rich text table structure' }), onWriteError);
    loadedDoc = normalized.doc;
  }
  return EditorState.create({
    schema: canvinkRichTextSchema,
    doc: loadedDoc,
    plugins: [
      history({ depth: 100, newGroupDelay: 500 }),
      // Before the keymap so Enter, Tab and arrows reach an open "/" menu first.
      slashMenuPlugin(),
      richTextInputRules(canvinkRichTextSchema),
      richTextKeymap(canvinkRichTextSchema),
      richTextTablePlugin(),
      richTextTableIdentityPlugin(),
      canvinkSyncPlugin({ adapter: canvinkSchemaAdapter, handle, write, path: stablePath, onWriteError }),
    ],
  });
}

export function createRichTextEditor<T>({
  container,
  handle,
  write,
  path,
  ariaLabel,
  editable = true,
  onStateChange,
  onWriteError,
}: CreateRichTextEditorOptions<T>): RichTextEditorSession {
  const state = createRichTextEditorState(handle, path, write, onWriteError);
  const view = new EditorView(container, {
    state,
    dispatchTransaction: (transaction) => {
      view.updateState(view.state.apply(transaction));
      onStateChange?.(view);
    },
    editable: () => editable,
    attributes: {
      role: 'textbox',
      'aria-label': ariaLabel,
      'aria-multiline': 'true',
      'aria-readonly': String(!editable),
      spellcheck: 'true',
      tabindex: '0',
      class: 'canvink-rich-text-content',
    },
  });
  let destroyed = false;
  return {
    view,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
    },
  };
}

/**
 * Element in the surrounding toolbar that the focused text editor docks its
 * formatting controls into. Without a provider the controls stay inline.
 */
export const RichTextToolbarSlotContext = createContext<HTMLElement | null>(null);

export interface RichTextEditorProps<T> {
  handle: RichTextDocHandle<T>;
  write: RichTextWriter<T>;
  path: readonly Automerge.Prop[];
  ariaLabel: string;
  className?: string;
  editable?: boolean;
  /** Mount only after the Repo DocHandle is ready. */
  ready?: boolean;
  onReady?: (view: EditorView) => void;
  onError?: (error: Error) => void;
}

function pathIdentity(path: readonly Automerge.Prop[]): string {
  return JSON.stringify(path.map((part) => [typeof part, part]));
}

function pathFromIdentity(identity: string): Automerge.Prop[] {
  const parsed: unknown = JSON.parse(identity);
  if (!Array.isArray(parsed)) throw new Error('Rich-text path identity is malformed.');
  return parsed.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error('Rich-text path identity is malformed.');
    }
    const [type, value] = entry;
    if (type === 'string' && typeof value === 'string') return value;
    if (type === 'number' && typeof value === 'number' && Number.isSafeInteger(value)) return value;
    throw new Error('Rich-text paths may contain only string keys and integer indexes.');
  });
}

export default function RichTextEditor<T>({
  handle,
  write,
  path,
  ariaLabel,
  className,
  editable = true,
  ready = true,
  onReady,
  onError,
}: RichTextEditorProps<T>) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const writeRef = useRef(write);
  const [toolbarState, setToolbarState] = useState<{ view: EditorView | null; revision: number }>({
    view: null,
    revision: 0,
  });
  const identity = pathIdentity(path);
  const stablePath = useMemo(() => pathFromIdentity(identity), [identity]);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    writeRef.current = write;
  }, [onError, onReady, write]);
  const stableWrite = useCallback<RichTextWriter<T>>(
    (change, options) => writeRef.current(change, options),
    [],
  );
  // Inside the canvas editor the formatting controls dock into the main
  // toolbar while this text has focus, like OneNote's Home ribbon, instead of
  // floating over (and being clipped by) the page. Elsewhere they stay inline.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dockedToolbarRef = useRef<HTMLDivElement>(null);
  const toolbarSlot = useContext(RichTextToolbarSlotContext);
  const [focused, setFocused] = useState(false);
  const handleStateChange = useCallback((view: EditorView) => {
    setToolbarState((current) => ({ view, revision: current.revision + 1 }));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready) return;
    let session: RichTextEditorSession | null = null;
    try {
      session = createRichTextEditor({
        container,
        handle,
        write: stableWrite,
        path: stablePath,
        ariaLabel,
        editable,
        onStateChange: handleStateChange,
      });
      setToolbarState((current) => ({ view: session?.view ?? null, revision: current.revision + 1 }));
      onReadyRef.current?.(session.view);
    } catch (error) {
      const failureError = error instanceof Error ? error : new Error(String(error));
      onErrorRef.current?.(failureError);
    }
    return () => {
      session?.destroy();
    };
  }, [ariaLabel, editable, handle, handleStateChange, ready, stablePath, stableWrite]);

  const toolbar = (
    <RichTextToolbar
      view={toolbarState.view}
      editable={editable}
      revision={toolbarState.revision}
    />
  );
  return (
    <div
      ref={wrapperRef}
      className={className ? `canvink-rich-text-editor ${className}` : 'canvink-rich-text-editor'}
      data-editor-ready={ready ? 'true' : 'false'}
      data-toolbar-docked={toolbarSlot ? 'true' : 'false'}
      aria-busy={!ready}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // React focus events bubble through the portal, so moving focus into
        // the docked toolbar (link field, paragraph style) keeps it open.
        const next = event.relatedTarget;
        if (next instanceof Node
          && (wrapperRef.current?.contains(next) || dockedToolbarRef.current?.contains(next))) return;
        setFocused(false);
      }}
    >
      <div ref={containerRef} className="canvink-rich-text-editor__surface" />
      {editable ? <SlashMenu view={toolbarState.view} /> : null}
      {toolbarSlot
        ? (focused && editable
          ? createPortal(<div ref={dockedToolbarRef} className="canvink-rich-text-toolbar-dock">{toolbar}</div>, toolbarSlot)
          : null)
        : toolbar}
      {!ready ? <p role="status">{t('richText.loading')}</p> : null}
    </div>
  );
}

function reportWrite(
  result: void | boolean,
  onWriteError?: (error: Error) => void,
): void {
  if (result === false) onWriteError?.(new Error('Rich-text persistence was rejected.'));
}
