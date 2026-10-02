import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkspace } from '../domain/sample';

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  validateWorkspaceAssetPreviews: vi.fn(),
}));

vi.mock('idb-keyval', () => ({
  del: mocks.del,
  get: mocks.get,
  set: mocks.set,
}));

vi.mock('../io/files', () => ({
  validateWorkspaceAssetPreviews: mocks.validateWorkspaceAssetPreviews,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.del.mockReset();
  mocks.get.mockReset();
  mocks.set.mockReset();
  mocks.validateWorkspaceAssetPreviews.mockReset();
  mocks.del.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue(undefined);
  mocks.validateWorkspaceAssetPreviews.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recovery journal', () => {
  it('loads and validates a versioned draft without changing it', async () => {
    const workspace = createDefaultWorkspace();
    const draft = {
      version: 1,
      sessionId: 'previous-session',
      revision: 4,
      capturedAt: '2026-08-01T10:00:00.000Z',
      workspace,
    };
    mocks.get.mockResolvedValue(draft);
    const { loadRecoveryDraft } = await import('./recoveryJournal');

    await expect(loadRecoveryDraft()).resolves.toEqual(draft);
    expect(mocks.get).toHaveBeenCalledWith('canvink:recovery:v1');
    expect(mocks.validateWorkspaceAssetPreviews).toHaveBeenCalledWith(workspace);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('rejects malformed recovery metadata without deleting it', async () => {
    mocks.get.mockResolvedValue({
      version: 1,
      sessionId: '',
      revision: 0,
      capturedAt: 'not-a-date',
      workspace: createDefaultWorkspace(),
    });
    const { loadRecoveryDraft } = await import('./recoveryJournal');

    await expect(loadRecoveryDraft()).rejects.toThrow(/malformed.*not changed/i);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('stores an isolated workspace snapshot with the current marker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T11:12:13.000Z'));
    const workspace = createDefaultWorkspace();
    const { saveRecoveryDraft } = await import('./recoveryJournal');

    await saveRecoveryDraft(workspace, { sessionId: 'current-session', revision: 7 });
    const stored = mocks.set.mock.calls[0][1];
    expect(mocks.set).toHaveBeenCalledWith(
      'canvink:recovery:v1',
      expect.objectContaining({
        version: 1,
        sessionId: 'current-session',
        revision: 7,
        capturedAt: '2026-08-01T11:12:13.000Z',
      }),
    );
    expect(stored.workspace).toEqual(workspace);
    expect(stored.workspace).not.toBe(workspace);
  });

  it('clears only a draft from the same session at or before the saved revision', async () => {
    const workspace = createDefaultWorkspace();
    const { clearRecoveryDraftThrough } = await import('./recoveryJournal');
    mocks.get
      .mockResolvedValueOnce({
        version: 1,
        sessionId: 'current-session',
        revision: 9,
        capturedAt: '2026-08-01T10:00:00.000Z',
        workspace,
      })
      .mockResolvedValueOnce({
        version: 1,
        sessionId: 'current-session',
        revision: 8,
        capturedAt: '2026-08-01T10:00:00.000Z',
        workspace,
      });

    await clearRecoveryDraftThrough({ sessionId: 'current-session', revision: 8 });
    expect(mocks.del).not.toHaveBeenCalled();

    await clearRecoveryDraftThrough({ sessionId: 'current-session', revision: 8 });
    expect(mocks.del).toHaveBeenCalledOnce();
    expect(mocks.del).toHaveBeenCalledWith('canvink:recovery:v1');
  });

  it('discards only the exact draft the user reviewed', async () => {
    const workspace = createDefaultWorkspace();
    const reviewed = {
      version: 1 as const,
      sessionId: 'previous-session',
      revision: 2,
      capturedAt: '2026-08-01T10:00:00.000Z',
      workspace,
    };
    const { discardRecoveryDraft } = await import('./recoveryJournal');
    mocks.get
      .mockResolvedValueOnce({ ...reviewed, revision: 3 })
      .mockResolvedValueOnce(reviewed);

    await expect(discardRecoveryDraft(reviewed)).resolves.toBe(false);
    expect(mocks.del).not.toHaveBeenCalled();

    await expect(discardRecoveryDraft(reviewed)).resolves.toBe(true);
    expect(mocks.del).toHaveBeenCalledWith('canvink:recovery:v1');
  });

  it('distinguishes a stale duplicate from genuinely unsaved content', async () => {
    const workspace = createDefaultWorkspace();
    const draft = {
      version: 1 as const,
      sessionId: 'previous-session',
      revision: 2,
      capturedAt: '2026-08-01T10:00:00.000Z',
      workspace: structuredClone(workspace),
    };
    const { recoveryDraftDiffersFrom } = await import('./recoveryJournal');

    expect(recoveryDraftDiffersFrom(draft, workspace)).toBe(false);
    draft.workspace.notebooks[0].sections[0].pages[0].title = 'Unsaved title';
    expect(recoveryDraftDiffersFrom(draft, workspace)).toBe(true);
  });
});
