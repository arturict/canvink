import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkspace } from '../domain/sample';
import { getActiveContext } from '../domain/workspace';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  invoke: vi.fn(),
  set: vi.fn(),
  validateWorkspaceAssetPreviews: vi.fn(),
}));

vi.mock('idb-keyval', () => ({
  get: mocks.get,
  set: mocks.set,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('../io/files', () => ({
  validateWorkspaceAssetPreviews: mocks.validateWorkspaceAssetPreviews,
}));

const canonicalEmptyWorkspace = {
  schemaVersion: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  notebooks: [],
  trash: [],
  activeNotebookId: '',
  activeSectionId: '',
  activePageId: '',
};

function stubIndexedDbRuntime(): void {
  const request = vi.fn(
    (
      name: string,
      _options: LockOptions,
      callback: LockGrantedCallback<unknown>,
    ): Promise<unknown> =>
      Promise.resolve(
        callback({
          name,
          mode: 'exclusive',
        }),
      ),
  );
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', {
    locks: { request },
  });
}

function stubTauriRuntime(): void {
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {},
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.get.mockReset();
  mocks.invoke.mockReset();
  mocks.set.mockReset();
  mocks.validateWorkspaceAssetPreviews.mockReset();
  mocks.validateWorkspaceAssetPreviews.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace storage initialization', () => {
  it('fails closed before reading IndexedDB when Web Locks are unavailable', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow(/cannot safely coordinate local writes/i);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('fails closed before reading IndexedDB when another tab holds the lock', async () => {
    const request = vi.fn(
      (
        _name: string,
        _options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ): Promise<unknown> => Promise.resolve(callback(null)),
    );
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow(/already open in another browser tab/i);
    expect(request).toHaveBeenCalledWith(
      'canvink:workspace:v1:writer',
      { mode: 'exclusive', ifAvailable: true },
      expect.any(Function),
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('surfaces Web Lock request failures before reading IndexedDB', async () => {
    const request = vi.fn(() => Promise.reject(new Error('lock request failed')));
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { locks: { request } });
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow('lock request failed');
    expect(request).toHaveBeenCalledOnce();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('persists a missing IndexedDB workspace before reporting a successful load', async () => {
    stubIndexedDbRuntime();
    mocks.get.mockResolvedValue(undefined);
    let finishWrite: (() => void) | undefined;
    mocks.set.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { loadWorkspace } = await import('./workspaceStorage');
    let loadFinished = false;

    const loading = loadWorkspace().then((result) => {
      loadFinished = true;
      return result;
    });

    await vi.waitFor(() => expect(mocks.set).toHaveBeenCalledOnce());
    expect(loadFinished).toBe(false);
    const persisted = mocks.set.mock.calls[0][1];
    expect(getActiveContext(persisted)?.page.title).toBe('Quick note');

    finishWrite?.();
    await expect(loading).resolves.toMatchObject({
      backend: 'indexeddb',
      workspace: persisted,
    });
    expect(loadFinished).toBe(true);
  });

  it('reports an IndexedDB initialization write failure and permits a later load retry', async () => {
    stubIndexedDbRuntime();
    mocks.get.mockResolvedValue(undefined);
    mocks.set
      .mockRejectedValueOnce(new DOMException('quota exceeded', 'QuotaExceededError'))
      .mockResolvedValueOnce(undefined);
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow(/quota exceeded/i);
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenCalledOnce();

    await expect(loadWorkspace()).resolves.toMatchObject({
      backend: 'indexeddb',
      workspace: expect.objectContaining({ schemaVersion: 1 }),
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(getActiveContext(mocks.set.mock.calls[1][1])?.page.title).toBe('Quick note');
  });

  it('persists the canonical empty Tauri workspace before reporting a successful load', async () => {
    stubTauriRuntime();
    let finishWrite: (() => void) | undefined;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'load_workspace') {
        return Promise.resolve(canonicalEmptyWorkspace);
      }
      if (command === 'save_workspace') {
        return new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const { loadWorkspace } = await import('./workspaceStorage');
    let loadFinished = false;

    const loading = loadWorkspace().then((result) => {
      loadFinished = true;
      return result;
    });

    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'save_workspace',
        expect.objectContaining({
          workspace: expect.objectContaining({
            schemaVersion: 1,
          }),
        }),
      ),
    );
    expect(loadFinished).toBe(false);
    const persisted = mocks.invoke.mock.calls[1][1].workspace;
    expect(getActiveContext(persisted)?.page.title).toBe('Quick note');

    finishWrite?.();
    await expect(loading).resolves.toMatchObject({
      backend: 'tauri',
      workspace: persisted,
    });
    expect(loadFinished).toBe(true);
  });

  it('reports a Tauri initialization write failure and permits a later load retry', async () => {
    stubTauriRuntime();
    let saveAttempts = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'load_workspace') {
        return Promise.resolve(canonicalEmptyWorkspace);
      }
      if (command === 'save_workspace') {
        saveAttempts += 1;
        return saveAttempts === 1
          ? Promise.reject(new Error('native initialization write failed'))
          : Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow(/native initialization write failed/i);
    expect(saveAttempts).toBe(1);

    await expect(loadWorkspace()).resolves.toMatchObject({
      backend: 'tauri',
      workspace: expect.objectContaining({ schemaVersion: 1 }),
    });
    expect(saveAttempts).toBe(2);
    expect(mocks.invoke).toHaveBeenCalledTimes(4);
  });

  it('does not rewrite an existing IndexedDB workspace during load', async () => {
    stubIndexedDbRuntime();
    const existing = createDefaultWorkspace();
    mocks.get.mockResolvedValue(existing);
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).resolves.toMatchObject({
      backend: 'indexeddb',
      workspace: existing,
    });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('rejects malformed non-empty IndexedDB data without replacing it', async () => {
    stubIndexedDbRuntime();
    mocks.get.mockResolvedValue({
      schemaVersion: 1,
      notebooks: [{ id: 'keep-me', sections: 'broken' }],
    });
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow(/malformed/);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('rejects malformed non-empty Tauri data without replacing it', async () => {
    stubTauriRuntime();
    mocks.invoke.mockResolvedValue({
      schemaVersion: 1,
      notebooks: [{ id: 'keep-me', sections: 'broken' }],
    });
    const { loadWorkspace } = await import('./workspaceStorage');

    await expect(loadWorkspace()).rejects.toThrow(/malformed/);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('load_workspace');
  });
});
