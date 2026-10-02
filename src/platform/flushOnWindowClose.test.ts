import { describe, expect, it, vi } from 'vitest';
import { flushBeforeWindowClose, type CloseRequestEvent } from './flushOnWindowClose';

function fakeWindow() {
  let handler: ((event: CloseRequestEvent) => Promise<void>) | undefined;
  const unlisten = vi.fn();
  const destroy = vi.fn(async () => undefined);
  return {
    destroy,
    unlisten,
    close: () => {
      const event = { preventDefault: vi.fn() };
      return { event, done: handler!(event) };
    },
    onCloseRequested: async (next: (event: CloseRequestEvent) => Promise<void>) => {
      handler = next;
      return unlisten;
    },
  };
}

describe('flushBeforeWindowClose', () => {
  it('holds the close until the write is durable, then destroys the window', async () => {
    const appWindow = fakeWindow();
    const order: string[] = [];
    await flushBeforeWindowClose(appWindow, async () => {
      await Promise.resolve();
      order.push('flushed');
    });
    appWindow.destroy.mockImplementation(async () => { order.push('destroyed'); });
    const { event, done } = appWindow.close();
    await done;
    expect(event.preventDefault).toHaveBeenCalled();
    expect(order).toEqual(['flushed', 'destroyed']);
  });

  it('still closes when the write fails or hangs', async () => {
    const failing = fakeWindow();
    await flushBeforeWindowClose(failing, () => Promise.reject(new Error('disk')));
    await failing.close().done;
    expect(failing.destroy).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    const hanging = fakeWindow();
    await flushBeforeWindowClose(hanging, () => new Promise(() => undefined), 1000);
    const { done } = hanging.close();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(hanging.destroy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
