import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSpaceLink, loadSpaceLink, saveSpaceLink } from './linkStore';

const STORAGE_KEY = 'canvink:personal-space:link:v1';

/**
 * This project's vitest config runs under Node's `environment: 'node'`,
 * where `localStorage` is `undefined` (see
 * `src/components/collab/realCollabGateway.test.ts`). Stub a minimal
 * in-memory implementation so these tests exercise the real persistence path.
 */
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
}

describe('linkStore', () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  it('returns undefined when nothing is stored', () => {
    expect(loadSpaceLink()).toBeUndefined();
  });

  it('round-trips a saved record', () => {
    saveSpaceLink({ spaceId: 'space1', sub: 'user_1', linkedAt: '2026-09-02T10:00:00.000Z' });
    expect(loadSpaceLink()).toEqual({
      spaceId: 'space1',
      sub: 'user_1',
      linkedAt: '2026-09-02T10:00:00.000Z',
    });
  });

  it('overwrites an existing record', () => {
    saveSpaceLink({ spaceId: 'space1', sub: 'user_1', linkedAt: '2026-09-02T10:00:00.000Z' });
    saveSpaceLink({ spaceId: 'space2', sub: 'user_2', linkedAt: '2026-09-03T10:00:00.000Z' });
    expect(loadSpaceLink()).toEqual({
      spaceId: 'space2',
      sub: 'user_2',
      linkedAt: '2026-09-03T10:00:00.000Z',
    });
  });

  it('clearSpaceLink removes the record', () => {
    saveSpaceLink({ spaceId: 'space1', sub: 'user_1', linkedAt: '2026-09-02T10:00:00.000Z' });
    clearSpaceLink();
    expect(loadSpaceLink()).toBeUndefined();
  });

  it('defensively ignores malformed JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadSpaceLink()).toBeUndefined();
  });

  it('defensively ignores a well-formed JSON value missing required fields', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ spaceId: 'space1' }));
    expect(loadSpaceLink()).toBeUndefined();
  });

  it('defensively ignores a non-object JSON value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('just a string'));
    expect(loadSpaceLink()).toBeUndefined();
  });
});
