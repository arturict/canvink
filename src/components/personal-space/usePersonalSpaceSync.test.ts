/**
 * Unit tests for the pure helpers `usePersonalSpaceSync.ts` exports
 * (PERSONAL-SYNC.md §9 Wave 5). Following this repo's `environment: 'node'`
 * Vitest convention, the hook itself is not render-tested — there is no
 * React renderer in this project's test toolchain — but every decision it
 * makes that does not require a live socket or a real `WorkspaceV2Runtime`
 * is factored into a pure, exported function and tested here.
 */

import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { createNotebookAutomergeDoc, saveAutomergeDocument } from '../../crdt';
import type { NotebookDoc } from '../../domain/v2';
import type { SpacePlan } from '../../personal-space';
import { BUNDLED_START_PAGE_ID } from '../../domain/sample';
import type { V2RuntimeState } from '../../storage/workspaceV2Runtime';
import type { SpaceWorkspaceDocV1 } from '../../personal-space';
import {
  credentialFromJwt,
  decodeJwtExpirySeconds,
  findAssetMimeType,
  isLocalWorkspacePristine,
  landingPageToDownload,
  projectLocalTopologyIntoWorkspaceDoc,
  starterHoldsTypedText,
} from './usePersonalSpaceSync';

const TIME = '2026-09-02T08:00:00.000Z';

