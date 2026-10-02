/**
 * What the canvas needs from live presence, independent of the transport.
 * `src/collab/presence.ts` provides it for shared rooms; without a port the
 * canvas behaves exactly as before.
 */

export interface CanvasPresencePoint { x: number; y: number }
export interface CanvasPresenceRect { x: number; y: number; width: number; height: number }

export interface CanvasPresenceInkStyle {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}

/** One other person on this page, in page coordinates. */
export interface CanvasPresencePeer {
  connId: string;
  user: { name: string; color: string };
  away: boolean;
  cursor: CanvasPresencePoint | null;
  focus: CanvasPresenceRect | null;
  /** Changes whenever `focus` changes; restarts the highlight's fade. */
  focusAt: number;
  /** Changes on pointer, ink or focus activity; restarts the idle fade of the cursor. */
  activeAt: number;
  ink: {
    id: string;
    style: CanvasPresenceInkStyle;
    points: readonly CanvasPresencePoint[];
    /** Set once the peer lifted the pen. */
    doneAt: number | null;
  } | null;
}

export interface CanvasPresencePort {
  /** Local pointer over the page, or null when it left the page. */
  pointer(point: CanvasPresencePoint | null): void;
  /** The whole in-progress stroke so far. */
  inkProgress(style: CanvasPresenceInkStyle, points: readonly CanvasPresencePoint[]): void;
  /** The pen was lifted or the stroke cancelled. */
  inkEnd(): void;
  /** Bounds of the selected elements (or the text box being edited), or null. */
  selection(bounds: CanvasPresenceRect | null): void;
  /** The part of the page the window shows, in page coordinates. */
  viewport(view: CanvasPresenceRect | null): void;
  /**
   * "Jump to" and "Folgen": the canvas is asked to show this part of the
   * page. A request made before the canvas subscribed is delivered on
   * subscribe.
   */
  subscribeReveal(listener: (view: CanvasPresenceRect) => void): () => void;
  /** The person moved the canvas themselves (pointer down or wheel); ends "Folgen". */
  interacted(): void;
  subscribe(listener: () => void): () => void;
  /** Peers on this page; a new array whenever anything changed. */
  getPeers(): readonly CanvasPresencePeer[];
}
