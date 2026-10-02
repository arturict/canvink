import { useEffect } from 'react';

/**
 * The app's dropdown menus are native <details> elements, which only close
 * when their own summary is clicked. Desktop menus (and OneNote's) close on
 * Escape and on a click anywhere else; this restores that behaviour for the
 * menus below. Disclosure panels such as sync details are deliberately not
 * listed: they are content, not menus.
 */
const MENU_SELECTOR = [
  '.action-menu',
  '.live-canvas-toolbar__menu',
  '.page-settings-menu',
  '.page-template-menu',
  '.page-tag-menu',
  '.presence-menu',
  '.sidebar-create-menu',
  '.sync-status',
].map((selector) => `details${selector}[open]`).join(', ');

function openMenus(root: ParentNode): HTMLDetailsElement[] {
  return [...root.querySelectorAll<HTMLDetailsElement>(MENU_SELECTOR)];
}

/** Closes every open menu that does not contain `target`. */
export function closeMenusOutside(root: ParentNode, target: Node | null): void {
  for (const menu of openMenus(root)) {
    if (target && menu.contains(target)) continue;
    menu.open = false;
  }
}

/**
 * Escape closes the innermost open menu around the focus and returns focus to
 * its summary; with focus elsewhere it closes all open menus. Returns whether
 * a menu was closed.
 */
export function closeMenusOnEscape(root: ParentNode, focused: Element | null): boolean {
  const menus = openMenus(root);
  if (menus.length === 0) return false;
  const around = menus.filter((menu) => focused && menu.contains(focused));
  const innermost = around.at(-1);
  if (innermost) {
    innermost.open = false;
    innermost.querySelector('summary')?.focus();
    return true;
  }
  for (const menu of menus) menu.open = false;
  return true;
}

export function useDismissibleMenus(): void {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      closeMenusOutside(document, event.target instanceof Node ? event.target : null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      closeMenusOnEscape(document, document.activeElement);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
