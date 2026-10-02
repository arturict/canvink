import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url, parseServerFrame } from './protocol';

describe('base64url codec', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (let length = 0; length < 12; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 5) % 256;
      const encoded = encodeBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(decodeBase64Url(encoded)).toEqual(bytes);
    }
  });

  it('rejects invalid characters', () => {
    expect(() => decodeBase64Url('not valid!')).toThrow();
    expect(() => decodeBase64Url('***')).toThrow();
  });
});

describe('parseServerFrame', () => {
  it('parses a welcome frame', () => {
    const frame = parseServerFrame({
      t: 'welcome',
      role: 'viewer',
      docs: [{ docId: 'notebook:1', kind: 'notebook' }],
      notebookTitle: 'Physics',
    });
    expect(frame).toEqual({
      t: 'welcome',
      role: 'viewer',
      docs: [{ docId: 'notebook:1', kind: 'notebook' }],
      notebookTitle: 'Physics',
    });
  });

  it('parses an append frame with seq', () => {
    const frame = parseServerFrame({ t: 'append', docId: 'page:1', payload: 'abc', seq: 3 });
    expect(frame).toEqual({ t: 'append', docId: 'page:1', payload: 'abc', seq: 3 });
  });

  it('parses error frames with and without detail', () => {
    expect(parseServerFrame({ t: 'error', code: 'read-only' })).toEqual({
      t: 'error',
      code: 'read-only',
    });
    expect(parseServerFrame({ t: 'error', code: 'unauthorized', detail: 'bad token' })).toEqual({
      t: 'error',
      code: 'unauthorized',
      detail: 'bad token',
    });
  });

  it('rejects malformed and unknown frames', () => {
    expect(() => parseServerFrame(null)).toThrow();
    expect(() => parseServerFrame({})).toThrow();
    expect(() => parseServerFrame({ t: 'welcome', role: 'nope', docs: [], notebookTitle: '' })).toThrow();
    expect(() => parseServerFrame({ t: 'snapshot', docId: 'x' })).toThrow();
    expect(() => parseServerFrame({ t: 'mystery' })).toThrow();
    expect(() => parseServerFrame({ t: 'error', code: 'not-a-real-code' })).toThrow();
  });

  it('B1c: parses a seq ack frame', () => {
    const frame = parseServerFrame({ t: 'seq', docId: 'page:1', seq: 5 });
    expect(frame).toEqual({ t: 'seq', docId: 'page:1', seq: 5 });
  });

  it('rejects a malformed seq frame', () => {
    expect(() => parseServerFrame({ t: 'seq', docId: 'page:1' })).toThrow();
    expect(() => parseServerFrame({ t: 'seq', seq: 5 })).toThrow();
  });

  it('accepts a "workspace" doc kind in welcome and announce frames', () => {
    expect(
      parseServerFrame({
        t: 'welcome',
        role: 'owner',
        docs: [{ docId: 'workspace:root', kind: 'workspace' }],
        notebookTitle: '',
      }),
    ).toEqual({
      t: 'welcome',
      role: 'owner',
      docs: [{ docId: 'workspace:root', kind: 'workspace' }],
      notebookTitle: '',
    });
    expect(parseServerFrame({ t: 'announce', docId: 'workspace:root', kind: 'workspace' })).toEqual({
      t: 'announce',
      docId: 'workspace:root',
      kind: 'workspace',
    });
  });

  it('parses a reauthed frame', () => {
    expect(parseServerFrame({ t: 'reauthed', expiresAt: 1_788_888_888 })).toEqual({
      t: 'reauthed',
      expiresAt: 1_788_888_888,
    });
  });

  it('rejects a malformed reauthed frame', () => {
    expect(() => parseServerFrame({ t: 'reauthed' })).toThrow();
    expect(() => parseServerFrame({ t: 'reauthed', expiresAt: 'soon' })).toThrow();
  });

  it('parses a quota-exceeded error frame', () => {
    expect(parseServerFrame({ t: 'error', code: 'quota-exceeded', detail: 'log' })).toEqual({
      t: 'error',
      code: 'quota-exceeded',
      detail: 'log',
    });
  });

  it('reads the kind of a document the room stored as unknown from its id, instead of rejecting the welcome', () => {
    const frame = parseServerFrame({
      t: 'welcome',
      role: 'owner',
      lazy: true,
      notebookTitle: '',
      docs: [
        { docId: 'page:1', kind: 'unknown' },
        { docId: 'notebook:2', kind: 'unknown' },
        { docId: 'workspace:root', kind: 'workspace' },
      ],
    });
    expect(frame).toEqual({
      t: 'welcome',
      role: 'owner',
      lazy: true,
      notebookTitle: '',
      docs: [
        { docId: 'page:1', kind: 'page' },
        { docId: 'notebook:2', kind: 'notebook' },
        { docId: 'workspace:root', kind: 'workspace' },
      ],
    });
    expect(() => parseServerFrame({ t: 'welcome', role: 'owner', notebookTitle: '', docs: [{ docId: 'other', kind: 'unknown' }] })).toThrow(/Malformed/);
  });

  it('parses fetched with and without an id', () => {
    expect(parseServerFrame({ t: 'fetched', id: '3', docIds: ['page:1'], known: [] })).toEqual({ t: 'fetched', id: '3', docIds: ['page:1'], known: [] });
    expect(parseServerFrame({ t: 'fetched', docIds: [], known: [] })).toEqual({ t: 'fetched', docIds: [], known: [] });
    expect(() => parseServerFrame({ t: 'fetched', docIds: 'x', known: [] })).toThrow(/Malformed/);
  });
});
