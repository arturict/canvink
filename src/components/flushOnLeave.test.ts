import { describe, expect, it, vi } from 'vitest';
import { flushWhenLeaving } from './flushOnLeave';

function fakePage(visibilityState = 'visible') {
  const target = new EventTarget();
  return Object.assign(target, { visibilityState });
}

describe('flushWhenLeaving', () => {
  it('writes at once when the page is hidden or closed, and only then', () => {
    const scope = new EventTarget();
    const page = fakePage();
    const flush = vi.fn(async () => undefined);
    const stop = flushWhenLeaving(scope, page, flush);

    page.dispatchEvent(new Event('visibilitychange'));
    expect(flush).not.toHaveBeenCalled();

    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(1);

    scope.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);

    stop();
    scope.dispatchEvent(new Event('pagehide'));
    page.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('does not let a failing write surface as an unhandled rejection', async () => {
    const scope = new EventTarget();
    const stop = flushWhenLeaving(scope, fakePage(), () => Promise.reject(new Error('disk full')));
    scope.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    stop();
  });
});
