import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useI18n } from '../../i18n';
import { foldForMatch } from './searchHighlight';

export interface PickerOption {
  id: string;
  label: string;
  /** Secondary text that tells namesakes apart, for example the page count. */
  hint?: string;
  color?: string;
}

export interface PickerGroup {
  id: string;
  label: string;
  hint?: string;
  color?: string;
  options: PickerOption[];
}

export interface SearchPickerProps {
  /** Text on the chip. */
  label: string;
  /** Accessible name of the opened list. */
  menuLabel: string;
  options?: readonly PickerOption[];
  /** Options nested under collapsible headings; wins over `options`. */
  groups?: readonly PickerGroup[];
  selected: readonly string[];
  /** Adds a type-to-filter field above the list. */
  searchable?: boolean;
  emptyText: string;
  onChange(ids: string[]): void;
  /** Extra controls under the list, such as a switch. */
  footer?: ReactNode;
  /** Disables the chip, for a filter with nothing to pick. */
  disabled?: boolean;
}

type Row =
  | { kind: 'group'; id: string; group: PickerGroup; expanded: boolean }
  | { kind: 'option'; id: string; option: PickerOption; groupId?: string };

/** Starting past this many options, groups without a selection start collapsed. */
const COLLAPSE_ABOVE = 30;

/**
 * A filter chip that opens a small, bounded multi-select list: optional type-to-filter
 * field, collapsible groups, checkboxes for several choices. Keyboard focus
 * stays on the field (or the list) and the highlighted row is announced with
 * aria-activedescendant, so the whole picker works without a pointer.
 * Self-contained on purpose so it can be swapped for a shared menu later.
 */
