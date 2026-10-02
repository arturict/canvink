import { describe, expect, it, vi } from 'vitest';
import type { EditorLocalDocsPort } from '../collab';
import { bindPersonalSpace, type PersonalSpaceBindingSession } from './spaceBinding';

function fakes(localHeads: string[], roomHeads: string[]) {
  const listeners = new Set<(docId: string) => void>();
  const applyRemote = vi.fn(async () => undefined);
  const session = {
    isLive: () => true,
    getDocBytes: () => new Uint8Array([1]),
    getConfirmedHeads: () => roomHeads,
    getDocs: () => new Map([['page:1', { kind: 'page' as const }]]),
    sendLocalChange: vi.fn(),
    sendSnapshot: vi.fn(),
    announceDoc: vi.fn(),
    subscribeDocsChanged: (listener: (docId: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeSynced: () => () => undefined,
  } as unknown as PersonalSpaceBindingSession;
  const port = {
    listDocs: async () => [{ docId: 'page:1', kind: 'page' as const }],
    hasDoc: () => true,
    getHeads: () => localHeads,
    subscribe: () => () => undefined,
    applyRemote,
    getSnapshotBytes: async () => undefined,
    onRemoteDocAdded: vi.fn(),
  } as unknown as EditorLocalDocsPort;
  const applied = vi.fn();
  const binding = bindPersonalSpace({ session, port, onWorkspaceDoc: () => undefined, onRemoteDocApplied: applied, mayPushLocal: () => true, announced: new Set() });
  return { binding, listeners, applyRemote, applied };
}

describe('bindPersonalSpace remote documents', () => {
  it('does not merge a document whose local copy already has the room heads', async () => {
    const { binding, listeners, applyRemote, applied } = fakes(['b', 'a'], ['a', 'b']);
    listeners.forEach((listener) => listener('page:1'));
    await binding.idle();
    expect(applyRemote).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
    binding.dispose();
  });

  it('merges a document whose room copy moved on', async () => {
    const { binding, listeners, applyRemote, applied } = fakes(['a'], ['b']);
    listeners.forEach((listener) => listener('page:1'));
    await binding.idle();
    expect(applyRemote).toHaveBeenCalledOnce();
    expect(applied).toHaveBeenCalledWith('page:1');
    binding.dispose();
  });
});

describe('bindPersonalSpace push with lazily replayed pages', () => {
  function pushFakes(awaitsFetch: boolean, roomHeads: string[] | undefined) {
    const sendSnapshot = vi.fn();
    const sendLocalChange = vi.fn();
    const takeChangesSince = vi.fn(async () => new Uint8Array([7]));
    const session = {
      isLive: () => true,
      getDocBytes: () => undefined,
      getConfirmedHeads: () => roomHeads,
      getDocs: () => new Map([['page:1', { kind: 'page' as const }]]),
      awaitsFetch: () => awaitsFetch,
      sendLocalChange,
      sendSnapshot,
      announceDoc: vi.fn(),
      subscribeDocsChanged: () => () => undefined,
      subscribeSynced: () => () => undefined,
    } as unknown as PersonalSpaceBindingSession;
    const port = {
      listDocs: async () => [{ docId: 'page:1', kind: 'page' as const }],
      hasDoc: () => true,
      getHeads: () => ['local'],
      subscribe: () => () => undefined,
      applyRemote: vi.fn(),
      getSnapshotBytes: async () => new Uint8Array([1, 2, 3]),
      takeChangesSince,
      onRemoteDocAdded: vi.fn(),
    } as unknown as EditorLocalDocsPort;
    const binding = bindPersonalSpace({ session, port, onWorkspaceDoc: () => undefined, mayPushLocal: () => true, announced: new Set() });
    return { binding, sendSnapshot, sendLocalChange, takeChangesSince };
  }

  it('neither uploads the whole page nor diffs it while the room has not sent what it holds', async () => {
    const { binding, sendSnapshot, sendLocalChange, takeChangesSince } = pushFakes(true, undefined);
    await binding.pushLocal();
    expect(sendSnapshot).not.toHaveBeenCalled();
    expect(sendLocalChange).not.toHaveBeenCalled();
    expect(takeChangesSince).not.toHaveBeenCalled();
    binding.dispose();
  });

  it('uploads a page the room knows without any content, once the room was asked', async () => {
    const { binding, sendSnapshot } = pushFakes(false, undefined);
    await binding.pushLocal();
    expect(sendSnapshot).toHaveBeenCalledOnce();
    binding.dispose();
  });

  it('sends the changes the room lacks once its heads are known', async () => {
    const { binding, sendLocalChange, takeChangesSince } = pushFakes(false, ['room']);
    await binding.pushLocal();
    expect(takeChangesSince).toHaveBeenCalledWith('page:1', ['room']);
    expect(sendLocalChange).toHaveBeenCalledOnce();
    binding.dispose();
  });
});
