import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { useBackLayer } from './backStack';
import { haptic } from './nativeBridge';

/**
 * The phone shell's building blocks, styled in mobile.css: Material 3's
 * patterns (top app bar with a large title that collapses, list rows, bottom
 * sheets, chips, pull to refresh) in Canvink's paper and ink.
 */

/**
 * A touch ripple from the finger's position for every element marked
 * `.m-ripple` (Android's pressed feedback). One listener for the whole shell.
 */
export function installRipple(root: HTMLElement): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.m-ripple') : null;
    if (!target || target.matches(':disabled, [aria-disabled="true"]')) return;
    const rect = target.getBoundingClientRect();
    const size = Math.hypot(rect.width, rect.height) * 2;
    const wave = document.createElement('span');
    wave.className = 'm-ripple__wave';
    wave.style.width = wave.style.height = `${size}px`;
    wave.style.left = `${event.clientX - rect.left - size / 2}px`;
    wave.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.appendChild(wave);
    const release = () => {
      wave.dataset.released = 'true';
      window.setTimeout(() => wave.remove(), 420);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };
  root.addEventListener('pointerdown', onPointerDown, { passive: true });
  return () => root.removeEventListener('pointerdown', onPointerDown);
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button type="button" className={`m-icon-button m-ripple${className ? ` ${className}` : ''}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

/** How far a list has scrolled, as `data-scrolled` and `--m-collapse` (0 to 1) on the screen. */
function useCollapsingTitle(scrollRef: RefObject<HTMLElement | null>, screenRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scroller = scrollRef.current;
    const screen = screenRef.current;
    if (!scroller || !screen) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const progress = Math.min(1, Math.max(0, scroller.scrollTop / 56));
      screen.style.setProperty('--m-collapse', progress.toFixed(3));
      screen.dataset.scrolled = scroller.scrollTop > 4 ? 'true' : 'false';
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, screenRef]);
}

export interface ListScreenProps {
  title: string;
  /** A line under the large title (a notebook's section count, the sync status). */
  subtitle?: ReactNode;
  /** Back arrow at the start of the bar; without it the screen is a tab's first screen. */
  onBack?: () => void;
  actions?: ReactNode;
  /** A colour band behind the large title (a section's colour). */
  accent?: string;
  /** Pull down at the top to sync. */
  onRefresh?: () => Promise<void> | void;
  children: ReactNode;
  /** Content fixed under the bar (section chips). */
  header?: ReactNode;
  testId?: string;
}

/** A list screen with Material's large top app bar: the title collapses into the bar on scroll. */
export function ListScreen({ title, subtitle, onBack, actions, accent, onRefresh, children, header, testId }: ListScreenProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useCollapsingTitle(scrollRef, screenRef);
  const style = accent ? ({ '--m-accent-band': accent } as CSSProperties) : undefined;
  return (
    <section ref={screenRef} className="m-list-screen" aria-labelledby={titleId} data-testid={testId} style={style} data-accent={accent ? 'true' : undefined}>
      <header className="m-topbar">
        {onBack ? (
          <IconButton label={t('mobile.back')} onClick={onBack} className="m-topbar__back">
            <ArrowLeft size={22} aria-hidden="true" />
          </IconButton>
        ) : null}
        <span className="m-topbar__title" aria-hidden="true">{title}</span>
        <div className="m-topbar__actions">{actions}</div>
      </header>
      <PullToRefresh scrollRef={scrollRef} onRefresh={onRefresh}>
        <div ref={scrollRef} className="m-scroll">
          <div className="m-large-title">
            <h1 id={titleId}>{title}</h1>
            {subtitle ? <div className="m-large-title__subtitle">{subtitle}</div> : null}
          </div>
          {header ? <div className="m-list-screen__header">{header}</div> : null}
          {children}
        </div>
      </PullToRefresh>
    </section>
  );
}

/**
 * Pull down at the top of a list to sync, with Material's circular
 * indicator. Scrolling is native; only a pull at the very top is handled.
 */
function PullToRefresh({
  scrollRef,
  onRefresh,
  children,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  onRefresh?: () => Promise<void> | void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });
  const enabled = Boolean(onRefresh);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !enabled) return undefined;
    let start: { x: number; y: number } | null = null;
    let active = false;
    const threshold = 72;
    const onStart = (event: TouchEvent) => {
      if (scroller.scrollTop > 0 || event.touches.length !== 1) {
        start = null;
        return;
      }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      active = false;
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const dy = event.touches[0].clientY - start.y;
      const dx = event.touches[0].clientX - start.x;
      if (!active) {
        if (dy < 8 || Math.abs(dx) > dy) {
          if (dy < -4 || Math.abs(dx) > 12) start = null;
          return;
        }
        active = true;
      }
      if (scroller.scrollTop > 0) return;
      event.preventDefault();
      const distance = Math.min(140, dy * 0.5);
      if (pullRef.current < threshold && distance >= threshold) haptic('tick');
      pullRef.current = distance;
      setPull(distance);
    };
    const onEnd = () => {
      if (!active) {
        start = null;
        return;
      }
      const reached = pullRef.current >= threshold;
      start = null;
      active = false;
      pullRef.current = 0;
      setPull(0);
      if (!reached) return;
      setRefreshing(true);
      const minimum = new Promise((resolve) => window.setTimeout(resolve, 900));
      void Promise.all([Promise.resolve(onRefreshRef.current?.()), minimum]).finally(() => setRefreshing(false));
    };
    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, scrollRef]);
  const shown = refreshing ? 56 : pull;
  return (
    <div className="m-pull" data-pulling={pull > 0 ? 'true' : undefined}>
      {enabled ? (
        <div
          className="m-pull__indicator"
          role={refreshing ? 'status' : undefined}
          aria-label={refreshing ? t('mobile.sync.running') : undefined}
          data-refreshing={refreshing ? 'true' : undefined}
          style={{ transform: `translate(-50%, ${shown - 48}px) rotate(${pull * 3}deg)`, opacity: shown > 0 ? Math.min(1, shown / 48) : 0 }}
        >
          <RefreshCw size={20} aria-hidden="true" />
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function SectionDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span className="m-dot" style={{ background: color, width: size, height: size }} aria-hidden="true" />;
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="m-empty">
      <div className="m-empty__icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
      {action}
    </div>
  );
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  testId?: string;
}

/**
 * Material's modal bottom sheet: slides up over a scrim, closes with back, a
 * tap on the scrim or a drag down.
 */
export function Sheet({ open, onClose, title, children, testId }: SheetProps) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ start: number; distance: number } | null>(null);
  const titleId = useId();
  useBackLayer(open, onClose);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(() => {
      setShown(false);
      setMounted(false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, open]);
  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    dragRef.current = { start: event.clientY, distance: 0 };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, []);
  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    if (!drag || !sheet) return;
    drag.distance = Math.max(0, event.clientY - drag.start);
    sheet.style.transform = `translateY(${drag.distance}px)`;
    sheet.style.transition = 'none';
  }, []);
  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    dragRef.current = null;
    if (!drag || !sheet) return;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (drag.distance > 90) onClose();
  }, [onClose]);
  if (!mounted) return null;
  return (
    <div className="m-sheet-root" data-shown={open && shown ? 'true' : 'false'} data-testid={testId}>
      <div className="m-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <section
        ref={sheetRef}
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : t('mobile.sheet')}
      >
        <div
          className="m-sheet__grip"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span aria-hidden="true" />
          {title ? <h2 id={titleId}>{title}</h2> : null}
        </div>
        <div className="m-sheet__content">{children}</div>
      </section>
    </div>
  );
}

export function SheetAction({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button type="button" className={`m-sheet-action m-ripple${danger ? ' is-danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="m-sheet-action__icon" aria-hidden="true">{icon}</span>
      <span className="m-sheet-action__text">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  );
}
