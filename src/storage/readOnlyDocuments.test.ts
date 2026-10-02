import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDocumentWritable,
  isDocumentReadOnly,
  ReadOnlyDocumentError,
  setReadOnlyDocuments,
} from './readOnlyDocuments';

describe('read-only documents', () => {
  afterEach(() => setReadOnlyDocuments([]));

  it('refuses a local edit of a document of a notebook shared read-only, and only of those', () => {
    setReadOnlyDocuments(['notebook:1', 'page:1']);
    expect(isDocumentReadOnly('page:1')).toBe(true);
    expect(() => assertDocumentWritable('page:1')).toThrow(ReadOnlyDocumentError);
    expect(() => assertDocumentWritable('page:2')).not.toThrow();
  });

  it('replaces the set as a whole, so a promotion lifts the guard', () => {
    setReadOnlyDocuments(['page:1']);
    setReadOnlyDocuments([]);
    expect(isDocumentReadOnly('page:1')).toBe(false);
  });
});
