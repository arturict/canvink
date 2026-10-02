import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';

export const NAV_COLUMN_LIMITS = {
  sections: { key: 'canvink:nav-width:sections', min: 160, max: 420, fallback: 230 },
  pages: { key: 'canvink:nav-width:pages', min: 180, max: 520, fallback: 240 },
} as const;

export type NavColumn = keyof typeof NAV_COLUMN_LIMITS;

const KEY_STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readWidth(column: NavColumn): number | undefined {
  const { key, min, max } = NAV_COLUMN_LIMITS[column];
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : undefined;
  } catch {
    return undefined;
  }
}

/** Width of a navigation column in px; `undefined` keeps the stylesheet's default. Kept per device. */
export function useColumnWidth(column: NavColumn): [number | undefined, (width: number) => void] {
  const [width, setWidth] = useState<number | undefined>(() => readWidth(column));
  const update = useCallback((next: number) => {
    const { key, min, max } = NAV_COLUMN_LIMITS[column];
    const clamped = clamp(next, min, max);
    setWidth(clamped);
    try {
      window.localStorage.setItem(key, String(clamped));
    } catch {
      // The width still applies for this session.
    }
  }, [column]);
  return [width, update];
}

/**
 * Drag handle between navigation columns, as in OneNote. It is a focusable
 * separator: arrow keys change the width, Home and End jump to its limits and
 * a double click restores the default.
 */
export function ColumnResizer({
  column,
  label,
  width,
  onResize,
}: {
  column: NavColumn;
  label: string;
  width: number | undefined;
  onResize: (width: number) => void;
}) {
  const { min, max, fallback } = NAV_COLUMN_LIMITS[column];
  const current = width ?? fallback;

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = current;
    const move = (moveEvent: globalThis.PointerEvent) => onResize(startWidth + moveEvent.clientX - startX);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next = event.key === 'ArrowLeft' ? current - step
      : event.key === 'ArrowRight' ? current + step
      : event.key === 'Home' ? min
      : event.key === 'End' ? max
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      className="nav-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={current}
      tabIndex={0}
      data-nav-resizer={column}
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(fallback)}
    />
  );
}
