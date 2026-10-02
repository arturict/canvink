import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import './FullPageNavigation.css';

/** A swipe towards the edge the panel came from, in pixels. */
const SWIPE_DISTANCE = 56;

/**
 * The slide-in navigation of the full page view: the ordinary navigation
 * (`children`) over the page, with a scrim behind it. It exists only while
 * open, so a closed panel never sits over the canvas and cannot take pen
 * input. It closes on a tap outside and on a swipe back to the left edge
 * (Escape is handled by the shell, which owns the full page keys).
 */
export default function FullPageNavigation({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx <= -SWIPE_DISTANCE && Math.abs(dy) < Math.abs(dx) / 2) onClose();
  };

  return (
    <div className="full-page-nav">
      <div className="full-page-nav__scrim" aria-hidden="true" onPointerDown={onClose} />
      <div
        ref={panelRef}
        className="full-page-nav__panel"
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { swipeRef.current = null; }}
      >
        {children}
      </div>
    </div>
  );
}
