import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import {
  nextEnabledIndex,
  placeBelow,
  placeMenu,
  placeSubmenu,
  typeaheadIndex,
  type MenuPoint,
} from './contextMenuModel';

/**
 * The app's menu engine. As a OneNote-style context menu it opens at the
 * pointer on right-click, at the row on Shift+F10 or the context-menu key, and
 * after a long press on touch. As a button menu (`anchor`, see
 * `src/ui/AppMenuButton.tsx`) it opens under its button. One component for
 * sections, pages, notebooks, quick access and the title bar menus so every
 * menu looks and behaves the same (WAI-ARIA menu pattern: arrow keys,
 * Home/End, typeahead, Escape returns focus to the row that opened it).
 */

export interface ContextMenuItem {
  kind?: 'item';
  id: string;
  label: string;
  icon?: ReactNode;
  /** A colour swatch shown instead of an icon (section colours). */
  swatch?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a menuitemcheckbox/menuitemradio with this state. */
  checked?: boolean;
  role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
  /** Keyboard shortcut shown at the right edge, for example "Ctrl+G". */
  shortcut?: string;
  onSelect?: () => void;
  submenu?: readonly ContextMenuEntry[];
}

/**
 * A short either-or choice as one row: the label with a segmented control
 * (language: DE | EN). The row is one stop for Arrow Up/Down; Arrow
 * Left/Right move between its options and Enter chooses one.
 */
