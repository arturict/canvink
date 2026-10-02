import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShareNotebookDialog, { looksLikeEmail } from './ShareNotebookDialog';
import type { CollabGateway } from './collabGateway';

function makeGateway(shared: boolean): CollabGateway {
  return {
    isShared: vi.fn(() => shared),
    createRoomForNotebook: vi.fn(),
    loadSharing: vi.fn(() => new Promise<never>(() => undefined)),
    invite: vi.fn(),
    revokeInvite: vi.fn(),
    changeRole: vi.fn(),
    removeMember: vi.fn(),
    setLinkEnabled: vi.fn(),
    regenerateLink: vi.fn(),
    unshareNotebook: vi.fn(),
    leaveNotebook: vi.fn(),
    fetchMeta: vi.fn(),
    openSession: vi.fn(),
  };
}

describe('ShareNotebookDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers to start sharing a notebook that has no room yet, and says what is stored', () => {
    const markup = renderToStaticMarkup(createElement(ShareNotebookDialog, {
      gateway: makeGateway(false),
      notebookId: 'school',
      notebookTitle: 'Schule',
      onClose: vi.fn(),
    }));
    expect(markup).toContain('Notizbuch teilen');
    expect(markup).toContain('Freigabe starten');
    expect(markup).toContain('Schule');
    expect(markup).toContain('unverschlüsselt gespeichert');
    expect(markup).toContain('role="dialog"');
  });

  it('loads a notebook that is shared already instead of offering to start again', () => {
    const markup = renderToStaticMarkup(createElement(ShareNotebookDialog, {
      gateway: makeGateway(true),
      notebookId: 'school',
      notebookTitle: 'Schule',
      onClose: vi.fn(),
    }));
    expect(markup).toContain('Freigabe wird geladen');
    expect(markup).not.toContain('Freigabe starten');
  });

  it('shows the unavailable notice and no start button when the gateway is null', () => {
    const markup = renderToStaticMarkup(createElement(ShareNotebookDialog, {
      gateway: null,
      notebookId: 'school',
      notebookTitle: 'Schule',
      onClose: vi.fn(),
    }));
    expect(markup).toContain('Teilen ist gerade nicht verfügbar');
    expect(markup).not.toContain('Freigabe starten');
  });
});

describe('looksLikeEmail', () => {
  it('accepts an address and rejects obvious typos before a request is made', () => {
    expect(looksLikeEmail(' ben@example.com ')).toBe(true);
    expect(looksLikeEmail('ben@example')).toBe(false);
    expect(looksLikeEmail('ben example.com')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });
});
