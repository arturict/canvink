import { describe, expect, it, vi } from 'vitest';
import { setBrowserFullscreen, toggleBrowserFullscreen, type FullscreenDocumentLike } from './fullscreen';

describe('browser fullscreen', () => {
  it('enters and exits without persisting state', async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const exitFullscreen = vi.fn(async () => undefined);
    const root = { requestFullscreen } as unknown as Element & { requestFullscreen: () => Promise<void> };
    const documentLike: FullscreenDocumentLike = {
      fullscreenElement: null,
      documentElement: root,
      exitFullscreen,
    };
    await expect(toggleBrowserFullscreen(documentLike)).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    documentLike.fullscreenElement = root;
    await expect(toggleBrowserFullscreen(documentLike)).resolves.toBe(false);
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it('fails clearly when the platform has no fullscreen API', async () => {
    await expect(toggleBrowserFullscreen({
      fullscreenElement: null,
      documentElement: {} as Element,
    })).rejects.toThrow(/not supported/i);
  });

  it('sets an explicit state without toggling past it', async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const exitFullscreen = vi.fn(async () => undefined);
    const root = { requestFullscreen } as unknown as Element & { requestFullscreen: () => Promise<void> };
    const documentLike: FullscreenDocumentLike = { fullscreenElement: null, documentElement: root, exitFullscreen };
    await expect(setBrowserFullscreen(documentLike, false)).resolves.toBe(false);
    expect(exitFullscreen).not.toHaveBeenCalled();
    await expect(setBrowserFullscreen(documentLike, true)).resolves.toBe(true);
    documentLike.fullscreenElement = root;
    await expect(setBrowserFullscreen(documentLike, true)).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });
});