export interface ContextMenuSegmented {
  kind: 'segmented';
  id: string;
  label: string;
  icon?: ReactNode;
  options: ReadonlyArray<{ value: string; label: string; ariaLabel?: string }>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export interface ContextMenuSeparator {
  kind: 'separator';
  id: string;
}

/**
 * A block of content at the top of a menu that is not a command: who is signed
 * in, for example. It is skipped by the arrow keys and typeahead.
 */
export interface ContextMenuHeader {
  kind: 'header';
  id: string;
  content: ReactNode;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSegmented | ContextMenuSeparator | ContextMenuHeader;
type ContextMenuStop = ContextMenuItem | ContextMenuSegmented;

export interface ContextMenuAnchor {
  rect: { left: number; right: number; top: number; bottom: number };
  align: 'start' | 'end';
}

export interface ContextMenuRequest {
  point: MenuPoint;
  label: string;
  items: readonly ContextMenuEntry[];
  /** Receives focus again when the menu closes without running a command. */
  returnFocus?: HTMLElement | null;
  /**
   * Opens the menu under a button instead of at the pointer, with the compact
   * app-menu look. The button keeps receiving its own clicks while the menu
   * is open, so it can toggle the menu, and gets the focus back after a
   * command ran.
   */
  anchor?: ContextMenuAnchor;
}

function isItem(entry: ContextMenuEntry): entry is ContextMenuStop {
  return entry.kind !== 'separator' && entry.kind !== 'header';
}

function submenuOf(entry: ContextMenuStop | undefined): readonly ContextMenuEntry[] | undefined {
  return entry && entry.kind !== 'segmented' ? entry.submenu : undefined;
}

interface PanelProps {
  label: string;
  entries: readonly ContextMenuEntry[];
  place: (size: { width: number; height: number }) => MenuPoint;
  depth: number;
  /** Compact button-menu look with the shared app-menu spacing. */
  app?: boolean;
  onCloseAll: (restoreFocus: boolean) => void;
  /** Submenus only: closes this level and focuses the parent item again. */
  onCloseSelf?: () => void;
}

function MenuPanel({ label, entries, place, depth, app = false, onCloseAll, onCloseSelf }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Per segmented row: the option that holds the focus.
  const segmentRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const [segment, setSegment] = useState(0);
  const items = entries.filter(isItem);
  const enabled = items.map((item) => !item.disabled);
  const [active, setActive] = useState(() => nextEnabledIndex(enabled, -1, 1));
  const [position, setPosition] = useState<MenuPoint | null>(null);
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    setPosition(place({ width: panel.offsetWidth, height: panel.offsetHeight }));
    // Placement depends only on the first measured size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!position || submenuIndex !== null) return;
    const current = items[active];
    if (current?.kind === 'segmented') segmentRefs.current.get(`${current.id}:${segment}`)?.focus({ preventScroll: true });
    else if (active >= 0) itemRefs.current[active]?.focus({ preventScroll: true });
    else panelRef.current?.focus({ preventScroll: true });
    // `items` is derived from `entries` on every render; the focus follows the indices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, segment, position, submenuIndex]);

  const moveTo = (index: number) => {
    setActive(index);
    const target = items[index];
    if (target?.kind === 'segmented') {
      const checked = target.options.findIndex((option) => option.value === target.value);
      setSegment(Math.max(0, checked));
    }
  };

  // A command that ran from a button menu hands the focus back to the button;
  // a dialog it opens takes it from there.
  const activate = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    if (item.kind === 'segmented') {
      const option = item.options[segment];
      onCloseAll(app);
      if (option) item.onChange(option.value);
      return;
    }
    if (item.submenu) {
      setActive(index);
      setSubmenuIndex(index);
      return;
    }
    onCloseAll(app);
    item.onSelect?.();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys belong to the innermost open level only.
    if (submenuIndex !== null) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      moveTo(nextEnabledIndex(enabled, active, key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      moveTo(key === 'Home' ? nextEnabledIndex(enabled, -1, 1) : nextEnabledIndex(enabled, 0, -1));
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      activate(active);
    } else if ((key === 'ArrowRight' || key === 'ArrowLeft') && items[active]?.kind === 'segmented') {
      event.preventDefault();
      const options = (items[active] as ContextMenuSegmented).options.length;
      setSegment((current) => Math.min(options - 1, Math.max(0, current + (key === 'ArrowRight' ? 1 : -1))));
    } else if (key === 'ArrowRight') {
      event.preventDefault();
      if (submenuOf(items[active])) activate(active);
    } else if (key === 'ArrowLeft' && onCloseSelf) {
      event.preventDefault();
      onCloseSelf();
    } else if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (onCloseSelf) onCloseSelf();
      else onCloseAll(true);
    } else if (key === 'Tab') {
      event.preventDefault();
      onCloseAll(true);
    } else if (key.length === 1 && /\S/u.test(key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const index = typeaheadIndex(items.map((item) => item.label), enabled, active, key);
      if (index >= 0) moveTo(index);
    }
    event.stopPropagation();
  };

  const indexById = new Map(items.map((item, index) => [item.id, index]));
  return (
    <div
      ref={panelRef}
      className={app ? 'context-menu context-menu--app' : 'context-menu'}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      data-depth={depth}
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry) => {
        if (entry.kind === 'header') {
          return <div key={entry.id} className="context-menu__header" role="presentation">{entry.content}</div>;
        }
        if (!isItem(entry)) return <div key={entry.id} className="context-menu__separator" role="separator" />;
        const index = indexById.get(entry.id) ?? -1;
        if (entry.kind === 'segmented') {
          return (
            <div
              key={entry.id}
              className="context-menu__segmented-row"
              role="group"
              aria-label={entry.label}
              data-menu-item={entry.id}
              onPointerEnter={() => { if (!entry.disabled) moveTo(index); }}
            >
              <span className="context-menu__icon" aria-hidden="true">{entry.icon}</span>
              <span className="context-menu__label" aria-hidden="true">{entry.label}</span>
              <span className="context-menu__segmented">
                {entry.options.map((option, optionIndex) => {
                  const checked = option.value === entry.value;
                  return (
                    <button
                      key={option.value}
                      ref={(element) => { segmentRefs.current.set(`${entry.id}:${optionIndex}`, element); }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      aria-label={option.ariaLabel}
                      aria-disabled={entry.disabled || undefined}
                      tabIndex={index === active && optionIndex === segment ? 0 : -1}
                      className="context-menu__segment"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (entry.disabled) return;
                        onCloseAll(app);
                        entry.onChange(option.value);
                      }}
                      onFocus={() => { setActive(index); setSegment(optionIndex); }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </span>
            </div>
          );
        }
        const role = entry.role ?? (entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        const expanded = submenuIndex === index;
        return (
          <button
            key={entry.id}
            ref={(element) => { itemRefs.current[index] = element; }}
            type="button"
            role={role}
            tabIndex={index === active ? 0 : -1}
            className={`context-menu__item${entry.danger ? ' context-menu__item--danger' : ''}`}
            aria-disabled={entry.disabled || undefined}
            aria-checked={role === 'menuitem' ? undefined : Boolean(entry.checked)}
            aria-haspopup={entry.submenu ? 'menu' : undefined}
            aria-expanded={entry.submenu ? expanded : undefined}
            aria-keyshortcuts={entry.shortcut}
            data-menu-item={entry.id}
            onPointerEnter={() => {
              if (entry.disabled) return;
              setActive(index);
              if (entry.submenu) setSubmenuIndex(index);
              else if (submenuIndex !== null) setSubmenuIndex(null);
            }}
            // Focus follows the pointer through `active`; a press must not pull it
            // back from a submenu that the pointer has just opened.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => activate(index)}
          >
            <span className="context-menu__icon" aria-hidden="true">
              {entry.swatch ? <span className="context-menu__swatch" style={{ background: entry.swatch }} /> : null}
              {!entry.swatch && entry.checked ? <Check size={14} /> : null}
              {!entry.swatch && !entry.checked ? entry.icon : null}
            </span>
            <span className="context-menu__label">{entry.label}</span>
            {entry.shortcut ? <kbd className="context-menu__shortcut">{entry.shortcut}</kbd> : null}
            {entry.submenu ? <ChevronRight size={14} aria-hidden="true" className="context-menu__chevron" /> : null}
          </button>
        );
      })}
      {submenuIndex !== null && submenuOf(items[submenuIndex]) ? (
        <SubmenuHost
          key={items[submenuIndex].id}
          label={items[submenuIndex].label}
          entries={submenuOf(items[submenuIndex]) ?? []}
          getAnchor={() => itemRefs.current[submenuIndex] ?? null}
          depth={depth + 1}
          app={app}
          onCloseAll={onCloseAll}
          onCloseSelf={() => {
            const index = submenuIndex;
            setSubmenuIndex(null);
            itemRefs.current[index]?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

function SubmenuHost({
  label,
  entries,
  getAnchor,
  depth,
  app,
  onCloseAll,
  onCloseSelf,
}: {
  label: string;
  entries: readonly ContextMenuEntry[];
  getAnchor: () => HTMLElement | null;
  depth: number;
  app: boolean;
  onCloseAll: (restoreFocus: boolean) => void;
  onCloseSelf: () => void;
}) {
  // Rendered into the body so the submenu is not clipped by the parent's
  // scroll area and clicks inside it do not bubble to the parent item.
  return createPortal(
    <MenuPanel
      label={label}
      entries={entries}
      depth={depth}
      app={app}
      onCloseAll={onCloseAll}
      onCloseSelf={onCloseSelf}
      place={(size) => {
        const rect = getAnchor()?.getBoundingClientRect();
        return placeSubmenu(
          { left: rect?.left ?? 0, right: rect?.right ?? 0, top: rect?.top ?? 0 },
          size,
          { width: window.innerWidth, height: window.innerHeight },
        );
      }}
    />,
    document.body,
  );
}

/**
 * State and element for one context menu. Render `element` anywhere; call
 * `open` from a trigger (see `contextMenuTriggerProps`).
 */
export function useContextMenu(): {
  element: ReactNode;
  open: (request: ContextMenuRequest) => void;
  close: () => void;
  isOpen: boolean;
} {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const requestRef = useRef<ContextMenuRequest | null>(null);
  useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);

  const closeAll = useCallback((restoreFocus: boolean) => {
    const current = requestRef.current;
    setRequest(null);
    if (restoreFocus) current?.returnFocus?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!request) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.context-menu')) return;
      // The button that opened a button menu closes it itself with its click.
      if (request.anchor && target instanceof Node && request.returnFocus?.contains(target)) return;
      closeAll(false);
    };
    const onResize = () => closeAll(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onResize);
    };
  }, [closeAll, request]);

  const element = request && typeof document !== 'undefined'
    ? createPortal(
      <MenuPanel
        // A new request replaces the old menu instead of reusing its state.
        key={`${request.point.x}:${request.point.y}:${request.label}`}
        label={request.label}
        entries={request.items}
        depth={0}
        app={Boolean(request.anchor)}
        onCloseAll={closeAll}
        place={(size) => {
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          return request.anchor
            ? placeBelow(request.anchor.rect, size, viewport, request.anchor.align)
            : placeMenu(request.point, size, viewport);
        }}
      />,
      document.body,
    )
    : null;

  return {
    element,
    open: setRequest,
    close: useCallback(() => closeAll(false), [closeAll]),
    isOpen: request !== null,
  };
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/**
 * Only one finger can long-press at a time, so the pending press lives at
 * module level instead of in every row's state.
 */
let pendingPress: { timer: number; x: number; y: number; pointerId: number } | null = null;
let longPressFiredAt = 0;

function cancelLongPress(): void {
  if (pendingPress) window.clearTimeout(pendingPress.timer);
  pendingPress = null;
}

export interface ContextMenuTriggerProps {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * Event handlers that open a context menu from a row. The browser's own menu
 * is suppressed only on elements that carry these handlers.
 */
export function contextMenuTriggerProps(
  openAt: (point: MenuPoint, trigger: HTMLElement) => void,
): ContextMenuTriggerProps {
  return {
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Chrome on Android also fires contextmenu after our own long press.
      if (Date.now() - longPressFiredAt < 900) return;
      const trigger = event.currentTarget;
      if (event.button === -1 || (event.clientX === 0 && event.clientY === 0)) {
        const rect = trigger.getBoundingClientRect();
        openAt({ x: rect.left + 12, y: rect.bottom }, trigger);
      } else {
        openAt({ x: event.clientX, y: event.clientY }, trigger);
      }
    },
    onKeyDown: (event) => {
      if (!((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return;
      event.preventDefault();
      event.stopPropagation();
      const trigger = event.currentTarget;
      const rect = trigger.getBoundingClientRect();
      openAt({ x: rect.left + 12, y: rect.bottom }, trigger);
    },
    onPointerDown: (event) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      cancelLongPress();
      const trigger = event.currentTarget;
      const { clientX, clientY, pointerId } = event;
      pendingPress = {
        x: clientX,
        y: clientY,
        pointerId,
        timer: window.setTimeout(() => {
          pendingPress = null;
          longPressFiredAt = Date.now();
          openAt({ x: clientX, y: clientY }, trigger);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (event) => {
      if (!pendingPress || pendingPress.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - pendingPress.x, event.clientY - pendingPress.y) > LONG_PRESS_SLOP) cancelLongPress();
    },
    onPointerUp: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onClickCapture: (event) => {
      // The finger lifting after a long press must not also open the row.
      if (Date.now() - longPressFiredAt < 900) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}
