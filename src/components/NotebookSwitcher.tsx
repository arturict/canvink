import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Pencil,
  ExternalLink,
  Lock,
  LogOut,
  Mail,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Trash2,
  Users,
} from 'lucide-react';
import type { Invitation, Role } from '../collab';
import { useI18n } from '../i18n';
import { contextMenuTriggerProps, useContextMenu } from '../ui/ContextMenu';
import type { MenuPoint } from '../ui/contextMenuModel';
import { InlineRename } from '../ui/InlineRename';
import type { QuickAccessEntry } from './pagePins';
import { sectionColor } from './sectionColors';

export interface SwitcherNotebook {
  id: string;
  title: string;
  color: string;
  /** The notebook's own symbol (an emoji), shown instead of the colour dot. */
  icon?: string;
}

/** The colour dot of a notebook, or its symbol when it has one. */
function NotebookMark({ notebook }: { notebook: SwitcherNotebook }) {
  return notebook.icon
    ? <span className="notebook-color notebook-color--icon" aria-hidden="true">{notebook.icon}</span>
    : <span className="notebook-color" style={{ background: notebook.color }} aria-hidden="true" />;
}

export interface NotebookSwitcherProps {
  notebooks: readonly SwitcherNotebook[];
  activeNotebookId: string;
  previousNotebookId?: string;
  quickAccess: readonly QuickAccessEntry[];
  onSelectNotebook: (notebookId: string) => void;
  onOpenPage: (entry: QuickAccessEntry) => void;
  /** Removes a page from quick access; omitted where pins cannot change. */
  onUnpinPage?: (entry: QuickAccessEntry) => void;
  onAddNotebook: () => void;
  /** Called with the new, non-empty name once an inline rename is confirmed. */
  onRenameNotebook: (notebookId: string, title: string) => void;
  onDuplicateNotebook: (notebookId: string) => void;
  onMoveNotebook: (notebookId: string, direction: 'up' | 'down') => void;
  onTrashNotebook: (notebookId: string) => void;
  /**
   * Notebooks someone else shares with this account or this account shares, by notebook id, with the
   * role the account has in each. A reader's notebook shows a lock and cannot be renamed.
   */
  sharedNotebooks?: ReadonlyMap<string, Role>;
  /** Notebooks shared with this account by e-mail address that it has not opened yet. */
  invitations?: readonly Invitation[];
  /** The invitation being opened right now. */
  invitationBusyRoomId?: string | null;
  onOpenInvitation?: (invitation: Invitation) => void;
  onDeclineInvitation?: (invitation: Invitation) => void;
  /** Takes a joined notebook out of this workspace; the owner and the others keep it. */
  onLeaveNotebook?: (notebookId: string) => void;
  /** Opens the notebook's settings ("Notizbuch-Einstellungen"). */
  onOpenNotebookSettings?: (notebookId: string) => void;
  readOnly?: boolean;
  /** Only one switcher on screen listens for Ctrl+G. */
  shortcut?: boolean;
  /** Opens the list as soon as it is mounted (Ctrl+G in the full page view). */
  openOnMount?: boolean;
}

type Option =
  | { kind: 'notebook'; key: string; notebook: SwitcherNotebook; index: number }
  | { kind: 'page'; key: string; entry: QuickAccessEntry };

/** Matches Ctrl+G (OneNote's "show the list of notebooks"). */
export function isSwitcherShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'g';
}

/**
 * The notebook switcher in the title bar (the pattern of Umami's team
 * switcher): the open notebook as a compact button; a popover with a filter,
 * every notebook with its colour, the pinned pages, and "Neues Notizbuch".
 * Ctrl+G opens it with the previous notebook preselected, so Ctrl+G, Enter
 * toggles between two notebooks.
 */
