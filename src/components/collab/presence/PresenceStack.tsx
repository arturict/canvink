import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import {
  distinctPeople,
  isPeerIdle,
  presenceIdleAfterMs,
  type PresenceHub,
  type PresencePeer,
} from '../../../collab/presence';
import { useI18n, type TranslationKey } from '../../../i18n';
import { PresenceAvatar } from './PresenceAvatars';
import { jumpToPerson, useFollowDriver } from './follow';
import { PresencePreviewCanvas } from './PresencePreview';
import type { PreviewContent } from './previewPage';
import { usePresenceRoster } from './usePresence';
import './presence.css';

/** How many faces the topbar shows before it summarises the rest as "+N". */
export const MAX_VISIBLE_AVATARS = 3;
/** On a phone the topbar has room for two. */
export const MAX_VISIBLE_AVATARS_NARROW = 2;
/** How often idleness is re-evaluated; a person is dimmed within this of the threshold. */
const IDLE_CHECK_MS = 15_000;
const HOVER_OPEN_MS = 140;
const HOVER_CLOSE_MS = 220;
const LONG_PRESS_MS = 450;

const NARROW_QUERY = '(max-width: 640px)';

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function isNarrow(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(NARROW_QUERY).matches);
}

/**
 * Everyone working in the notebook, in the order the stack shows them:
 * active people before idle or away ones, then people on this page, then by name.
 */
export function stackOrder(peers: readonly PresencePeer[], pageDocId: string | null, now: number): PresencePeer[] {
  const rank = (peer: PresencePeer): number => (peer.away || isPeerIdle(peer, now) ? 2 : 0)
    + (pageDocId !== null && peer.page === pageDocId ? 0 : 1);
  return distinctPeople(peers).sort((left, right) => (
    rank(left) - rank(right) || left.user.name.localeCompare(right.user.name)
  ));
}

/** The first `max` faces and how many are summarised as "+N". */
export function visibleAvatars<T>(people: readonly T[], max = MAX_VISIBLE_AVATARS): { shown: T[]; more: number } {
  const shown = people.slice(0, max);
  return { shown, more: people.length - shown.length };
}

