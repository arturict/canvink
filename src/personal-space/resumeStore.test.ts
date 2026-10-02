import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSpaceResume, filterResumeToLocalCopies, loadSpaceResume, saveSpaceResume } from './resumeStore';

const entry = { kind: 'page' as const, seq: 3, heads: ['aa', 'bb'] };

describe('resume store', () => {
  beforeEach(() => {
    // The suite runs under Node, where `localStorage` does not exist.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });

  it('round-trips a record and skips the write when nothing changed', () => {
    const written = saveSpaceResume('space1', { docs: { 'page:1': entry } });
    expect(loadSpaceResume('space1')).toEqual({ docs: { 'page:1': entry } });
    localStorage.clear();
    expect(saveSpaceResume('space1', { docs: { 'page:1': entry } }, written)).toBe(written);
    expect(loadSpaceResume('space1').docs).toEqual({});
  });

  it('ignores malformed records and malformed entries', () => {
    localStorage.setItem('canvink:personal-space:resume:v1:space1', '{not json');
    expect(loadSpaceResume('space1')).toEqual({ docs: {} });
    localStorage.setItem('canvink:personal-space:resume:v1:space1', JSON.stringify({
      docs: { good: entry, noHeads: { kind: 'page', seq: 1, heads: [] }, badKind: { kind: 'workspace', seq: 1, heads: ['a'] }, badSeq: { kind: 'page', seq: -1, heads: ['a'] } },
    }));
    expect(Object.keys(loadSpaceResume('space1').docs)).toEqual(['good']);
    clearSpaceResume('space1');
    expect(loadSpaceResume('space1').docs).toEqual({});
  });

  it('keeps only entries whose local copy still has exactly the recorded heads', () => {
    const resume = { docs: { same: entry, moved: entry, missing: entry, partial: entry } };
    const local: Record<string, string[]> = { same: ['bb', 'aa'], moved: ['cc'], partial: ['aa'] };
    expect(Object.keys(filterResumeToLocalCopies(resume, (id) => local[id]).docs)).toEqual(['same']);
  });
});
