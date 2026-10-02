import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { previewCenter, type PresenceHub } from '../../../collab/presence';
import { useI18n } from '../../../i18n';
import { drawPagePreview, previewSpan, PREVIEW_DEFAULT_SPAN } from './pagePreview';
import type { PreviewContent } from './previewPage';

/** Diameter of the round preview in CSS pixels. */
export const PREVIEW_SIZE = 168;
/** A page read for a preview is reused this long, so hovering back and forth does not re-read it. */
const PAGE_CACHE_MS = 5_000;

const contentCache = new Map<string, { at: number; content: Promise<PreviewContent | null> }>();

function readContent(
  docId: string,
  load: (docId: string) => Promise<PreviewContent>,
): Promise<PreviewContent | null> {
  const cached = contentCache.get(docId);
  if (cached && Date.now() - cached.at < PAGE_CACHE_MS) return cached.content;
  const content = load(docId).catch(() => null);
  contentCache.set(docId, { at: Date.now(), content });
  return content;
}

type PreviewState =
  | { docId: string; phase: 'ready'; content: PreviewContent }
  | { docId: string; phase: 'unavailable' };

/**
 * A round picture of the page around a person's pointer (or window), with
 * their pointer and the stroke they are drawing. The page is read once when
 * the preview opens (ink included, fetched when this device lacks it); the
 * pointer and live ink follow the room's presence. A page that cannot be read
 * shows a note instead of an empty circle.
 */
export function PresencePreviewCanvas({ hub, userId, loadContent }: {
  hub: PresenceHub;
  userId: string;
  loadContent: (docId: string) => Promise<PreviewContent>;
}) {
  const { t } = useI18n();
  const docId = useSyncExternalStore(
    hub.subscribeRoster,
    () => hub.getPerson(userId)?.page ?? null,
    () => null,
  );
  const [state, setState] = useState<PreviewState | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<PreviewContent | null>(null);

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    void readContent(docId, loadContent).then((content) => {
      if (cancelled) return;
      setState(content ? { docId, phase: 'ready', content } : { docId, phase: 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [docId, loadContent]);

  const current = state !== null && state.docId === docId ? state : null;
  const content = current?.phase === 'ready' ? current.content : null;
  const phase = current?.phase ?? 'loading';

  useEffect(() => {
    contentRef.current = content;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const pixels = Math.round(PREVIEW_SIZE * Math.min(2, window.devicePixelRatio || 1));
    canvas.width = pixels;
    canvas.height = pixels;
    let frame = 0;
    const draw = (): void => {
      frame = 0;
      const peer = hub.getPerson(userId);
      if (!peer) return;
      const center = previewCenter(peer) ?? { x: PREVIEW_DEFAULT_SPAN / 2, y: PREVIEW_DEFAULT_SPAN / 2 };
      const shown = contentRef.current;
      drawPagePreview(context, shown?.page ?? null, center, previewSpan(peer.view), pixels, [peer], shown?.images);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    draw();
    const unsubscribe = hub.subscribe(schedule);
    return () => {
      unsubscribe();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [hub, userId, content]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`presence-preview__canvas${phase === 'ready' ? '' : ' is-loading'}`}
        width={PREVIEW_SIZE}
        height={PREVIEW_SIZE}
        aria-hidden="true"
        data-presence-preview-ready={phase === 'ready' ? 'true' : 'false'}
        data-presence-preview-phase={phase}
      />
      {phase === 'ready' ? null : (
        <span className="presence-preview__note" role="status">
          {t(phase === 'unavailable' ? 'presence.preview.unavailable' : 'presence.preview.loading')}
        </span>
      )}
    </>
  );
}
