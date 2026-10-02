import { beforeEach, describe, expect, it } from 'vitest';
import { parseJoinHash } from './joinHash';
import { getJoinedRoom, loadJoinedRooms, removeJoinedRoom, saveJoinedRoom } from './joinedRoomStore';

describe('parseJoinHash', () => {
  it('parses a well-formed join hash', () => {
    expect(parseJoinHash('#join=room-1.secret-abc')).toEqual({ roomId: 'room-1', linkSecret: 'secret-abc' });
    expect(parseJoinHash('join=room-1.secret-abc')).toEqual({ roomId: 'room-1', linkSecret: 'secret-abc' });
  });

  it('rejects hashes that are not a join link', () => {
    expect(parseJoinHash('')).toBeNull();
    expect(parseJoinHash('#other')).toBeNull();
    expect(parseJoinHash('#join=room-1')).toBeNull();
  });
});

describe('joined room records', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      },
    });
  });

  it('keeps only the room id, never a link secret', () => {
    saveJoinedRoom('notebook-1', { roomId: 'room-1', linkSecret: 'must-not-be-kept' } as { roomId: string });
    expect(getJoinedRoom('notebook-1')).toEqual({ roomId: 'room-1' });
    expect([...store.values()].join()).not.toContain('must-not-be-kept');
    removeJoinedRoom('notebook-1');
    expect(getJoinedRoom('notebook-1')).toBeUndefined();
  });

  it('ignores a damaged record instead of failing', () => {
    store.set('canvink:collab:joined:v1', JSON.stringify({ good: { roomId: 'r' }, bad: { roomId: 7 }, worse: null }));
    expect(loadJoinedRooms()).toEqual({ good: { roomId: 'r' } });
    store.set('canvink:collab:joined:v1', '{not json');
    expect(loadJoinedRooms()).toEqual({});
  });
});
