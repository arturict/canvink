import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { isolateCanvasEvent } from './canvasIsolation';
import './mathCanvas.css';

export interface NumberScrubberLabels {
  scrubber: string;
  value: string;
}

export interface NumberScrubberProps {
  value: number;
  step: number;
  labels: NumberScrubberLabels;
  min?: number;
  max?: number;
  sensitivity?: number;
  viewer?: boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  onPreview: (value: number) => void;
  onCommit: (value: number, previousValue: number) => void;
  onCancel?: (value: number) => void;
}

interface ScrubGesture {
  pointerId: number;
  startX: number;
  original: number;
  transaction: ScrubTransaction;
}

export interface ScrubTransaction {
  update(value: number): void;
  commit(): void;
  cancel(): void;
  dispose(): void;
}

export function createScrubTransaction(
  original: number,
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (handle: number) => void,
  callbacks: {
    onPreview: (value: number) => void;
    onCommit: (value: number, previousValue: number) => void;
    onCancel?: (value: number) => void;
  },
): ScrubTransaction {
  let active = true;
  let latest = original;
  let frame: number | null = null;
  const cancelPendingFrame = () => {
    if (frame != null) cancelFrame(frame);
    frame = null;
  };
  return {
    update(value) {
      if (!active) return;
      latest = value;
      if (frame != null) return;
      frame = requestFrame(() => {
        frame = null;
        if (active) callbacks.onPreview(latest);
      });
    },
    commit() {
      if (!active) return;
      active = false;
      cancelPendingFrame();
      callbacks.onPreview(latest);
      callbacks.onCommit(latest, original);
    },
    cancel() {
      if (!active) return;
      active = false;
      cancelPendingFrame();
      callbacks.onPreview(original);
      callbacks.onCancel?.(original);
    },
    dispose() {
      active = false;
      cancelPendingFrame();
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scrubValue(
  start: number,
  deltaX: number,
  step: number,
  sensitivity = 8,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isFinite(start) || !Number.isFinite(step) || step <= 0) {
    throw new TypeError('Scrubber start and step must be finite, and step must be positive');
  }
  if (!Number.isFinite(deltaX) || !Number.isFinite(sensitivity) || sensitivity <= 0 || min > max) {
    throw new TypeError('Invalid scrubber bounds or movement');
  }
  const increments = Math.round(deltaX / sensitivity);
  return clamp(start + increments * step, min, max);
}

export function NumberScrubber({
  value,
  step,
  labels,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  sensitivity = 8,
  viewer = false,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  onPreview,
  onCommit,
  onCancel,
}: NumberScrubberProps) {
  const gestureRef = useRef<ScrubGesture | null>(null);

  useEffect(() => () => {
    const gesture = gestureRef.current;
    gesture?.transaction.dispose();
    gestureRef.current = null;
  }, []);

  const finish = (event: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (cancelled) gesture.transaction.cancel();
    else gesture.transaction.commit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    isolateCanvasEvent(event);
    if (viewer) return;
    if (event.key === 'Escape' && gestureRef.current) {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      gesture.transaction.cancel();
      return;
    }
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const next = clamp(value + direction * step, min, max);
    onPreview(next);
    onCommit(next, value);
  };

  return (
    <button
      type="button"
      className="number-scrubber"
      disabled={viewer}
      aria-label={labels.scrubber}
      aria-valuetext={`${labels.value}: ${value}`}
      onPointerDown={(event) => {
        isolateCanvasEvent(event);
        if (viewer || event.button !== 0) return;
        event.preventDefault();
        gestureRef.current?.transaction.dispose();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gestureRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          original: value,
          transaction: createScrubTransaction(value, requestFrame, cancelFrame, {
            onPreview,
            onCommit,
            onCancel,
          }),
        };
      }}
      onPointerMove={(event) => {
        isolateCanvasEvent(event);
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.transaction.update(scrubValue(
          gesture.original,
          event.clientX - gesture.startX,
          step,
          sensitivity,
          min,
          max,
        ));
      }}
      onPointerUp={(event) => {
        isolateCanvasEvent(event);
        finish(event, false);
      }}
      onPointerCancel={(event) => {
        isolateCanvasEvent(event);
        finish(event, true);
      }}
      onKeyDown={handleKeyDown}
      onWheel={isolateCanvasEvent}
    >
      <span aria-hidden="true">↔</span>
      <output>{value}</output>
    </button>
  );
}

export default NumberScrubber;
