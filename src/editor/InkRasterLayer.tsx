import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isContextLost, watchCanvasContext } from "./canvasSafety";
import { inkRasterPlacement, startupInkRaster, type ShownInkRaster } from "./inkRasterDisplay";

/**
 * Shows a page's stored ink picture (see inkRaster.ts) where the page's ink
 * will be, above whatever is behind it and below the loading notice. It is a
 * placeholder only: hidden from assistive technology and from the pointer.
 * `fixed` places it relative to the window (the startup screen); otherwise
 * it fills its positioned parent (the page area).
 */
export function InkRasterLayer({ raster, fixed = false }: { raster: ShownInkRaster; fixed?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [corner, setCorner] = useState<{ left: number; top: number } | null>(
    fixed ? { left: 0, top: 0 } : null,
  );
  useLayoutEffect(() => {
    if (fixed || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setCorner((current) => (current?.left === rect.left && current.top === rect.top
      ? current
      : { left: rect.left, top: rect.top }));
  }, [fixed]);
  const placement = corner ? inkRasterPlacement(raster.record, corner) : null;
  const placed = placement !== null;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = () => {
      const context = canvas.getContext("2d");
      // A closed bitmap has no size and drawing it throws; the picture is a
      // placeholder, so a layer that cannot paint it just stays empty.
      if (!context || isContextLost(context) || raster.bitmap.width === 0) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      try {
        context.drawImage(raster.bitmap, 0, 0);
      } catch {
        // The bitmap was released while this ran.
      }
    };
    paint();
    return watchCanvasContext(canvas, { onRestored: paint });
  }, [raster, placed]);
  const { record } = raster;
  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{ position: fixed ? "fixed" : "absolute", inset: 0, zIndex: 30, overflow: "hidden", pointerEvents: "none" }}
    >
      {placement ? (
        <div
          data-ink-raster="cached"
          data-ink-raster-page={record.pageId}
          data-ink-raster-strokes={record.strokeCount}
          style={{
            position: "absolute",
            left: placement.box.x,
            top: placement.box.y,
            width: placement.box.width,
            height: placement.box.height,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: placement.paper.x,
              top: placement.paper.y,
              width: placement.paper.width,
              height: placement.paper.height,
              backgroundColor: record.paper.color,
            }}
          />
          <canvas
            ref={canvasRef}
            width={record.width}
            height={record.height}
            style={{
              position: "absolute",
              left: placement.ink.x,
              top: placement.ink.y,
              width: placement.ink.width,
              height: placement.ink.height,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The start page's picture on the screen shown while the notebook's code
 * loads. The notebook shows the same picture on its own startup screen and
 * page area afterwards, and releases it.
 */
export function StartupInkRaster() {
  const [raster, setRaster] = useState<ShownInkRaster | null>(null);
  useEffect(() => {
    let active = true;
    void startupInkRaster()?.then((found) => {
      if (active) setRaster(found);
    });
    return () => {
      active = false;
    };
  }, []);
  return raster ? <InkRasterLayer raster={raster} fixed /> : null;
}
