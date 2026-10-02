import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, FolderClosed, X } from 'lucide-react';
import { buildSectionTree, type SectionGroupNode } from '../domain/sectionGroups';
import { useI18n } from '../i18n';
import { sectionColor } from './sectionColors';

interface MoveCopySection {
  id: string;
  title: string;
  color?: string;
  groupId?: string;
}

interface MoveCopyGroup {
  id: string;
  title: string;
  parentGroupId?: string;
}

export interface MoveCopyNotebook {
  id: string;
  title: string;
  color: string;
  sections: ReadonlyArray<MoveCopySection>;
  sectionGroups?: ReadonlyArray<MoveCopyGroup>;
}

export interface MoveCopyTarget {
  notebookId: string;
  /** Present when a page is moved into a section. */
  sectionId?: string;
  /** The section group a section or group moves into; absent: the top level. */
  groupId?: string;
}

export interface MoveCopyDialogProps {
  /**
   * "page" chooses a section; "section" chooses a notebook or a section
   * group; "group" chooses a place for a section group in its notebook.
   */
  kind: 'page' | 'section' | 'group';
  subjectTitle: string;
  notebooks: readonly MoveCopyNotebook[];
  current: MoveCopyTarget;
  /** Groups that cannot be a target (a moved group and its descendants). */
  excludedGroupIds?: ReadonlySet<string>;
  onMove: (target: MoveCopyTarget) => void;
  /** Absent when the subject can only be moved (section groups). */
  onCopy?: (target: MoveCopyTarget) => void;
  onClose: () => void;
  /** Focus goes back here when the dialog closes (the row that opened it). */
  returnFocus?: HTMLElement | null;
}

interface Option {
  key: string;
  target: MoveCopyTarget;
  label: string;
  color: string;
  icon: 'notebook' | 'group' | 'section';
  depth: number;
  selectable: boolean;
  /** Titles of the option and its enclosing notebook and groups, for the filter. */
  path: string[];
  parentKey?: string;
}

function sameTarget(left: MoveCopyTarget, right: MoveCopyTarget): boolean {
  return left.notebookId === right.notebookId
    && left.sectionId === right.sectionId
    && left.groupId === right.groupId;
}

function targetKey(target: MoveCopyTarget): string {
  return [target.notebookId, target.groupId ?? '', target.sectionId ?? ''].join('|');
}

/** Every notebook, group and section as a flat, indented list in navigation order. */
function allOptions(
  kind: MoveCopyDialogProps['kind'],
  notebooks: readonly MoveCopyNotebook[],
  excludedGroupIds: ReadonlySet<string>,
): Option[] {
  const options: Option[] = [];
  for (const notebook of notebooks) {
    const notebookTarget = { notebookId: notebook.id };
    const notebookKey = targetKey(notebookTarget);
    options.push({
      key: notebookKey,
      target: notebookTarget,
      label: notebook.title,
      color: notebook.color,
      icon: 'notebook',
      depth: 0,
      selectable: kind !== 'page',
      path: [notebook.title],
    });
    const tree = buildSectionTree(notebook.sections, notebook.sectionGroups ?? []);
    const addSections = (sections: readonly MoveCopySection[], depth: number, path: string[], parentKey: string) => {
      if (kind !== 'page') return;
      for (const section of sections) {
        const target = { notebookId: notebook.id, sectionId: section.id };
        options.push({
          key: targetKey(target),
          target,
          label: section.title,
          color: sectionColor(section),
          icon: 'section',
          depth,
          selectable: true,
          path: [...path, section.title],
          parentKey,
        });
      }
    };
    const addGroups = (groups: readonly SectionGroupNode<MoveCopySection, MoveCopyGroup>[], depth: number, path: string[], parentKey: string) => {
      for (const node of groups) {
        if (excludedGroupIds.has(node.group.id)) continue;
        const target = { notebookId: notebook.id, groupId: node.group.id };
        const key = targetKey(target);
        const groupPath = [...path, node.group.title];
        options.push({
          key,
          target,
          label: node.group.title,
          color: notebook.color,
          icon: 'group',
          depth,
          selectable: kind !== 'page',
          path: groupPath,
          parentKey,
        });
        addSections(node.sections, depth + 1, groupPath, key);
        addGroups(node.groups, depth + 1, groupPath, key);
      }
    };
    addSections(tree.sections, 1, [notebook.title], notebookKey);
    addGroups(tree.groups, 1, [notebook.title], notebookKey);
  }
  return options;
}

/**
 * OneNote's "Move or Copy" dialog: a filterable list of notebooks, section
 * groups and sections. The filter field drives the list (combobox pattern),
 * so the keyboard never has to leave it: arrows choose, Enter moves.
 */
