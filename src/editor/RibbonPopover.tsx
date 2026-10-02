import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import "./RibbonPopover.css";

/**
 * A ribbon dropdown such as OneNote's "Linien" gallery or the pen menu. The
 * panel is portalled to the body with fixed positioning because the ribbon
 * card scrolls horizontally and would clip an absolutely placed panel. It
 * closes on Escape (returning focus to its button) and on a press outside.
 */
export function RibbonPopover({
  label,
  buttonContent,
  className = "",
  panelClassName = "",
  disabled = false,
  showChevron = true,
  children,
}: {
  label: string;
  buttonContent: ReactNode;
  className?: string;
  panelClassName?: string;
  disabled?: boolean;
  showChevron?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current;
      const panel = panelRef.current;
      if (!button || !panel) return;
      const rect = button.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      // A toolbar on a window edge (the floating ink toolbar) asks for its
      // menus to open away from that edge.
      const side = button.closest<HTMLElement>("[data-popover-side]")?.dataset.popoverSide;
      if (side === "left" || side === "right") {
        const beside = side === "right" ? rect.right + 6 : rect.left - width - 6;
        setPosition({
          left: Math.max(8, Math.min(beside, window.innerWidth - width - 8)),
          top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)),
        });
        return;
      }
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      if (side === "above" && rect.top - height - 6 >= 8) {
        setPosition({ left, top: rect.top - height - 6 });
        return;
      }
      const below = rect.bottom + 4;
      const top = below + height > window.innerHeight - 8 && rect.top - height - 4 > 8
        ? rect.top - height - 4
        : below;
      setPosition({ left, top: Math.max(8, top) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const placed = open && position !== null;
  useEffect(() => {
    if (!placed) return;
    panelRef.current
      ?.querySelector<HTMLElement>("[aria-pressed='true'], [aria-checked='true'], button, input")
      ?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (panelRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ribbon-button ribbon-popover-button ${className}`.trim()}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {buttonContent}
        {showChevron ? <ChevronDown className="ribbon-popover-button__chevron" aria-hidden="true" /> : null}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={label}
              className={`ribbon-popover ${panelClassName}`.trim()}
              style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
            >
              {typeof children === "function" ? children(close) : children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
