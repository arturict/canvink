import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  ChevronsDownUp,
  ChevronsRightLeft,
  GripHorizontal,
  GripVertical,
  Library,
  Minimize2,
  PenTool,
  Settings2,
} from "lucide-react";
import { useI18n } from "../i18n";
import { RibbonPopover } from "./RibbonPopover";
import {
  clampToViewport,
  effectiveEdge,
  isVerticalEdge,
  nearestEdge,
  nudgeToolbar,
  offsetAlongEdge,
  placeToolbar,
  type FullPageToolbarMode,
  type FullPageToolbarState,
  type Point,
  type Size,
} from "./floatingToolbar";
import "./FloatingInkToolbar.css";

/** How long a finger or pen rests on the toolbar before it can be dragged. */
const LONG_PRESS_MS = 450;
/** Movement that turns a press on the collapsed button into a drag. */
const DRAG_THRESHOLD = 6;

type DragSession = {
  pointerId: number;
  /** grip: drags at once; collapsed: after a small move; longpress: after resting. */
  kind: "grip" | "collapsed" | "longpress";
  start: Point;
  /** Pointer position inside the toolbar, so the toolbar does not jump. */
  grab: Point;
  corner: Point;
  dragging: boolean;
  timer: number | null;
};

function useViewportSize(): Size {
  const [size, setSize] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setSize((current) => (
      current.width === window.innerWidth && current.height === window.innerHeight
        ? current
        : { width: window.innerWidth, height: window.innerHeight }
    ));
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return size;
}

/**
 * The floating drawing toolbar of the full page view, like OneNote's
 * floating ink toolbar: a compact palette that rests against any window
 * edge, turns vertical at the sides and collapses to one button in the
 * current pen colour. This component is only the frame (place, drag,
 * collapse, exit); the canvas portals its tools into `toolsRef` and the
 * current pen into `currentRef`, so no tool logic lives here.
 */