function base64UrlEncode(json: object): string {
  const text = JSON.stringify(json);
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${base64UrlEncode({ alg: 'none' })}.${base64UrlEncode(payload)}.sig`;
}

function workspace(overrides: Partial<V2RuntimeState> = {}): V2RuntimeState {
  return {
    schemaVersion: 3,
    authoritative: 'v3',
    active: { notebookId: 'n1', sectionId: 's1', pageId: 'p1' },
    notebooks: [{
      documentId: 'notebook:n1',
      kind: 'notebook',
      notebookId: 'n1',
      title: 'Notebook',
      color: '#123456',
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{ id: 's1', title: 'Section', createdAt: TIME, updatedAt: TIME, pageDocumentIds: ['page:p1'] }],
      settings: { defaultPageType: 'a4' },
      schemaVersion: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
    pages: [{
      documentId: 'page:p1',
      kind: 'page',
      notebookId: 'n1',
      sectionId: 's1',
      pageId: BUNDLED_START_PAGE_ID,
      title: 'Page',
      tags: [],
      pageType: 'a4',
      background: { type: 'grid', color: '#ffffff' },
      createdAt: TIME,
      updatedAt: TIME,
      elementsById: {},
      zOrder: [],
      schemaVersion: 3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
    activation: {
      version: 1,
      schemaVersion: 3,
      format: 'canvink-automerge-v3',
      migrationId: 'migration-1',
      sourceFingerprint: 'sha256:source',
      artifactFingerprint: 'sha256:artifact',
      activatedAt: TIME,
      manifest: {
        schemaVersion: 3,
        format: 'canvink-schema-v3',
        upgrade: {
          name: 'workspace-v2-to-v3', version: 1, upgradeId: 'upgrade-1',
          sourceArtifactFingerprint: 'sha256:source', preparedAt: TIME,
        },
        active: { notebookId: 'n1', sectionId: 's1', pageId: 'p1' },
        notebookDocumentIds: ['notebook:n1'],
        pageDocumentIds: ['page:p1'],
        assetIds: [],
        trash: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      documents: [],
      chunks: [],
      assetIds: [],
    },
    ...overrides,
  };
}

function emptyDoc(): SpaceWorkspaceDocV1 {
  return { v: 1, notebooks: {}, pages: {}, assets: {} };
}

describe('decodeJwtExpirySeconds / credentialFromJwt', () => {
  it('reads the exp claim from a well-formed JWT', () => {
    const jwt = fakeJwt({ sub: 'user_1', exp: 1_800_000_000 });
    expect(decodeJwtExpirySeconds(jwt)).toBe(1_800_000_000);
  });

  it('returns undefined for a malformed token', () => {
    expect(decodeJwtExpirySeconds('not-a-jwt')).toBeUndefined();
    expect(decodeJwtExpirySeconds('a.b')).toBeUndefined();
  });

  it('falls back to now + 55s when exp cannot be decoded', () => {
    const credential = credentialFromJwt('not-a-jwt', () => 1_000);
    expect(credential).toEqual({ jwt: 'not-a-jwt', expiresAt: 1_055 });
  });

  it('uses the decoded exp when present', () => {
    const jwt = fakeJwt({ sub: 'user_1', exp: 42 });
    const credential = credentialFromJwt(jwt, () => 1_000);
    expect(credential).toEqual({ jwt, expiresAt: 42 });
  });
});

describe('isLocalWorkspacePristine', () => {
  it('is true when the bundled start page is still present and nothing was added', () => {
    expect(isLocalWorkspacePristine(workspace())).toBe(true);
  });

  it('is false once the person changed the page, a section or the notebook (their times moved)', () => {
    const edited = workspace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (edited.pages[0] as any).updatedAt = '2026-09-02T08:05:00.000Z';
    expect(isLocalWorkspacePristine(edited)).toBe(false);

    const renamed = workspace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (renamed.notebooks[0] as any).updatedAt = '2026-09-02T08:05:00.000Z';
    expect(isLocalWorkspacePristine(renamed)).toBe(false);

    const section = workspace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (section.notebooks[0] as any).sections[0].updatedAt = '2026-09-02T08:05:00.000Z';
    expect(isLocalWorkspacePristine(section)).toBe(false);
  });

  it('is false without the bundled start page (a fully custom single-page workspace)', () => {
    const ws = workspace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ws.pages[0] as any).pageId = 'p1';
    expect(isLocalWorkspacePristine(ws)).toBe(false);
  });

  it('is false with a second notebook', () => {
    const ws = workspace();
    ws.notebooks = [...ws.notebooks, { ...ws.notebooks[0], documentId: 'notebook:n2', notebookId: 'n2' }];
    expect(isLocalWorkspacePristine(ws)).toBe(false);
  });

  it('is false once more pages exist than the bundled sample ships with', () => {
    const ws = workspace();
    ws.pages = [
      ...ws.pages,
      ...Array.from({ length: 4 }, (_, index) => ({ ...ws.pages[0], documentId: `page:extra-${index}`, pageId: `extra-${index}` })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    expect(isLocalWorkspacePristine(ws)).toBe(false);
  });
});

describe('starterHoldsTypedText', () => {
  function runtimeOf(docs: Record<string, Automerge.Doc<{ text: string }>>) {
    return {
      readDocument: async <T,>(documentId: string, reader: (document: never) => T | Promise<T>): Promise<T> => {
        const doc = docs[documentId];
        if (!doc) throw new Error('missing');
        return reader(doc as never);
      },
    };
  }
  const created = Automerge.change(Automerge.init<{ text: string }>(), { message: 'Initialize Canvink schema-v3 document' }, (draft) => {
    draft.text = 'Alles wird automatisch auf diesem Gerät gespeichert.';
  });

  it('is false for a page that only has its creation change', async () => {
    expect(await starterHoldsTypedText(runtimeOf({ 'page:p1': created }), workspace())).toBe(false);
  });

  it('is true once a typed edit is in the page history, although the page times never moved', async () => {
    const typed = Automerge.change(created, { message: 'Edit rich text' }, (draft) => {
      draft.text += ' Meine Notiz.';
    });
    expect(await starterHoldsTypedText(runtimeOf({ 'page:p1': typed }), workspace())).toBe(true);
  });

  it('asks when a page cannot be read', async () => {
    expect(await starterHoldsTypedText(runtimeOf({}), workspace())).toBe(true);
  });
});

describe('findAssetMimeType', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const text = (value: string) => new TextEncoder().encode(value);

  it('recognises the image and document formats pages embed from their first bytes', () => {
    expect(findAssetMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe('image/png');
    expect(findAssetMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(findAssetMimeType(text('GIF89a...'))).toBe('image/gif');
    expect(findAssetMimeType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(findAssetMimeType(text('%PDF-1.7\n'))).toBe('application/pdf');
    expect(findAssetMimeType(text('  <svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(findAssetMimeType(text('<?xml version="1.0"?><svg></svg>'))).toBe('image/svg+xml');
  });

  it('falls back to application/octet-stream for formats without a clear signature', () => {
    expect(findAssetMimeType(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('application/octet-stream');
    expect(findAssetMimeType(text('plain notes'))).toBe('application/octet-stream');
    expect(findAssetMimeType(new Uint8Array())).toBe('application/octet-stream');
  });
});

describe('projectLocalTopologyIntoWorkspaceDoc', () => {
  it('returns null when the workspace doc already matches local topology', () => {
    const doc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { 'notebook:n1': { order: 'a0', addedAt: TIME } },
      pages: { 'page:p1': { notebookDocumentId: 'notebook:n1', addedAt: TIME } },
    };
    expect(projectLocalTopologyIntoWorkspaceDoc(doc, workspace(), TIME)).toBeNull();
  });

  it('records the share room of a joined notebook once, so the account\'s other devices can connect it', () => {
    const doc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { 'notebook:n1': { order: 'a0', addedAt: TIME } },
      pages: { 'page:p1': { notebookDocumentId: 'notebook:n1', addedAt: TIME } },
    };
    const rooms = new Map([['notebook:n1', 'room-1']]);
    const change = projectLocalTopologyIntoWorkspaceDoc(doc, workspace(), TIME, rooms);
    expect(change).not.toBeNull();
    const applied = structuredClone(doc);
    change?.(applied);
    expect(applied.notebooks['notebook:n1'].sharedRoomId).toBe('room-1');
    // Nothing is left to record once the document has it.
    expect(projectLocalTopologyIntoWorkspaceDoc(applied, workspace(), TIME, rooms)).toBeNull();
    // A room for a notebook this workspace does not hold is not written.
    expect(projectLocalTopologyIntoWorkspaceDoc(doc, workspace(), TIME, new Map([['notebook:other', 'room-2']]))).toBeNull();
  });

  it('adds a new local notebook and page', () => {
    const change = projectLocalTopologyIntoWorkspaceDoc(emptyDoc(), workspace(), TIME);
    expect(change).not.toBeNull();
    // Applying `change` is exercised end-to-end via Automerge.change in `workspaceDoc.test.ts`
    // (wave 3); here it is enough to know a mutator was produced rather than a no-op.
  });

  it('propagates a local soft delete into the workspace doc', () => {
    const doc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { 'notebook:n1': { order: 'a0', addedAt: TIME } },
      pages: { 'page:p1': { notebookDocumentId: 'notebook:n1', addedAt: TIME } },
    };
    const ws = workspace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ws.activation.manifest as any).trash = [{ id: 'notebook:n1', kind: 'notebook', notebookDocumentId: 'notebook:n1', deletedAt: TIME, origin: { source: 'user' } }];
    const change = projectLocalTopologyIntoWorkspaceDoc(doc, ws, TIME);
    expect(change).not.toBeNull();
  });

  it('retires a page document that a rebuild replaced, once its replacement is part of the workspace', () => {
    const doc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { 'notebook:n1': { order: 'a0', addedAt: TIME } },
      pages: {
        'page:p1': { notebookDocumentId: 'notebook:n1', addedAt: TIME },
        'page:p1~r1': { notebookDocumentId: 'notebook:n1', addedAt: TIME },
      },
    };
    const ws = workspace();
    const notebook = ws.notebooks[0] as unknown as Record<string, unknown> & { sections: Array<{ pageDocumentIds: string[] }> };
    notebook.sections[0].pageDocumentIds = ['page:p1~r1'];
    notebook['swap:page:p1~r1'] = 'page:p1';
    const manifest = ws.activation.manifest as unknown as { pageDocumentIds: string[] };
    manifest.pageDocumentIds = ['page:p1~r1'];
    const change = projectLocalTopologyIntoWorkspaceDoc(doc, ws, TIME);
    expect(change).not.toBeNull();
    const applied = structuredClone(doc);
    change?.(applied);
    expect(applied.pages['page:p1'].purgedAt).toBe(TIME);
    expect(applied.pages['page:p1~r1'].purgedAt).toBeUndefined();

    // Nothing to do once it is retired.
    expect(projectLocalTopologyIntoWorkspaceDoc(applied, ws, TIME)).toBeNull();
  });
});

describe('landingPageToDownload', () => {
  function notebookBytes(pageDocumentIds: string[]): Uint8Array {
    const notebook: NotebookDoc = {
      schemaVersion: 2, documentId: 'notebook:n', kind: 'notebook', notebookId: 'n', title: 'Notebook', color: '#123456',
      createdAt: TIME, updatedAt: TIME,
      sections: [{ id: 's', title: 'Section', createdAt: TIME, updatedAt: TIME, pageDocumentIds }],
      settings: { defaultPageType: 'a4' }, version: { protocol: 'uninitialized', heads: [] },
    };
    return saveAutomergeDocument(createNotebookAutomergeDoc(notebook));
  }

  const plan = (overrides: Partial<SpacePlan>): SpacePlan => ({
    adoptedDocuments: [], placeholderPages: [], removedDocumentIds: [], notebookDocumentIds: [],
    pageDocumentIds: [], trashAdditions: [], trashRemovals: [], ...overrides,
  });
  const placeholder = (documentId: string) => ({ documentId, summary: { documentId } as never });

  it('names the first listed page of an adopted notebook when only placeholders would be shown', async () => {
    const notebook = { documentId: 'notebook:n', kind: 'notebook' as const, bytes: notebookBytes(['page:a', 'page:b']) };
    await expect(landingPageToDownload(plan({ adoptedDocuments: [notebook], placeholderPages: [placeholder('page:a'), placeholder('page:b')] }), 2))
      .resolves.toBe('page:a');
  });

  it('has nothing to download when the plan lists no placeholder page of the notebook', async () => {
    const notebook = { documentId: 'notebook:n', kind: 'notebook' as const, bytes: notebookBytes(['page:a']) };
    await expect(landingPageToDownload(plan({ adoptedDocuments: [notebook] }), 2)).resolves.toBeUndefined();
    await expect(landingPageToDownload(plan({}), 2)).resolves.toBeUndefined();
  });
});
