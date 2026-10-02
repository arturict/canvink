import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useContextMenu, type ContextMenuEntry } from './ContextMenu';

export interface AppMenuButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children' | 'onClick'> {
  /** Accessible name of the button and of the menu it opens. */
  label: string;
  /** A function builds the items when the menu opens, so they are always current. */
  items: readonly ContextMenuEntry[] | (() => readonly ContextMenuEntry[]);
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end';
  children: ReactNode;
}

/**
 * A button that opens an app menu under it: the shared menu engine
 * (`ContextMenu.tsx`) with the compact look of `.context-menu--app`. It
 * brings the whole menu contract, so callers only list their items: arrow
 * keys, Home/End and typeahead, Escape and a click outside close it and the
 * focus returns to the button, and the roles are menu/menuitem. Down arrow,
 * Enter and Space on the button open it with the first item focused.
 */
/**
 * Joins menu groups with a separator between each pair of non-empty groups,
 * so a group whose items are all unavailable leaves no stray divider.
 */
export function menuGroups(groups: ReadonlyArray<ReadonlyArray<ContextMenuEntry | false | null>>, idPrefix: string): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];
  groups.forEach((group, index) => {
    const present = group.filter((entry): entry is ContextMenuEntry => Boolean(entry));
    if (present.length === 0) return;
    if (entries.length > 0) entries.push({ kind: 'separator', id: `${idPrefix}-separator-${index}` });
    entries.push(...present);
  });
  return entries;
}

export function AppMenuButton({ label, items, align = 'end', children, className, onKeyDown, ...rest }: AppMenuButtonProps) {
  const menu = useContextMenu();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const open = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    menu.open({
      point: { x: rect.left, y: rect.bottom },
      anchor: { rect, align },
      label,
      items: typeof items === 'function' ? items() : items,
      returnFocus: button,
    });
  };

  return (
    <>
      <button
        {...rest}
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        onClick={() => (menu.isOpen ? menu.close() : open())}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === 'ArrowDown' && !menu.isOpen) {
            event.preventDefault();
            open();
          }
        }}
      >
        {children}
      </button>
      {menu.element}
    </>
  );
}
