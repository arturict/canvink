/**
 * Test-only WebSocket double. Not a `*.test.ts` file itself so vitest's
 * `include: ['src/**\/*.test.ts']` never runs it as a suite.
 */

import type { WebSocketFactory, WebSocketLike } from './session';

export class MockWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Test helper: flips readyState to OPEN and fires `onopen`. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Test helper: delivers a server frame as a JSON text message. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Test helper: simulates the transport dropping, as the server would on a fatal error. */
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

export function createMockWebSocketFactory(): {
  factory: WebSocketFactory;
  sockets: MockWebSocket[];
} {
  const sockets: MockWebSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const socket = new MockWebSocket(url);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}
