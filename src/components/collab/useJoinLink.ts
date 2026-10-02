/**
 * Opening a share link (`#join=<roomId>.<secret>`) in the normal app.
 *
 * A link does not open a separate viewer. It adds the shared notebook to the
 * workspace of whoever opens it, as a notebook like any other, and shows it in
 * the full app:
 *
 * - The owner who opens their own link (this device holds the room's owner
 *   record) lands in the notebook they already have, without any network.
 * - Someone who is signed in joins: the room is read with the account and the
 *   link (which registers the account as a reader; a link never grants more),
 *   or, for `#open=<roomId>`, with the account alone (the room lets in an
 *   account whose verified address was invited, with the invited role). The
 *   notebook and its pages are adopted into the workspace with their history,
 *   and from then on the account alone reconnects the notebook to its room
 *   (also on the other devices of the account, through the personal space).
 * - Someone signed out is asked to sign in first.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseJoinHash } from './joinHash';
import { adoptSharedNotebook, fetchSharedNotebook, JoinRoomError } from './adoptSharedDocuments';
import { loadOwnerRooms } from './ownerRoomStore';
import { loadJoinedRooms, saveJoinedRoom } from './joinedRoomStore';
import type { CollabGateway } from './collabGateway';
import type { OptionalAuthValue } from '../../auth';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';

export type JoinLinkState =
  | { kind: 'idle' }
  /** Nobody can sign in here (no account service in this build), so a link cannot be followed. */
  | { kind: 'unavailable' }
  | { kind: 'sign-in'; title: string | null }
  | { kind: 'joining'; title: string | null }
  | { kind: 'error'; reason: JoinRoomError['reason'] | 'other' };

export interface UseJoinLinkParams {
  /** Raw `window.location.hash`. */
  hash: string;
  runtime: WorkspaceV2Runtime | null;
  workspace: V2RuntimeState | null;
  syncUrl: string | undefined;
  gateway: CollabGateway | null;
  auth: OptionalAuthValue;
  /**
   * False while the personal space still has to decide how this device links
   * to the account: a notebook adopted before that could be replaced by the
   * account's workspace.
   */
  accountReady: boolean;
  /** The notebook is part of the workspace; show it. `added` is false when it already was. */
  onJoined(notebookId: string, added: boolean): void;
  /** The link was dealt with (or dismissed); drop it from the address. */
  onFinished(): void;
}

export interface UseJoinLinkResult {
  state: JoinLinkState;
  signIn(): void;
  retry(): void;
  dismiss(): void;
}

function notebookIdOfRoom(roomId: string): string | undefined {
  const owned = Object.entries(loadOwnerRooms()).find(([, record]) => record.roomId === roomId);
  if (owned) return owned[0];
  return Object.entries(loadJoinedRooms()).find(([, record]) => record.roomId === roomId)?.[0];
}

export function useJoinLink(params: UseJoinLinkParams): UseJoinLinkResult {
  const { hash, runtime, workspace, syncUrl, gateway, auth, accountReady } = params;
  const link = parseJoinHash(hash);
  const linkKey = link ? `${link.roomId}.${link.linkSecret ?? ''}` : null;
  const [title, setTitle] = useState<{ key: string; title: string } | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; state: JoinLinkState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const startedRef = useRef<string | null>(null);
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  });
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const signedIn = auth.available && auth.isSignedIn;
  const ready = Boolean(runtime && workspace && gateway && syncUrl);

  // The title of the notebook in the sign-in prompt; it needs the link only.
  useEffect(() => {
    if (!link?.linkSecret || !gateway || !syncUrl || signedIn || !auth.available) return;
    const { linkSecret } = link;
    let cancelled = false;
    void gateway.fetchMeta(link.roomId, linkSecret)
      .then((meta) => { if (!cancelled) setTitle({ key: `${link.roomId}.${linkSecret}`, title: meta.notebookTitle }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // The link, not its parsed object, identifies the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, syncUrl, signedIn, auth.available, linkKey]);

  useEffect(() => {
    if (!link || !linkKey || !runtime || !workspace || !ready) return;
    if (startedRef.current === `${linkKey}#${attempt}`) return;
    // The owner, or a member who already joined: the notebook is in the workspace already.
    const knownNotebookId = notebookIdOfRoom(link.roomId);
    if (knownNotebookId && workspace.notebooks.some((notebook) => notebook.notebookId === knownNotebookId)) {
      startedRef.current = `${linkKey}#${attempt}`;
      paramsRef.current.onJoined(knownNotebookId, false);
      paramsRef.current.onFinished();
      return;
    }
    if (!auth.available || !signedIn || !accountReady || !syncUrl) return;
    startedRef.current = `${linkKey}#${attempt}`;
    const key = linkKey;
    const { getToken } = auth;
    void (async () => {
      try {
        const shared = await fetchSharedNotebook({
          syncUrl,
          roomId: link.roomId,
          ...(link.linkSecret ? { linkSecret: link.linkSecret } : {}),
          getToken: () => getToken(),
        });
        const adopted = await adoptSharedNotebook(runtime, shared);
        // An owner's record wins: that device authenticates with the owner token, not the account.
        if (!loadOwnerRooms()[adopted.notebookId]) saveJoinedRoom(adopted.notebookId, { roomId: shared.roomId, role: shared.role });
        if (!aliveRef.current) return;
        paramsRef.current.onJoined(adopted.notebookId, adopted.added);
        paramsRef.current.onFinished();
      } catch (error) {
        if (!aliveRef.current) return;
        setOutcome({
          key,
          state: { kind: 'error', reason: error instanceof JoinRoomError ? error.reason : 'other' },
        });
      }
    })();
    // The dialog must not restart a join that is already running when the workspace changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey, runtime, workspace, ready, signedIn, accountReady, syncUrl, attempt]);

  const retry = useCallback(() => {
    setOutcome(null);
    setAttempt((current) => current + 1);
  }, []);

  let state: JoinLinkState = { kind: 'idle' };
  const knownNotebookId = link ? notebookIdOfRoom(link.roomId) : undefined;
  const alreadyHere = Boolean(knownNotebookId && workspace?.notebooks.some((notebook) => notebook.notebookId === knownNotebookId));
  if (link && linkKey && !alreadyHere) {
    const shownOutcome = outcome?.key === linkKey ? outcome.state : null;
    if (shownOutcome) state = shownOutcome;
    else if (!syncUrl || !auth.available) state = { kind: 'unavailable' };
    else if (!signedIn) state = { kind: 'sign-in', title: title?.key === linkKey ? title.title : null };
    else state = { kind: 'joining', title: title?.key === linkKey ? title.title : null };
  }

  return {
    state,
    signIn: () => {
      if (auth.available) auth.openSignIn();
    },
    retry,
    dismiss: () => paramsRef.current.onFinished(),
  };
}
