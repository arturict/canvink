import { generateAutomergeUrl, parseAutomergeUrl, type AutomergeUrl } from '@automerge/automerge-repo';
import { describe, expect, it } from 'vitest';
import { isValidDocumentUrl, newDocumentUrl, storageIdOfUrl } from './workspaceDocuments';

describe('document URLs', () => {
  it('gives a new document the storage id that parsing its URL would give', () => {
    for (let index = 0; index < 20; index += 1) {
      const { url, storageId } = newDocumentUrl();
      expect(storageId).toBe(parseAutomergeUrl(url).documentId);
      expect(storageIdOfUrl(url)).toBe(storageId);
      expect(isValidDocumentUrl(url)).toBe(true);
    }
  });

  it('reads the storage id of a URL it has not seen, and rejects what is not a URL of a document', () => {
    const url = generateAutomergeUrl();
    expect(storageIdOfUrl(url)).toBe(parseAutomergeUrl(url).documentId);
    expect(isValidDocumentUrl(url)).toBe(true);
    const damaged = `${url.slice(0, -2)}xx` as AutomergeUrl;
    expect(isValidDocumentUrl(damaged)).toBe(false);
    expect(() => storageIdOfUrl(damaged)).toThrow(/Invalid Automerge URL/);
    expect(isValidDocumentUrl('not a url')).toBe(false);
  });
});
