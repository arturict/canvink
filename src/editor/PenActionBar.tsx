import type { Point } from "./operations";
import "./PenActionBar.css";

export interface PenAction {
  id: string;
  label: string;
  onClick: () => void;
}

/**
 * A small bar under a pen selection or a screen clip with the follow-up
 * actions (copy, delete, insert as image). A pen has no keyboard or right
 * click, so these are on-screen buttons. It sits on the page, scaled against
 * the zoom so it stays the same size on screen, and keeps its presses away
 * from the canvas so tapping a button never starts a stroke.
 */
export function PenActionBar({
  at,
  zoom,
  label,
  status,
  actions,
}: {
  at: Point;
  zoom: number;
  label: string;
  status?: string;
  actions: readonly PenAction[];
}) {
  return (
    <div
      className="pen-action-bar"
      role="toolbar"
      aria-label={label}
      data-pen-action-bar={label}
      style={{ left: at.x, top: at.y + 8 / zoom, transform: `scale(${1 / zoom})` }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {status ? <span className="pen-action-bar__status">{status}</span> : null}
      {actions.map((action) => (
        <button key={action.id} type="button" data-pen-action={action.id} onClick={action.onClick}>
          {action.label}
        </button>
      ))}
    </div>
  );
}
