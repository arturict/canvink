export interface CanvasIsolatedEvent {
  stopPropagation(): void;
}

export function isolateCanvasEvent(event: CanvasIsolatedEvent): void {
  event.stopPropagation();
}