export default function NotebookSwitcher({
  notebooks,
  activeNotebookId,
  previousNotebookId,
  quickAccess,
  onSelectNotebook,
  onOpenPage,
  onUnpinPage,
  onAddNotebook,
  onRenameNotebook,
  onDuplicateNotebook,
  onMoveNotebook,
  onTrashNotebook,
  sharedNotebooks,
  invitations = [],
  invitationBusyRoomId = null,
  onOpenInvitation,
  onDeclineInvitation,
  onLeaveNotebook,
  onOpenNotebookSettings,
  readOnly = false,
  shortcut = true,
  openOnMount = false,
}: NotebookSwitcherProps) {
  const { t } = useI18n();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(openOnMount);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string>('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menu = useContextMenu();
  const active = notebooks.find((notebook) => notebook.id === activeNotebookId) ?? notebooks[0];
  const previous = previousNotebookId && previousNotebookId !== activeNotebookId
    ? notebooks.find((notebook) => notebook.id === previousNotebookId)
    : undefined;

  const options = useMemo<Option[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (...texts: string[]) => !needle || texts.some((text) => text.toLocaleLowerCase().includes(needle));
    return [
      ...notebooks
        .map((notebook, index) => ({ kind: 'notebook' as const, key: `notebook:${notebook.id}`, notebook, index }))
        .filter((option) => matches(option.notebook.title)),
      ...quickAccess
        .filter((entry) => matches(entry.title, entry.notebookTitle, entry.sectionTitle))
        .map((entry) => ({ kind: 'page' as const, key: `page:${entry.pageId}`, entry })),
    ];
  }, [notebooks, query, quickAccess]);
  const activeOption = options.find((option) => option.key === activeKey) ?? options[0];

  const show = () => {
    setQuery('');
    setActiveKey(`notebook:${(previous ?? active)?.id ?? ''}`);
    setOpen(true);
  };
  const hide = (restoreFocus: boolean) => {
    setRenamingId(null);
    setOpen(false);
    menu.close();
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!shortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSwitcherShortcut(event)) return;
      event.preventDefault();
      if (open) hide(true);
      else show();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.context-menu')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);

  useEffect(() => {
    if (!open || !activeOption) return;
    document.getElementById(`${id}-${activeOption.key}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeOption, id, open]);

  // A reader's notebook is changed by its owner alone: its title cannot be edited here.
  const isReader = (notebookId: string) => sharedNotebooks?.get(notebookId) === 'viewer';

  const startRename = (notebook: SwitcherNotebook) => {
    if (readOnly || isReader(notebook.id)) return;
    setActiveKey(`notebook:${notebook.id}`);
    setRenamingId(notebook.id);
  };

  const finishRename = (notebook: SwitcherNotebook, title: string | null) => {
    setRenamingId(null);
    inputRef.current?.focus({ preventScroll: true });
    if (title !== null) onRenameNotebook(notebook.id, title);
  };

  const choose = (option: Option | undefined) => {
    if (!option) return;
    hide(false);
    if (option.kind === 'notebook') {
      if (option.notebook.id !== activeNotebookId) onSelectNotebook(option.notebook.id);
    } else {
      onOpenPage(option.entry);
    }
  };

  const openNotebookMenu = (point: MenuPoint, trigger: HTMLElement, notebook: SwitcherNotebook, index: number) => {
    const run = (action: () => void) => () => {
      setOpen(false);
      action();
    };
    const rename = () => startRename(notebook);
    menu.open({
      point,
      label: t('menu.notebook', { title: notebook.title }),
      returnFocus: trigger,
      items: [
        { id: 'rename', label: t('menu.rename'), icon: <Pencil size={14} />, disabled: readOnly || isReader(notebook.id), onSelect: rename },
        { id: 'duplicate', label: t('menu.duplicate'), icon: <Copy size={14} />, disabled: readOnly, onSelect: run(() => onDuplicateNotebook(notebook.id)) },
        { id: 'up', label: t('menu.moveUp'), icon: <ArrowUp size={14} />, disabled: readOnly || index === 0, onSelect: () => onMoveNotebook(notebook.id, 'up') },
        { id: 'down', label: t('menu.moveDown'), icon: <ArrowDown size={14} />, disabled: readOnly || index === notebooks.length - 1, onSelect: () => onMoveNotebook(notebook.id, 'down') },
        ...(onOpenNotebookSettings
          ? [{ id: 'settings', label: t('nbSettings.open'), icon: <Settings2 size={14} />, onSelect: run(() => onOpenNotebookSettings(notebook.id)) }]
          : []),
        { kind: 'separator', id: 'sep' },
        sharedNotebooks?.has(notebook.id) && sharedNotebooks.get(notebook.id) !== 'owner' && onLeaveNotebook
          ? { id: 'leave', label: t('menu.leaveShared'), icon: <LogOut size={14} />, danger: true, disabled: readOnly || notebooks.length === 1, onSelect: run(() => onLeaveNotebook(notebook.id)) }
          : { id: 'delete', label: t('menu.delete'), icon: <Trash2 size={14} />, danger: true, disabled: readOnly || notebooks.length === 1, onSelect: run(() => onTrashNotebook(notebook.id)) },
      ],
    });
  };

  const openPageMenu = (point: MenuPoint, trigger: HTMLElement, entry: QuickAccessEntry) => {
    menu.open({
      point,
      label: entry.title,
      returnFocus: trigger,
      items: [
        { id: 'open', label: t('menu.open'), icon: <ExternalLink size={14} />, onSelect: () => { setOpen(false); onOpenPage(entry); } },
        { id: 'unpin', label: t('menu.unpin'), icon: <PinOff size={14} />, disabled: readOnly || !onUnpinPage, onSelect: () => onUnpinPage?.(entry) },
      ],
    });
  };

  if (!active) return null;
  const listId = `${id}-list`;
  const notebookOptions = options.filter((option): option is Extract<Option, { kind: 'notebook' }> => option.kind === 'notebook');
  const pageOptions = options.filter((option): option is Extract<Option, { kind: 'page' }> => option.kind === 'page');

  return (
    <div ref={rootRef} className="notebook-switcher">
      <button
        ref={buttonRef}
        type="button"
        className="notebook-switcher__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={invitations.length > 0
          ? `${t('switcher.open', { title: active.title })}. ${t('collab.invites.count', { count: invitations.length })}`
          : t('switcher.open', { title: active.title })}
        aria-keyshortcuts="Control+G"
        title={t('switcher.open', { title: active.title })}
        onClick={() => (open ? hide(false) : show())}
      >
        <NotebookMark notebook={active} />
        <span className="notebook-switcher__title">{active.title}</span>
        {sharedNotebooks?.has(active.id) ? (
          isReader(active.id)
            ? <Lock size={13} className="notebook-switcher__shared" aria-hidden="true" data-shared-notebook="true" />
            : <Users size={13} className="notebook-switcher__shared" aria-hidden="true" data-shared-notebook="true" />
        ) : null}
        {invitations.length > 0 ? (
          <span className="notebook-switcher__badge" aria-hidden="true" data-pending-invitations={invitations.length}>{invitations.length}</span>
        ) : null}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="notebook-switcher__popover"
          role="dialog"
          aria-label={t('switcher.title')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !menu.isOpen) {
              event.preventDefault();
              event.stopPropagation();
              hide(true);
            }
          }}
        >
          <input
            ref={inputRef}
            className="notebook-switcher__filter"
            type="search"
            role="combobox"
            aria-label={t('switcher.filter')}
            placeholder={t('switcher.filter')}
            aria-controls={listId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? `${id}-${activeOption.key}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveKey('');
            }}
            onKeyDown={(event) => {
              const index = activeOption ? options.indexOf(activeOption) : -1;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (options.length === 0) return;
                const next = options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length];
                setActiveKey(next.key);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(activeOption);
              } else if (event.key === 'F2') {
                if (activeOption?.kind !== 'notebook') return;
                event.preventDefault();
                startRename(activeOption.notebook);
              } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                if (activeOption?.kind !== 'notebook') return;
                event.preventDefault();
                const row = document.getElementById(`${id}-${activeOption.key}`);
                const rect = row?.getBoundingClientRect();
                openNotebookMenu({ x: (rect?.left ?? 0) + 12, y: rect?.bottom ?? 0 }, event.currentTarget, activeOption.notebook, activeOption.index);
              }
            }}
          />
          {invitations.length > 0 ? (
            <div className="notebook-switcher__invites" role="group" aria-labelledby={`${id}-invites`}>
              <p id={`${id}-invites`} className="notebook-switcher__label" role="presentation">{t('collab.invites.title')}</p>
              {invitations.map((invitation) => (
                <div className="notebook-switcher__invite" key={invitation.roomId} data-invitation-room={invitation.roomId}>
                  <Mail size={14} aria-hidden="true" />
                  <span className="notebook-switcher__option-title">
                    {invitation.notebookTitle || t('switcher.title')}
                    <small>
                      {invitation.invitedBy ? `${t('collab.invites.from', { name: invitation.invitedBy })} · ` : ''}
                      {t(`collab.role.${invitation.role}`)}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="notebook-switcher__invite-open"
                    disabled={invitationBusyRoomId !== null}
                    aria-label={t('collab.invites.openLabel', { title: invitation.notebookTitle })}
                    onClick={() => {
                      hide(false);
                      onOpenInvitation?.(invitation);
                    }}
                  >
                    {invitationBusyRoomId === invitation.roomId ? t('collab.invites.opening') : t('collab.invites.open')}
                  </button>
                  <button
                    type="button"
                    className="notebook-switcher__invite-decline"
                    disabled={invitationBusyRoomId !== null}
                    aria-label={t('collab.invites.declineLabel', { title: invitation.notebookTitle })}
                    onClick={() => onDeclineInvitation?.(invitation)}
                  >
                    {t('collab.invites.decline')}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div id={listId} className="notebook-switcher__list" role="listbox" aria-label={t('switcher.title')}>
            {notebookOptions.length > 0 ? (
              <div role="group" aria-labelledby={`${id}-notebooks`}>
                <p id={`${id}-notebooks`} className="notebook-switcher__label" role="presentation">{t('switcher.notebooks')}</p>
                {notebookOptions.map((option) => {
                  const isCurrent = option.notebook.id === activeNotebookId;
                  const trigger = contextMenuTriggerProps((point, element) => openNotebookMenu(point, element, option.notebook, option.index));
                  const renaming = renamingId === option.notebook.id;
                  return (
                    <div
                      key={option.key}
                      id={`${id}-${option.key}`}
                      role="option"
                      aria-selected={activeOption?.key === option.key}
                      aria-current={isCurrent ? 'true' : undefined}
                      className="notebook-switcher__option"
                      {...trigger}
                      onPointerDown={(event) => {
                        if (renaming) return;
                        trigger.onPointerDown(event);
                        // Keep focus in the filter field (combobox pattern).
                        if (event.pointerType !== 'touch') event.preventDefault();
                      }}
                      onPointerMove={(event) => {
                        trigger.onPointerMove(event);
                        setActiveKey(option.key);
                      }}
                      onClick={() => {
                        // Switching stays instant: a notebook is renamed from its
                        // menu or with F2, not by double click, which would have to
                        // delay every single click.
                        if (!renaming) choose(option);
                      }}
                    >
                      <NotebookMark notebook={option.notebook} />
                      {renaming ? (
                        <InlineRename
                          value={option.notebook.title}
                          label={t('workspace.notebook.renamePrompt')}
                          onDone={(title) => finishRename(option.notebook, title)}
                        />
                      ) : (
                        <span className="notebook-switcher__option-title">{option.notebook.title}</span>
                      )}
                      {sharedNotebooks?.has(option.notebook.id) ? (
                        isReader(option.notebook.id)
                          ? <Lock size={13} className="notebook-switcher__shared" aria-label={t('collab.readOnly.badge')} role="img" />
                          : <Users size={13} className="notebook-switcher__shared" aria-label={t('switcher.shared')} role="img" />
                      ) : null}
                      {option.notebook.id === previous?.id ? <small>{t('switcher.previous')}</small> : null}
                      {isCurrent ? <Check size={14} aria-label={t('switcher.current')} /> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {pageOptions.length > 0 ? (
              <div role="group" aria-labelledby={`${id}-pinned`}>
                <p id={`${id}-pinned`} className="notebook-switcher__label" role="presentation">{t('switcher.pinned')}</p>
                {pageOptions.map((option) => {
                  const trigger = contextMenuTriggerProps((point, element) => openPageMenu(point, element, option.entry));
                  return (
                    <div
                      key={option.key}
                      id={`${id}-${option.key}`}
                      role="option"
                      aria-selected={activeOption?.key === option.key}
                      className="notebook-switcher__option notebook-switcher__option--page"
                      {...trigger}
                      onPointerDown={(event) => {
                        trigger.onPointerDown(event);
                        if (event.pointerType !== 'touch') event.preventDefault();
                      }}
                      onPointerMove={(event) => {
                        trigger.onPointerMove(event);
                        setActiveKey(option.key);
                      }}
                      onClick={() => choose(option)}
                    >
                      <Pin size={13} aria-hidden="true" />
                      <span className="notebook-switcher__option-title">
                        {option.entry.title}
                        <small>
                          <span
                            className="notebook-switcher__section-dot"
                            style={{ background: sectionColor({ id: option.entry.sectionId, color: option.entry.sectionColor }) }}
                            aria-hidden="true"
                          />
                          {t('quickAccess.location', { notebook: option.entry.notebookTitle, section: option.entry.sectionTitle })}
                        </small>
                      </span>
                      {onUnpinPage && !readOnly ? (
                        <button
                          type="button"
                          className="notebook-switcher__unpin"
                          tabIndex={-1}
                          aria-label={`${t('menu.unpin')}: ${option.entry.title}`}
                          title={t('menu.unpin')}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onUnpinPage(option.entry);
                          }}
                        >
                          <PinOff size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {options.length === 0 ? <p className="notebook-switcher__empty">{t('switcher.empty')}</p> : null}
          </div>
          <div className="notebook-switcher__footer">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => {
                hide(false);
                onAddNotebook();
              }}
            >
              <Plus size={15} aria-hidden="true" /> {t('switcher.new')}
            </button>
          </div>
        </div>
      ) : null}
      {menu.element}
    </div>
  );
}