export function FloatingInkToolbar({
  state,
  onChange,
  onExit,
  onOpenNavigation,
  toolsRef,
  currentRef,
}: {
  state: FullPageToolbarState;
  onChange: (update: Partial<FullPageToolbarState>) => void;
  onExit: () => void;
  /** Opens the navigation panel (notebooks, sections, pages). */
  onOpenNavigation: () => void;
  toolsRef: (element: HTMLElement | null) => void;
  currentRef: (element: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const viewport = useViewportSize();
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [drag, setDrag] = useState<Point | null>(null);
  const [drawing, setDrawing] = useState(false);
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);

  const edge = effectiveEdge(state.edge, viewport);
  const vertical = isVerticalEdge(edge);
  const corner = drag ?? (size ? placeToolbar(edge, state.offset, size, viewport) : null);

  // Measure after every render so a new orientation or content is placed
  // before it is painted; the observer catches later changes of the tools.
  const measure = () => {
    const root = rootRef.current;
    if (!root) return;
    const next = { width: root.offsetWidth, height: root.offsetHeight };
    setSize((current) => (current && current.width === next.width && current.height === next.height ? current : next));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // While a stroke is drawn anywhere on the page the toolbar fades and lets
  // every pointer through, so it never hides or catches the pen.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || rootRef.current?.contains(target) || !target.closest(".live-canvas-editor")) return;
      setDrawing(true);
    };
    const onUp = () => setDrawing(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  useEffect(() => () => {
    const timer = sessionRef.current?.timer;
    if (timer) window.clearTimeout(timer);
  }, []);

  const startDragging = (session: DragSession) => {
    session.dragging = true;
    try {
      rootRef.current?.setPointerCapture(session.pointerId);
    } catch {
      // The pointer is already gone; the drag ends with the next event.
    }
    setDrag(session.corner);
  };

  const onPointerDown = (event: PointerEvent) => {
    const root = rootRef.current;
    if (!root || !event.isPrimary || event.button > 0 || sessionRef.current) return;
    const target = event.target instanceof Element ? event.target : null;
    const kind: DragSession["kind"] | null = target?.closest("[data-toolbar-grip]")
      ? "grip"
      : target?.closest("[data-toolbar-expand]")
        ? "collapsed"
        : event.pointerType !== "mouse"
          ? "longpress"
          : null;
    if (!kind) return;
    const rect = root.getBoundingClientRect();
    const session: DragSession = {
      pointerId: event.pointerId,
      kind,
      start: { x: event.clientX, y: event.clientY },
      grab: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      corner: { x: rect.left, y: rect.top },
      dragging: false,
      timer: null,
    };
    sessionRef.current = session;
    if (kind === "grip") {
      event.preventDefault();
      startDragging(session);
    } else if (kind === "longpress") {
      session.timer = window.setTimeout(() => {
        session.timer = null;
        if (sessionRef.current === session) startDragging(session);
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - session.start.x, event.clientY - session.start.y);
    if (!session.dragging) {
      if (session.kind === "collapsed" && distance > DRAG_THRESHOLD) {
        startDragging(session);
      } else {
        // A finger that moves before the long press is not a drag.
        if (session.kind === "longpress" && distance > DRAG_THRESHOLD) endSession();
        return;
      }
    }
    if (!size) return;
    session.corner = clampToViewport(
      { x: event.clientX - session.grab.x, y: event.clientY - session.grab.y },
      size,
      viewport,
    );
    setDrag(session.corner);
  };

  const endSession = (event?: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    sessionRef.current = null;
    if (session.timer) window.clearTimeout(session.timer);
    if (!session.dragging) return;
    setDrag(null);
    // The press that ended a drag must not also press the button under it.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (!event || event.type === "pointercancel" || !size) return;
    const moved = Math.hypot(event.clientX - session.start.x, event.clientY - session.start.y) > 3;
    if (!moved) return;
    const nextEdge = nearestEdge({ x: event.clientX, y: event.clientY }, viewport);
    const centre = { x: session.corner.x + size.width / 2, y: session.corner.y + size.height / 2 };
    onChange({ edge: nextEdge, offset: offsetAlongEdge(nextEdge, centre, viewport) });
  };

  // The tools inside are portalled from the canvas, and React sends their
  // events up the canvas's tree, not this one: the drag and the long press
  // listen on the DOM element itself.
  const handlersRef = useRef({ onPointerDown, onPointerMove, endSession });
  useLayoutEffect(() => {
    handlersRef.current = { onPointerDown, onPointerMove, endSession };
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const down = (event: PointerEvent) => handlersRef.current.onPointerDown(event);
    const move = (event: PointerEvent) => handlersRef.current.onPointerMove(event);
    const end = (event: PointerEvent) => handlersRef.current.endSession(event);
    const click = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const contextMenu = (event: MouseEvent) => event.preventDefault();
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.addEventListener("lostpointercapture", end);
    root.addEventListener("click", click, true);
    root.addEventListener("contextmenu", contextMenu);
    return () => {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", end);
      root.removeEventListener("pointercancel", end);
      root.removeEventListener("lostpointercapture", end);
      root.removeEventListener("click", click, true);
      root.removeEventListener("contextmenu", contextMenu);
    };
  }, []);

  const onGripKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const next = nudgeToolbar(state, event.key, viewport);
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    if (next) onChange(next);
  };

  const chooseMode = (mode: FullPageToolbarMode, close: () => void) => {
    close();
    onChange({ mode });
  };

  const Grip = vertical ? GripHorizontal : GripVertical;
  const Collapse = vertical ? ChevronsDownUp : ChevronsRightLeft;
  return (
    <div
      ref={rootRef}
      className="floating-ink-toolbar"
      role="toolbar"
      aria-label={t("workspace.fullPage.tools")}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-edge={edge}
      data-collapsed={state.collapsed ? "true" : undefined}
      data-dragging={drag ? "true" : undefined}
      data-drawing={drawing ? "true" : undefined}
      // Pen menus open away from the edge the toolbar rests on.
      data-popover-side={{ top: "below", bottom: "above", left: "right", right: "left" }[edge]}
      style={corner ? { left: corner.x, top: corner.y } : { visibility: "hidden" }}
    >
      {state.collapsed ? (
        <button
          type="button"
          className="floating-ink-toolbar__expand"
          data-toolbar-expand
          aria-label={t("workspace.fullPage.expand")}
          title={t("workspace.fullPage.expand")}
          aria-expanded="false"
          onClick={() => onChange({ collapsed: false })}
        >
          <span ref={currentRef} className="floating-ink-toolbar__current" />
          <PenTool className="floating-ink-toolbar__fallback" aria-hidden="true" />
        </button>
      ) : null}
      <div className="floating-ink-toolbar__body" hidden={state.collapsed}>
        <button
          type="button"
          className="floating-ink-toolbar__grip"
          data-toolbar-grip
          aria-label={t("workspace.fullPage.move")}
          title={t("workspace.fullPage.move")}
          onKeyDown={onGripKeyDown}
        >
          <Grip aria-hidden="true" />
        </button>
        <div ref={toolsRef} className="floating-ink-toolbar__tools" />
        <span className="floating-ink-toolbar__separator" aria-hidden="true" />
        <RibbonPopover
          label={t("workspace.fullPage.options")}
          buttonContent={<Settings2 aria-hidden="true" />}
          showChevron={false}
          panelClassName="floating-ink-toolbar__options"
        >
          {(close) => (
            <div role="group" aria-label={t("workspace.fullPage.options")}>
              {(["docked", "floating"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={state.mode === mode}
                  onClick={() => chooseMode(mode, close)}
                >
                  <Check aria-hidden="true" />
                  {t(mode === "docked" ? "workspace.fullPage.docked" : "workspace.fullPage.floating")}
                </button>
              ))}
            </div>
          )}
        </RibbonPopover>
        <button
          type="button"
          className="ribbon-button"
          aria-label={t("workspace.fullPage.collapse")}
          title={t("workspace.fullPage.collapse")}
          aria-expanded="true"
          onClick={() => onChange({ collapsed: true })}
        >
          <Collapse aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ribbon-button floating-ink-toolbar__navigation"
          aria-label={t("workspace.fullPage.navigation")}
          title={t("workspace.fullPage.navigation")}
          aria-keyshortcuts="Control+G"
          onClick={onOpenNavigation}
        >
          <Library aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ribbon-button floating-ink-toolbar__exit"
          aria-label={t("workspace.fullscreen.exit")}
          title={t("workspace.fullscreen.exit")}
          aria-pressed="true"
          onClick={onExit}
        >
          <Minimize2 aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
