import * as Automerge from '@automerge/automerge';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocHandle } from '@automerge/automerge-repo';
import type { LivePageDocV2 } from '../../crdt';
import type { SyncPanelController, SyncPanelSnapshot } from './types';
import SyncCollaborationPanel from './SyncCollaborationPanel';

describe('SyncCollaborationPanel fake two-account flow', () => {
  it('shows owner collaboration controls and the viewer read-only state', () => {
    const owner = renderToStaticMarkup(createElement(SyncCollaborationPanel, {
      notebookId: 'notebook-1', pageId: 'page-1', pageHandle: handle(),
      controller: fakeController({
        ...baseSnapshot(), status: 'online', role: 'owner', accountName: 'Ada Owner', accountEmail: 'ada@example.test',
        members: [{ membershipId: 'member-1', userId: 'user-2', name: 'Vera Viewer', email: 'vera@example.test', role: 'viewer', confirmed: true }],
      }),
      initiallyOpen: true,
    }));
    const viewer = renderToStaticMarkup(createElement(SyncCollaborationPanel, {
      notebookId: 'notebook-1', pageId: 'page-1', pageHandle: handle(),
      controller: fakeController({ ...baseSnapshot(), status: 'online', role: 'viewer', accountName: 'Vera Viewer' }),
      initiallyOpen: true,
    }));

    expect(owner).toContain('Ada Owner');
    expect(owner).toContain('Einladen');
    expect(owner).toContain('Schlüsselepoche rotieren');
    expect(viewer).toContain('Nur Lesen: Dieses Konto kann das Notizbuch nicht ändern.');
    expect(viewer).not.toContain('Einladen</button>');
    expect(viewer).not.toContain('Schlüsselepoche rotieren');
  });

  it('shows the explicit browser-session key warning', () => {
    const markup = renderToStaticMarkup(createElement(SyncCollaborationPanel, {
      notebookId: 'notebook-1', pageId: 'page-1', pageHandle: handle(),
      controller: fakeController({ ...baseSnapshot(), status: 'approval-required', browserSessionOnly: true }),
    }));
    expect(markup).toContain('Browserschlüssel gelten nur für diese Sitzung');
  });
});

function baseSnapshot(): SyncPanelSnapshot {
  return { status: 'local', role: null, pendingChanges: 0, browserSessionOnly: false, recoveryAcknowledged: false, members: [], devices: [], presences: [] };
}

function handle(): DocHandle<LivePageDocV2> {
  const document = Automerge.from({
    schemaVersion: 2, documentId: 'page:page-1', kind: 'page', notebookId: 'notebook-1', sectionId: 'section-1', pageId: 'page-1', title: 'Page', tags: [], pageType: 'a4', background: { type: 'grid', color: '#fff' }, createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', elementsById: {}, zOrder: [],
  } as LivePageDocV2);
  return { doc: () => document } as DocHandle<LivePageDocV2>;
}

function fakeController(state: SyncPanelSnapshot): SyncPanelController {
  const done = async () => undefined;
  return {
    snapshot: () => state, subscribe: () => () => undefined, connectDocument: () => () => undefined, openNotebook: done, configure: done,
    signInMicrosoft: done, startEmailOtp: done, completeEmailOtp: done, enableNotebookTeam: done,
    requestExistingDeviceApproval: done, approveDeviceRequest: done, recoverWithCode: done, acknowledgeRecoveryCode: done,
    invite: done, updateMemberRole: done, removeMember: done, rotateEpoch: done, markDeviceLost: done,
    publishPresence: done, disable: done, logout: done,
  };
}