const noopSubscribe = (): (() => void) => () => undefined;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Calls `onOutside` when a pointer goes down outside `ref` or Escape is pressed, while `active`. */
function useDismiss(ref: { current: HTMLElement | null }, active: boolean, onOutside: () => void): void {
  useEffect(() => {
    if (!active) return;
    const down = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onOutside();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [ref, active, onOutside]);
}

interface StackActions {
  hub: PresenceHub;
  pageDocId: string | null;
  pageTitle(docId: string): string | undefined;
  loadContent(docId: string): Promise<PreviewContent>;
  jump(userId: string): void;
  following: string | null;
  /** The presence id of the local person, to recognise their own other devices. */
  selfId: string;
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * Another tab or device of the person looking is listed once, as themselves:
 * it is useful to jump to the pen on the tablet from the laptop, but a second
 * "own name" among the faces would read like a stranger.
 */
function personName(t: Translate, peer: PresencePeer, actions: Pick<StackActions, 'selfId'>): string {
  return peer.user.id === actions.selfId ? t('presence.self.otherDevice') : peer.user.name;
}

function pageLabel(t: (key: TranslationKey, values?: Record<string, string | number>) => string, peer: PresencePeer, title: string | undefined): string {
  if (!peer.page) return t('presence.person.noPage');
  return title ? t('presence.person.page', { title }) : t('presence.person.otherPage');
}

function PersonPreview({ peer, actions, dimmed }: { peer: PresencePeer; actions: StackActions; dimmed: boolean }) {
  const { t } = useI18n();
  const { hub } = actions;
  const following = actions.following === peer.user.id;
  const title = peer.page ? actions.pageTitle(peer.page) : undefined;
  return (
    <div
      className="presence-preview"
      role="dialog"
      aria-label={t('presence.preview.label', { name: personName(t, peer, actions) })}
      style={{ ['--presence-color' as string]: peer.user.color }}
    >
      <button
        type="button"
        className="presence-preview__picture"
        disabled={!peer.page}
        aria-label={t('presence.person.jump', { name: personName(t, peer, actions) })}
        onClick={() => actions.jump(peer.user.id)}
      >
        {peer.page ? (
          <PresencePreviewCanvas hub={hub} userId={peer.user.id} loadContent={actions.loadContent} />
        ) : (
          <span className="presence-preview__empty">{t('presence.person.noPage')}</span>
        )}
      </button>
      <strong className="presence-preview__name">{personName(t, peer, actions)}</strong>
      <small className="presence-preview__page">
        {pageLabel(t, peer, title)}
        {peer.away ? ` · ${t('presence.list.away')}` : dimmed ? ` · ${t('presence.person.idle')}` : ''}
        {peer.role === 'viewer' ? ` · ${t('presence.list.viewer')}` : ''}
      </small>
      <div className="presence-preview__actions">
        <button type="button" className="presence-preview__action" disabled={!peer.page} onClick={() => actions.jump(peer.user.id)}>
          {t('presence.person.jumpShort')}
        </button>
        <button
          type="button"
          className="presence-preview__action"
          aria-pressed={following}
          disabled={!peer.page && !following}
          onClick={() => hub.follow(following ? null : peer.user.id)}
        >
          {t(following ? 'presence.person.unfollow' : 'presence.person.follow')}
        </button>
      </div>
    </div>
  );
}

function StackPerson({ peer, index, dimmed, open, onOpenChange, actions }: {
  peer: PresencePeer;
  index: number;
  dimmed: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  actions: StackActions;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressedRef = useRef(false);
  const title = peer.page ? actions.pageTitle(peer.page) : undefined;
  const label = `${personName(t, peer, actions)} · ${pageLabel(t, peer, title)}`;
  useEffect(() => () => clearTimeout(timerRef.current), []);
  useDismiss(rootRef, open, () => onOpenChange(false));

  const later = (ms: number, next: boolean): void => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onOpenChange(next), ms);
  };
  const hovering = (event: ReactPointerEvent): boolean => event.pointerType !== 'touch';

  return (
    <div
      ref={rootRef}
      className="presence-person"
      data-presence-person={peer.user.id}
      style={{ zIndex: 10 - index }}
      onPointerEnter={(event) => { if (hovering(event)) later(HOVER_OPEN_MS, true); }}
      onPointerLeave={(event) => { if (hovering(event)) later(HOVER_CLOSE_MS, false); }}
      onFocus={() => { clearTimeout(timerRef.current); onOpenChange(true); }}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) later(HOVER_CLOSE_MS, false);
      }}
    >
      <button
        type="button"
        className={`presence-person__button${actions.following === peer.user.id ? ' is-following' : ''}`}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-presence-dimmed={dimmed ? 'true' : undefined}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.pointerType !== 'touch') return;
          longPressedRef.current = false;
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            longPressedRef.current = true;
            onOpenChange(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => { if (!longPressedRef.current) clearTimeout(timerRef.current); }}
        onPointerCancel={() => clearTimeout(timerRef.current)}
        onClick={() => {
          if (longPressedRef.current) {
            longPressedRef.current = false;
            return;
          }
          clearTimeout(timerRef.current);
          onOpenChange(false);
          actions.jump(peer.user.id);
        }}
      >
        <PresenceAvatar user={peer.user} away={peer.away || dimmed} className="presence-stack__face" />
      </button>
      {open ? <PersonPreview peer={peer} actions={actions} dimmed={dimmed} /> : null}
    </div>
  );
}