export default function SearchPicker({
  label,
  menuLabel,
  options = [],
  groups,
  selected,
  searchable = false,
  emptyText,
  onChange,
  footer,
  disabled = false,
}: SearchPickerProps) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);
  const [alignEnd, setAlignEnd] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLInputElement & HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const term = foldForMatch(filter.trim());

  const rows = useMemo<Row[]>(() => {
    const matches = (option: PickerOption) => !term || foldForMatch(`${option.label} ${option.hint ?? ''}`).includes(term);
    if (groups) {
      return groups.flatMap((group): Row[] => {
        const visible = group.options.filter((option) => !term || matches(option) || foldForMatch(group.label).includes(term));
        if (visible.length === 0) return [];
        // Typing opens every group that still has a match.
        const expanded = Boolean(term) || !collapsed.has(group.id);
        return [
          { kind: 'group', id: `${id}-g-${group.id}`, group, expanded },
          ...(expanded
            ? visible.map((option): Row => ({ kind: 'option', id: `${id}-o-${option.id}`, option, groupId: group.id }))
            : []),
        ];
      });
    }
    return options.filter(matches).map((option): Row => ({ kind: 'option', id: `${id}-o-${option.id}`, option }));
  }, [collapsed, groups, id, options, term]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setFilter('');
    if (returnFocus) document.getElementById(`${id}-chip`)?.focus();
  }, [id]);

  const openPicker = () => {
    if (groups) {
      const total = groups.reduce((sum, group) => sum + group.options.length, 0);
      setCollapsed(total > COLLAPSE_ABOVE
        ? new Set(groups.filter((group) => !group.options.some((option) => selectedSet.has(option.id))).map((group) => group.id))
        : new Set());
    }
    setActive(0);
    setOpen(true);
  };

  useEffect(() => {
    if (open) focusRef.current?.focus();
  }, [open]);

  // Keep the popover inside the viewport: a chip near the right edge opens leftwards.
  useLayoutEffect(() => {
    if (!open || !wrapperRef.current || !popoverRef.current) return;
    const chip = wrapperRef.current.getBoundingClientRect();
    const width = popoverRef.current.offsetWidth;
    setAlignEnd(chip.left + width > window.innerWidth - 8 && chip.right - width >= 8);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [close, open]);

  const activeRow = rows[Math.min(active, rows.length - 1)];
  useEffect(() => {
    if (open && activeRow) document.getElementById(activeRow.id)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeRow, open]);

  const toggleOption = (option: PickerOption) => {
    onChange(selectedSet.has(option.id) ? selected.filter((item) => item !== option.id) : [...selected, option.id]);
  };

  const toggleGroup = (groupId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'group') toggleGroup(row.group.id);
    else toggleOption(row.option);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const last = rows.length - 1;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.min(last, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Home' && !searchable) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && !searchable) {
      event.preventDefault();
      setActive(Math.max(0, last));
    } else if (event.key === 'Enter' || (event.key === ' ' && !searchable)) {
      event.preventDefault();
      activate(activeRow);
    } else if (groups && activeRow && !term && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const expand = event.key === 'ArrowRight';
      if (activeRow.kind === 'group') {
        if (activeRow.expanded !== expand) {
          event.preventDefault();
          toggleGroup(activeRow.group.id);
        }
      } else if (!expand && activeRow.groupId) {
        event.preventDefault();
        setActive(rows.findIndex((row) => row.kind === 'group' && row.group.id === activeRow.groupId));
      }
    }
  };

  const chipKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      openPicker();
    }
  };

  const listRole = groups ? 'tree' : 'listbox';
  const listId = `${id}-list`;
  const optionRole = groups ? 'treeitem' : 'option';

  return (
    <div className="search-picker" ref={wrapperRef} data-align={alignEnd ? 'end' : undefined}>
      <button
        id={`${id}-chip`}
        type="button"
        className="search-chip"
        data-active={selected.length > 0 ? 'true' : undefined}
        aria-haspopup={listRole}
        aria-expanded={open}
        aria-controls={open ? `${id}-popover` : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={chipKeyDown}
      >
        <span>{label}</span>
        {selected.length > 0 ? <span className="search-chip__count">{selected.length}</span> : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          id={`${id}-popover`}
          className="search-popover"
          onKeyDown={keyDown}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && !wrapperRef.current?.contains(event.relatedTarget)) close(false);
          }}
        >
          {searchable ? (
            <div className="search-popover__field">
              <Search size={14} aria-hidden="true" />
              <input
                ref={focusRef}
                type="text"
                role="combobox"
                aria-label={menuLabel}
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeRow?.id}
                aria-autocomplete="list"
                placeholder={t('search.pick.filter')}
                value={filter}
                onChange={(event) => { setFilter(event.target.value); setActive(0); }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : null}
          <div
            ref={searchable ? undefined : focusRef}
            id={listId}
            className="search-popover__list"
            role={listRole}
            aria-label={menuLabel}
            aria-multiselectable
            aria-activedescendant={searchable ? undefined : activeRow?.id}
            tabIndex={searchable ? -1 : 0}
          >
            {rows.length === 0 ? <p className="search-popover__empty">{emptyText}</p> : rows.map((row, index) => {
              const isActive = row === activeRow;
              if (row.kind === 'group') {
                return (
                  <div
                    key={row.id}
                    id={row.id}
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={row.expanded}
                    className="search-row search-row--group"
                    data-active={isActive ? 'true' : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { setActive(index); toggleGroup(row.group.id); }}
                  >
                    {row.expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                    {row.group.color ? <span className="search-dot" style={{ background: row.group.color }} aria-hidden="true" /> : null}
                    <span className="search-row__label">{row.group.label}</span>
                    {row.group.hint ? <span className="search-row__hint">{row.group.hint}</span> : null}
                  </div>
                );
              }
              const checked = selectedSet.has(row.option.id);
              return (
                <div
                  key={row.id}
                  id={row.id}
                  role={optionRole}
                  aria-level={groups ? 2 : undefined}
                  aria-selected={checked}
                  className="search-row"
                  data-nested={row.groupId ? 'true' : undefined}
                  data-active={isActive ? 'true' : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { setActive(index); toggleOption(row.option); }}
                >
                  <span className="search-check" data-checked={checked ? 'true' : undefined} aria-hidden="true">
                    {checked ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                  {row.option.color ? <span className="search-dot" style={{ background: row.option.color }} aria-hidden="true" /> : null}
                  <span className="search-row__label">{row.option.label}</span>
                  {row.option.hint ? <span className="search-row__hint">{row.option.hint}</span> : null}
                </div>
              );
            })}
          </div>
          {footer || selected.length > 0 ? (
            <div className="search-popover__footer">
              {selected.length > 0 ? (
                <button type="button" className="search-link" onClick={() => onChange([])}>
                  {t('search.pick.clear')}
                </button>
              ) : null}
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
