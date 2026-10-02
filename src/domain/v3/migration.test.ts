import { describe, expect, it } from 'vitest';
import type { MigrationManifestV2, PageDoc } from '../v2';
import { upgradeDocumentV2ToV3, upgradeManifestV2ToV3 } from './migration';

const TIME = '2026-08-03T08:00:00.000Z';
const SHA = `sha256:${'a'.repeat(64)}` as const;

function page(): PageDoc {
  return {
    schemaVersion: 2, documentId: 'page:p1', kind: 'page', notebookId: 'n1', sectionId: 's1', pageId: 'p1',
    title: 'Old page', tags: [], pageType: 'a4', background: { type: 'grid', color: '#fff' },
    createdAt: TIME, updatedAt: TIME, elementsById: {}, zOrder: [],
    version: { protocol: 'uninitialized', heads: [] },
  };
}

function manifest(): MigrationManifestV2 {
  return {
    schemaVersion: 2, format: 'canvink-schema-v2',
    migration: { name: 'workspace-v1-to-v2', version: 1, migrationId: 'm1', sourceFingerprint: SHA, preparedAt: TIME },
    active: { notebookId: 'n1', sectionId: 's1', pageId: 'p1' },
    notebookDocumentIds: ['notebook:n1'], pageDocumentIds: ['page:p1'], assetIds: [], trash: [],
  };
}

describe('workspace v2 to v3 migration', () => {
  it('changes only the document schema selector and does not persist default page settings', () => {
    const before = page();
    const after = upgradeDocumentV2ToV3(before);
    expect(after).toEqual({ ...before, schemaVersion: 3 });
    expect(after).not.toHaveProperty('mathSettings');
    expect(after).not.toHaveProperty('pageContent');
    expect(before.schemaVersion).toBe(2);
  });

  it('produces deterministic, explicit upgrade provenance without changing v1 migration metadata', () => {
    const first = upgradeManifestV2ToV3(manifest(), SHA, TIME);
    const second = upgradeManifestV2ToV3(manifest(), SHA, TIME);
    expect(second).toEqual(first);
    expect(first.migration).toEqual(manifest().migration);
    expect(first.upgrade).toEqual({
      name: 'workspace-v2-to-v3', version: 1,
      upgradeId: `workspace-v2-to-v3:${'a'.repeat(64)}`,
      sourceArtifactFingerprint: SHA, preparedAt: TIME,
    });
  });
});