function MoreList({ people, now, actions, onClose }: {
  people: readonly PresencePeer[];
  now: number;
  actions: StackActions;
  onClose(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="presence-more__popover" role="dialog" aria-label={t('presence.more.title')}>
      <strong className="presence-more__title">{t('presence.more.title')}</strong>
      <ul>
        {people.map((peer) => {
          const dimmed = peer.away || isPeerIdle(peer, now);
          const title = peer.page ? actions.pageTitle(peer.page) : undefined;
          return (
            <li key={peer.user.id}>
              <button
                type="button"
                className="presence-more__row"
                disabled={!peer.page}
                onClick={() => {
                  onClose();
                  actions.jump(peer.user.id);
                }}
              >
                <PresenceAvatar user={peer.user} size={28} away={dimmed} />
                <span className="presence-more__name">
                  <strong>{personName(t, peer, actions)}</strong>
                  <small>{pageLabel(t, peer, title)}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Faces of everyone working in this notebook, left of one's own account
 * button: a coloured ring in their presence colour, at most three then
 * "+N". Hovering (or long-pressing) a face shows a round preview of where
 * they are; clicking it takes you there; "Folgen" keeps you at their window.
 */
export function PresenceStack({ hub, pageDocId, pageTitle, loadContent, openPage }: {
  hub: PresenceHub | null;
  pageDocId: string | null;
  pageTitle(docId: string): string | undefined;
  /** The page with its ink for the preview; rejects when it cannot be read. */
  loadContent(docId: string): Promise<PreviewContent>;
  /** Shows another page of this notebook. */
  openPage(docId: string): void;
}) {
  const { t } = useI18n();
  usePresenceRoster(hub);
  const now = useNow(Math.min(IDLE_CHECK_MS, presenceIdleAfterMs() / 2));
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const following = useSyncExternalStore(
    hub ? hub.subscribeFollowing : noopSubscribe,
    hub ? hub.getFollowing : () => null,
    () => null,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useFollowDriver(hub, following, pageDocId, openPage);
  useDismiss(moreRef, moreOpen, () => setMoreOpen(false));

  const people = hub ? stackOrder(hub.getPeers(), pageDocId, now) : [];
  if (!hub || people.length === 0) return null;
  const { shown, more } = visibleAvatars(people, narrow ? MAX_VISIBLE_AVATARS_NARROW : MAX_VISIBLE_AVATARS);
  const rest = people.slice(shown.length);
  const followed = following ? people.find((peer) => peer.user.id === following) : undefined;
  const actions: StackActions = {
    hub,
    pageDocId,
    pageTitle,
    loadContent,
    following,
    selfId: hub.getUser().id,
    jump: (userId) => {
      setOpenId(null);
      jumpToPerson(hub, userId, pageDocId, openPage);
    },
  };

  return (
    <div className="presence-stack" role="group" aria-label={t('presence.stack.label')} data-presence-count={people.length}>
      {followed ? (
        <button type="button" className="presence-follow-chip" onClick={() => hub.follow(null)}>
          <span>
            {followed.user.id === actions.selfId
              ? t('presence.follow.bannerSelf')
              : t('presence.follow.banner', { name: followed.user.name.split(/\s+/u)[0] })}
          </span>
          <X size={13} aria-hidden="true" />
          <span className="sr-only">{t('presence.follow.stop')}</span>
        </button>
      ) : null}
      {shown.map((peer, index) => (
          <StackPerson
            key={peer.user.id}
            peer={peer}
            index={index}
            dimmed={peer.away || isPeerIdle(peer, now)}
            open={openId === peer.user.id}
            onOpenChange={(open) => setOpenId((current) => (open ? peer.user.id : current === peer.user.id ? null : current))}
            actions={actions}
          />
      ))}
      {more > 0 ? (
        <div ref={moreRef} className="presence-more">
          <button
            type="button"
            className="presence-stack__more"
            aria-expanded={moreOpen}
            aria-label={t('presence.stack.more', { count: more })}
            onClick={() => setMoreOpen((current) => !current)}
          >
            +{more}
          </button>
          {moreOpen ? (
            <MoreList people={rest} now={now} actions={actions} onClose={() => setMoreOpen(false)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
