import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./CanvasContextMenu.css";

/**
 * Menu entries carry a plain command value instead of a callback; the owner
 * runs it in `onCommand`, an event handler, after the menu has closed.
 */
export interface CanvasMenuAction<C> {
  kind: "action";
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  command: C;
}

export interface CanvasMenuSwatches<C> {
  kind: "swatches";
  id: string;
  label: string;
  options: ReadonlyArray<{ id: string; label: string; checked: boolean; swatch: ReactNode; command: C }>;
}

export type CanvasMenuEntry<C> =
  | CanvasMenuAction<C>
  | CanvasMenuSwatches<C>
  | { kind: "separator"; id: string }
  | { kind: "heading"; id: string; label: string };

/**
 * The canvas context menu, modelled on OneNote's: opened by right-click,
 * Shift+F10 or the context-menu key, or a long press on touch. Arrow keys move
 * between items, Enter or Space runs one, Escape and a press outside close it.
 */
export function CanvasContextMenu<C>({
  label,
  position,
  entries,
  onClose,
  onCommand,
}: {
  label: string;
  position: { x: number; y: number };
  entries: readonly CanvasMenuEntry<C>[];
  onClose: (restoreFocus: boolean) => void;
  onCommand: (command: C) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = position.x + width > window.innerWidth - 8 ? Math.max(8, position.x - width) : position.x;
    const top = position.y + height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - height - 8) : position.y;
    setPlaced({ left, top });
  }, [position.x, position.y]);

  // Focus the first item once the menu is placed; a hidden menu takes no focus.
  const shown = placed !== null;
  useEffect(() => {
    if (!shown) return;
    menuRef.current
      ?.querySelector<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])")
      ?.focus({ preventScroll: true });
  }, [shown]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose(false);
    };
    const onDismiss = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onClose]);

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>(
    "[role^='menuitem']:not([aria-disabled='true'])",
  ) ?? [])];

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys in the menu never reach the canvas behind it.
    event.stopPropagation();
    if (event.key === "Escape" || (event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onClose(true);
      return;
    }
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = list[(index + 1) % list.length];
    else if (event.key === "ArrowUp") next = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list.at(-1);
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Within a row of swatches, left and right move sideways.
      const row = (document.activeElement as HTMLElement | null)?.closest("[role='group']");
      if (row) {
        const inRow = list.filter((item) => row.contains(item));
        const at = inRow.indexOf(document.activeElement as HTMLElement);
        next = inRow[(at + (event.key === "ArrowRight" ? 1 : inRow.length - 1)) % inRow.length];
      }
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const run = (command: C) => {
    onClose(true);
    onCommand(command);
  };

  return createPortal(
    <div
      ref={menuRef}
      className="canvas-context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={placed ? { left: placed.left, top: placed.top } : { left: position.x, top: position.y, visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry) => {
        if (entry.kind === "separator") return <div key={entry.id} className="canvas-context-menu__separator" role="separator" />;
        if (entry.kind === "heading") {
          return <div key={entry.id} className="canvas-context-menu__heading" role="presentation">{entry.label}</div>;
        }
        if (entry.kind === "swatches") {
          return (
            <div key={entry.id} className="canvas-context-menu__swatches" role="group" aria-label={entry.label}>
              {entry.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.checked}
                  aria-label={option.label}
                  title={option.label}
                  tabIndex={-1}
                  className="canvas-context-menu__swatch"
                  onClick={() => run(option.command)}
                >
                  {option.swatch}
                </button>
              ))}
            </div>
          );
        }
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="canvas-context-menu__item"
            aria-disabled={entry.disabled || undefined}
            onClick={() => {
              if (!entry.disabled) run(entry.command);
            }}
          >
            <span className="canvas-context-menu__icon" aria-hidden="true">{entry.icon}</span>
            <span className="canvas-context-menu__label">{entry.label}</span>
            {entry.shortcut ? <span className="canvas-context-menu__shortcut" aria-hidden="true">{entry.shortcut}</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
