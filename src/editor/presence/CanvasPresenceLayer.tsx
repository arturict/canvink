import { memo, useMemo, useSyncExternalStore } from 'react';
import { inkOutline, outlineToSvgPath } from '../ink';
import type { StrokePointV2 } from '../../domain/v2';
import type { CanvasPresencePeer, CanvasPresencePort } from './types';
import './presence.css';

const NO_PEERS: readonly CanvasPresencePeer[] = [];

function remoteInkPath(ink: NonNullable<CanvasPresencePeer['ink']>): string {
  const points: StrokePointV2[] = ink.points.map((point) => ({
    x: point.x,
    y: point.y,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    time: 0,
    pointerType: 'mouse',
  }));
  const outline = inkOutline(
    { points, size: ink.style.size, tool: ink.style.tool, color: ink.style.color, opacity: ink.style.opacity },
    ink.doneAt !== null,
  );
  return outlineToSvgPath(outline);
}

const RemoteInk = memo(function RemoteInk({ peer }: { peer: CanvasPresencePeer }) {
  const ink = peer.ink;
  const path = useMemo(() => (ink && ink.points.length > 0 ? remoteInkPath(ink) : ''), [ink]);
  if (!ink || !path) return null;
  return (
    <path
      className={`canvas-presence__ink${ink.doneAt !== null ? ' is-done' : ''}`}
      d={path}
      fill={ink.style.color}
      fillOpacity={ink.style.opacity}
      style={{ mixBlendMode: ink.style.tool === 'highlighter' ? 'multiply' : undefined }}
      data-presence-ink={peer.connId}
    />
  );
});

/**
 * Other people on this page: their in-progress ink, a soft highlight of the
 * region they work in, and their pointer with a name label. Rendered inside
 * the transformed canvas surface, so it pans and zooms with the page; the
 * cursor and label are counter-scaled to keep a constant screen size.
 * Pointer events pass through; nothing here is interactive.
 */
export function CanvasPresenceLayer({ port, zoom, width, height }: {
  port: CanvasPresencePort;
  zoom: number;
  width: number;
  height: number;
}) {
  const peers = useSyncExternalStore(port.subscribe, port.getPeers, () => NO_PEERS);
  if (peers.length === 0) return null;
  const inverse = 1 / Math.max(0.1, zoom);
  return (
    <div className="canvas-presence" aria-hidden="true">
      {peers.map((peer) => peer.focus ? (
        <div
          key={`focus:${peer.connId}:${peer.focusAt}`}
          className="canvas-presence__focus"
          data-presence-focus={peer.connId}
          style={{
            left: peer.focus.x,
            top: peer.focus.y,
            width: peer.focus.width,
            height: peer.focus.height,
            ['--presence-color' as string]: peer.user.color,
          }}
        />
      ) : null)}
      <svg className="canvas-presence__ink-layer" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {peers.map((peer) => <RemoteInk key={peer.connId} peer={peer} />)}
      </svg>
      {peers.map((peer) => peer.cursor && !peer.away ? (
        <div
          key={`cursor:${peer.connId}`}
          className="canvas-presence__cursor"
          data-presence-cursor={peer.connId}
          style={{
            transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px) scale(${inverse})`,
            ['--presence-color' as string]: peer.user.color,
          }}
        >
          {/* Restarting the idle fade on activity: the key changes with `activeAt`. */}
          <div key={peer.activeAt} className="canvas-presence__cursor-body">
            <svg width="18" height="18" viewBox="0 0 18 18" className="canvas-presence__arrow">
              <path d="M2 1.5 L15.5 8.2 L9.2 9.6 L6.4 15.6 Z" />
            </svg>
            <span className="canvas-presence__label">{peer.user.name}</span>
          </div>
        </div>
      ) : null)}
    </div>
  );
}