export default function MoveCopyDialog({
  kind,
  subjectTitle,
  notebooks,
  current,
  excludedGroupIds,
  onMove,
  onCopy,
  onClose,
  returnFocus,
}: MoveCopyDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const everyOption = useMemo(
    () => allOptions(kind, notebooks, excludedGroupIds ?? new Set()),
    [excludedGroupIds, kind, notebooks],
  );
  const options = useMemo<Option[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return everyOption;
    // A match keeps its enclosing notebook and groups visible for context,
    // and a matching container keeps everything inside it.
    const matched = new Set(everyOption
      .filter((option) => option.path.some((title) => title.toLocaleLowerCase().includes(needle)))
      .map((option) => option.key));
    const byKey = new Map(everyOption.map((option) => [option.key, option]));
    for (const key of [...matched]) {
      for (let parent = byKey.get(key)?.parentKey; parent; parent = byKey.get(parent)?.parentKey) matched.add(parent);
    }
    return everyOption.filter((option) => matched.has(option.key)
      && (option.selectable || everyOption.some((candidate) => candidate.parentKey === option.key && matched.has(candidate.key))));
  }, [everyOption, query]);
  const selectable = options.filter((option) => option.selectable);
  const [selectedKey, setSelectedKey] = useState<string>(() => {
    const candidates = everyOption.filter((option) => option.selectable);
    return (candidates.find((option) => !sameTarget(option.target, current)) ?? candidates[0])?.key ?? '';
  });
  const selected = selectable.find((option) => option.key === selectedKey) ?? selectable[0];
  const moveDisabled = !selected || sameTarget(selected.target, current);

  useEffect(() => {
    const previous = returnFocus
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    inputRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // Only the element focused when the dialog opened matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.getElementById(`${id}-${selected?.key}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, selected?.key]);

  const step = (direction: 1 | -1) => {
    if (selectable.length === 0) return;
    const index = selected ? selectable.indexOf(selected) : -1;
    const next = selectable[(index + direction + selectable.length) % selectable.length];
    setSelectedKey(next.key);
  };

  const titleId = `${id}-title`;
  const listId = `${id}-list`;
  return (
    <div className="recovery-overlay move-copy-overlay" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="move-copy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="move-copy-dialog__header">
          <div>
            <h2 id={titleId}>{t(kind === 'page' ? 'moveCopy.page.title' : kind === 'section' ? 'moveCopy.section.title' : 'moveCopy.group.title')}</h2>
            <p>{subjectTitle}</p>
          </div>
          <button type="button" className="v2-icon-button" aria-label={t('moveCopy.cancel')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <input
          ref={inputRef}
          className="move-copy-dialog__filter"
          type="search"
          role="combobox"
          aria-label={t('moveCopy.filter')}
          placeholder={t('moveCopy.filter')}
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={selected ? `${id}-${selected.key}` : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              step(event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Enter' && selected && !moveDisabled) {
              event.preventDefault();
              onMove(selected.target);
            }
          }}
        />
        <div id={listId} className="move-copy-dialog__list" role="listbox" aria-label={t('moveCopy.targets')}>
          {options.length === 0 ? <p className="move-copy-dialog__empty">{t('moveCopy.empty')}</p> : null}
          {options.map((option) => {
            const isCurrent = sameTarget(option.target, current);
            const indent = { paddingLeft: 8 + option.depth * 18 };
            const icon = option.icon === 'notebook'
              ? <BookOpen size={14} aria-hidden="true" style={{ color: option.color }} />
              : option.icon === 'group'
                ? <FolderClosed size={14} aria-hidden="true" />
                : <span className="move-copy-dialog__swatch" style={{ background: option.color }} aria-hidden="true" />;
            if (!option.selectable) {
              return (
                <div key={option.key} className="move-copy-dialog__group" role="presentation" style={indent}>
                  {icon}
                  <span>{option.label}</span>
                </div>
              );
            }
            return (
              <div
                key={option.key}
                id={`${id}-${option.key}`}
                role="option"
                aria-selected={selected?.key === option.key}
                className="move-copy-dialog__option"
                style={indent}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setSelectedKey(option.key)}
                onDoubleClick={() => { if (!isCurrent) onMove(option.target); }}
              >
                {icon}
                <span>{option.label}</span>
                {isCurrent ? <small>{t('moveCopy.current')}</small> : null}
              </div>
            );
          })}
        </div>
        <footer className="move-copy-dialog__actions">
          <button type="button" className="move-copy-dialog__primary" disabled={moveDisabled} onClick={() => selected && onMove(selected.target)}>
            {t('moveCopy.move')}
          </button>
          {onCopy ? (
            <button type="button" disabled={!selected} onClick={() => selected && onCopy(selected.target)}>
              {t('moveCopy.copy')}
            </button>
          ) : null}
          <button type="button" onClick={onClose}>{t('moveCopy.cancel')}</button>
        </footer>
      </section>
    </div>
  );
}
