import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from 'prosemirror-view';
import { useI18n } from '../../i18n';
import { SLASH_ITEMS, filterSlashItems, runSlashItem, slashMenuState, type SlashItem } from './slashMenu';

const MENU_WIDTH = 248;
const GAP = 6;

/**
 * The popup for the "/" block menu. It is portalled to the document body
 * with fixed positioning because the text sits inside the zoomed, transformed
 * canvas, which would otherwise become the containing block.
 */
export function SlashMenu({ view, items = SLASH_ITEMS }: { view: EditorView | null; items?: readonly SlashItem[] }) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const menu = view ? slashMenuState(view.state) : null;
  const matches = menu?.active ? filterSlashItems(menu.query, items) : [];
  const activeIndex = menu ? Math.min(menu.index, Math.max(0, matches.length - 1)) : 0;

  // Placed after layout so the list height is known and it can open upwards
  // near the bottom of the window.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!view || !menu?.active || !list) return;
    const caret = view.coordsAtPos(menu.from);
    const below = caret.bottom + GAP;
    const top = below + list.offsetHeight > window.innerHeight - 8
      ? Math.max(8, caret.top - GAP - list.offsetHeight)
      : below;
    list.style.left = `${Math.max(8, Math.min(caret.left, window.innerWidth - MENU_WIDTH - 8))}px`;
    list.style.top = `${top}px`;
  }, [view, menu?.active, menu?.from, menu?.query, matches.length]);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-slash-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!view || !menu?.active) return null;
  return createPortal(
    <div
      ref={listRef}
      className="canvink-slash-menu"
      role="listbox"
      aria-label={t('richText.slash.menu')}
      style={{ left: -9999, top: -9999, width: MENU_WIDTH }}
      onMouseDown={(event) => event.preventDefault()}
      // The portal still bubbles React events to the canvas, whose pointer
      // capture would swallow the click on an entry.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {matches.length === 0 ? (
        <p className="canvink-slash-menu__empty">{t('richText.slash.empty')}</p>
      ) : matches.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          data-slash-index={index}
          className="canvink-slash-menu__item"
          onClick={() => runSlashItem(view, item)}
        >
          <span>{t(item.labelKey)}</span>
          {item.hint ? <kbd>{item.hint}</kbd> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
