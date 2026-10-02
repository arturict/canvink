import { describe, expect, it, vi } from 'vitest';
import { createDesktopUpdateController, type PendingUpdate } from './desktopUpdater';

function update(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    version: '0.3.2',
    download: async (onProgress) => {
      onProgress(50, 100);
      onProgress(100, 100);
    },
    install: async () => undefined,
    ...overrides,
  };
}

describe('desktop update controller', () => {
  it('stays idle when there is no update or the check fails', async () => {
    const none = createDesktopUpdateController({ check: async () => null, relaunch: vi.fn(), flush: vi.fn() });
    await none.check();
    expect(none.getState()).toEqual({ kind: 'idle' });
    const offline = createDesktopUpdateController({
      check: () => Promise.reject(new Error('offline')),
      relaunch: vi.fn(),
      flush: vi.fn(),
    });
    await offline.check();
    expect(offline.getState()).toEqual({ kind: 'idle' });
  });

  it('goes from available through the download to ready, then flushes before installing and relaunching', async () => {
    const order: string[] = [];
    const controller = createDesktopUpdateController({
      check: async () => update({ install: async () => { order.push('install'); } }),
      flush: async () => { order.push('flush'); },
      relaunch: async () => { order.push('relaunch'); },
    });
    const percents: Array<number | null> = [];
    controller.subscribe(() => {
      const state = controller.getState();
      if (state.kind === 'downloading') percents.push(state.percent);
    });
    await controller.check();
    expect(controller.getState()).toEqual({ kind: 'available', version: '0.3.2' });
    await controller.download();
    expect(percents).toEqual([null, 50, 100]);
    expect(controller.getState()).toEqual({ kind: 'ready', version: '0.3.2' });
    await controller.restart();
    expect(order).toEqual(['flush', 'install', 'relaunch']);
  });

  it('does not check again while an update is on its way', async () => {
    const check = vi.fn(async () => update());
    const controller = createDesktopUpdateController({ check, relaunch: vi.fn(), flush: vi.fn() });
    await controller.check();
    await controller.check();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('shows a failed download and retries it', async () => {
    const download = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);
    const controller = createDesktopUpdateController({
      check: async () => update({ download }),
      relaunch: vi.fn(),
      flush: vi.fn(),
    });
    await controller.check();
    await controller.download();
    expect(controller.getState()).toMatchObject({ kind: 'error', stage: 'download' });
    await controller.download();
    expect(controller.getState()).toEqual({ kind: 'ready', version: '0.3.2' });
  });

  it('installs even when the flush fails, and reports a failed install', async () => {
    const controller = createDesktopUpdateController({
      check: async () => update({ install: () => Promise.reject(new Error('installer')) }),
      flush: () => Promise.reject(new Error('disk')),
      relaunch: vi.fn(),
    });
    await controller.check();
    await controller.download();
    await controller.restart();
    expect(controller.getState()).toMatchObject({ kind: 'error', stage: 'restart' });
  });
});
