import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, Copy, Globe, Link2, Lock, Mail, RefreshCw, UserPlus, X } from 'lucide-react';
import { CollabHttpError, presenceColorFor, safeAvatarUrl, type MemberRole, type RoomInvite, type RoomMember } from '../../collab';
import { useI18n, type TranslationKey } from '../../i18n';
import { useConfirm } from '../../ui/ConfirmDialog';
import { PresenceAvatar } from './presence/PresenceAvatars';
import type { CollabGateway, SharingView } from './collabGateway';

export interface ShareNotebookDialogProps {
  gateway: CollabGateway | null;
  notebookId: string;
  notebookTitle: string;
  onClose(): void;
}

type DialogPhase =
  /** The notebook has no room yet: nothing is uploaded before the person starts sharing. */
  | { kind: 'unshared' }
  | { kind: 'loading' }
  | { kind: 'ready'; view: SharingView }
  | { kind: 'error'; reason: 'load' | 'forbidden' }
  | { kind: 'ended' };

const ROLE_OPTIONS: readonly MemberRole[] = ['viewer', 'editor', 'admin'];
const ROLE_LABEL: Record<MemberRole, TranslationKey> = {
  viewer: 'collab.role.viewer',
  editor: 'collab.role.editor',
  admin: 'collab.role.admin',
};

/** A plausible address: the Worker validates properly, this only catches typos before the request. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function displayName(member: Pick<RoomMember, 'name' | 'email'>, fallback: string): string {
  return member.name || member.email || fallback;
}

function Person({ name, picture, id }: { name: string; picture?: string; id: string }) {
  const imageUrl = safeAvatarUrl(picture);
  return <PresenceAvatar user={{ name, color: presenceColorFor(id), ...(imageUrl ? { imageUrl } : {}) }} size={32} />;
}

/**
 * Share dialog in the manner of Google Docs and OneNote: invite a person by e-mail address with a
 * role, see and change who has access, and decide what everybody with the link may do (read, never
 * more). The room enforces every rule; this dialog only asks for them.
 */
export default function ShareNotebookDialog({ gateway, notebookId, notebookTitle, onClose }: ShareNotebookDialogProps) {
  const { t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  const [phase, setPhase] = useState<DialogPhase>(() => (gateway?.isShared(notebookId) ? { kind: 'loading' } : { kind: 'unshared' }));
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState<'link' | `invite:${string}` | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!gateway) return;
    try {
      const view = await gateway.loadSharing(notebookId);
      if (aliveRef.current) setPhase({ kind: 'ready', view });
    } catch (error) {
      if (!aliveRef.current) return;
      setPhase({ kind: 'error', reason: error instanceof CollabHttpError && error.status === 403 ? 'forbidden' : 'load' });
    }
  }, [gateway, notebookId]);

  useEffect(() => {
    if (!gateway?.isShared(notebookId)) return;
    let cancelled = false;
    gateway.loadSharing(notebookId).then(
      (view) => { if (!cancelled) setPhase({ kind: 'ready', view }); },
      (error: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', reason: error instanceof CollabHttpError && error.status === 403 ? 'forbidden' : 'load' });
      },
    );
    return () => { cancelled = true; };
  }, [gateway, notebookId]);

  useEffect(() => {
    if (phase.kind === 'ready') emailRef.current?.focus({ preventScroll: true });
  }, [phase.kind]);

  /** Runs one change, then shows the room's state again; a failure is shown instead of swallowed. */
  const act = async (action: () => Promise<void>, failure: TranslationKey, success?: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await load();
      if (aliveRef.current && success) setMessage({ kind: 'info', text: success });
      return true;
    } catch (error) {
      if (aliveRef.current) {
        const code = error instanceof CollabHttpError ? error.code : '';
        const known: Record<string, TranslationKey> = {
          'invalid-email': 'collab.share.invite.invalid',
          'already-member': 'collab.share.invite.alreadyMember',
          'is-owner': 'collab.share.invite.isOwner',
          'too-many-invites': 'collab.share.invite.tooMany',
        };
        setMessage({ kind: 'error', text: t(known[code] ?? failure) });
      }
      return false;
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const startSharing = async (): Promise<void> => {
    if (!gateway) return;
    setPhase({ kind: 'loading' });
    try {
      await gateway.createRoomForNotebook(notebookId);
      await load();
    } catch {
      if (aliveRef.current) setPhase({ kind: 'error', reason: 'load' });
    }
  };

  const submitInvite = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!gateway || busy) return;
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setMessage({ kind: 'error', text: t('collab.share.invite.invalid') });
      emailRef.current?.focus();
      return;
    }
    const done = await act(
      () => gateway.invite(notebookId, address, role),
      'collab.share.invite.error',
      t('collab.share.invite.sent', { email: address.toLowerCase() }),
    );
    if (done && aliveRef.current) {
      setEmail('');
      emailRef.current?.focus();
    }
  };

  const changeMember = async (member: RoomMember, next: MemberRole | 'remove', ownerView: boolean): Promise<void> => {
    if (!gateway || busy) return;
    const name = displayName(member, t('collab.share.member.unknown'));
    if (next === 'remove') {
      const yes = await confirm({
        title: t('collab.share.remove.title', { name }),
        message: t('collab.share.remove.message', { name, title: notebookTitle }),
        confirmLabel: t('collab.role.remove'),
        danger: true,
      });
      if (!yes) return;
      await act(() => gateway.removeMember(notebookId, member.sub), 'collab.share.remove.error');
      return;
    }
    if (next === member.role) return;
    // An admin who takes their own admin role away cannot undo it: ask first.
    if (member.sub === (phase.kind === 'ready' ? phase.view.sharing.you.sub : undefined) && !ownerView) {
      const yes = await confirm({
        title: t('collab.share.demoteSelf.title'),
        message: t('collab.share.demoteSelf.message'),
        confirmLabel: t('collab.share.demoteSelf.action'),
        danger: true,
      });
      if (!yes) return;
    }
    await act(() => gateway.changeRole(notebookId, member.sub, next), 'collab.share.role.error');
  };

  const changeInvite = async (invite: RoomInvite, next: MemberRole | 'revoke'): Promise<void> => {
    if (!gateway || busy) return;
    if (next === 'revoke') {
      await act(() => gateway.revokeInvite(notebookId, invite.email), 'collab.share.invite.revokeError');
      return;
    }
    if (next === invite.role) return;
    await act(() => gateway.invite(notebookId, invite.email, next), 'collab.share.role.error');
  };

  const setLink = async (enabled: boolean): Promise<void> => {
    if (!gateway || busy || phase.kind !== 'ready') return;
    if (!enabled) {
      const yes = await confirm({
        title: t('collab.share.linkOff.title'),
        message: t('collab.share.linkOff.message'),
        confirmLabel: t('collab.share.linkOff.action'),
        danger: true,
      });
      if (!yes) return;
    }
    await act(() => gateway.setLinkEnabled(notebookId, enabled), 'collab.share.link.error');
  };

  const regenerate = async (): Promise<void> => {
    if (!gateway || busy) return;
    const yes = await confirm({
      title: t('collab.share.regenerate.title'),
      message: t('collab.share.regenerate.message'),
      confirmLabel: t('collab.share.regenerate.action'),
      danger: true,
    });
    if (!yes) return;
    setCopied(null);
    await act(() => gateway.regenerateLink(notebookId), 'collab.share.link.error');
  };

  const copy = (text: string, which: 'link' | `invite:${string}`): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(which);
        setMessage(null);
      },
      () => setMessage({ kind: 'error', text: t('collab.share.copyError') }),
    );
  };

  const endShare = async (): Promise<void> => {
    if (!gateway || busy) return;
    const yes = await confirm({
      title: t('collab.share.endShare'),
      message: t('collab.share.endShare.message', { title: notebookTitle }),
      confirmLabel: t('collab.share.endShare'),
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      await gateway.unshareNotebook(notebookId);
      if (aliveRef.current) setPhase({ kind: 'ended' });
    } catch {
      if (aliveRef.current) setMessage({ kind: 'error', text: t('collab.share.unshareError') });
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const view = phase.kind === 'ready' ? phase.view : null;
  const sharing = view?.sharing;
  const isOwner = sharing?.you.role === 'owner';
  const people = sharing?.members ?? [];
  const invites = sharing?.invites ?? [];
  const linkOn = Boolean(sharing?.link.enabled);
  // Until the signed-in owner has told the room who they are, the owner is "Du" on their own device.
  const ownerName = sharing?.owner.name ?? (isOwner ? t('collab.share.member.you') : t('collab.role.owner'));

  return (
    <div className="recovery-overlay" role="presentation">
      <section
        className="recovery-card collab-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-share-title"
        onKeyDown={onKeyDown}
      >
        <button type="button" className="recovery-card__close" aria-label={t('collab.share.close')} onClick={onClose}>
          <X size={16} />
        </button>
        <Link2 size={24} aria-hidden="true" />
        <h2 id="collab-share-title">{t('collab.share.title')}</h2>
        <p className="collab-share-dialog__notebook">{notebookTitle}</p>

        {!gateway ? (
          <p className="collab-share-dialog__error" role="alert">{t('collab.share.unavailable')}</p>
        ) : null}

        {gateway && phase.kind === 'unshared' ? (
          <>
            <div className="collab-share-dialog__body">
              <p>{t('collab.share.explain')}</p>
              <p className="collab-share-dialog__plaintext-notice">{t('collab.share.plaintextNotice')}</p>
            </div>
            <div className="collab-share-dialog__actions">
              <button type="button" onClick={() => void startSharing()}>{t('collab.share.start')}</button>
            </div>
          </>
        ) : null}

        {gateway && phase.kind === 'loading' ? (
          <p className="collab-share-dialog__hint" role="status">{t('collab.share.loading')}</p>
        ) : null}

        {gateway && phase.kind === 'error' ? (
          <>
            <p className="collab-share-dialog__error" role="alert">
              {t(phase.reason === 'forbidden' ? 'collab.share.forbidden' : 'collab.share.loadError')}
            </p>
            {phase.reason === 'load' ? (
              <div className="collab-share-dialog__actions">
                <button type="button" onClick={() => { setPhase({ kind: 'loading' }); void load(); }}>{t('collab.share.retry')}</button>
              </div>
            ) : null}
          </>
        ) : null}

        {phase.kind === 'ended' ? (
          <p className="collab-share-dialog__hint" role="status">{t('collab.share.ended')}</p>
        ) : null}

        {gateway && view && sharing ? (
          <div className="share-dialog__content" aria-busy={busy}>
            <form className="share-invite" onSubmit={(event) => void submitInvite(event)} noValidate>
              <label className="share-invite__email">
                <span className="share-section__label">{t('collab.share.invite.label')}</span>
                <span className="share-invite__row">
                  <input
                    ref={emailRef}
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    value={email}
                    placeholder={t('collab.share.invite.placeholder')}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <select
                    aria-label={t('collab.share.invite.role')}
                    value={role}
                    onChange={(event) => setRole(event.target.value as MemberRole)}
                  >
                    {ROLE_OPTIONS.map((option) => <option key={option} value={option}>{t(ROLE_LABEL[option])}</option>)}
                  </select>
                  <button type="submit" disabled={busy || email.trim() === ''}>
                    <UserPlus size={15} aria-hidden="true" /> {t('collab.share.invite.submit')}
                  </button>
                </span>
              </label>
              <p className="collab-share-dialog__hint">{t('collab.share.invite.hint')}</p>
            </form>

            {message ? (
              <p
                className={message.kind === 'error' ? 'collab-share-dialog__error' : 'collab-share-dialog__hint share-message'}
                role={message.kind === 'error' ? 'alert' : 'status'}
              >
                {message.text}
              </p>
            ) : null}

            <h3 className="share-section__label share-section__heading">{t('collab.share.people')}</h3>
            <ul className="share-people" aria-label={t('collab.share.people')}>
              <li className="share-person" data-share-owner="true">
                <Person name={ownerName} picture={sharing.owner.picture} id="owner" />
                <span className="share-person__text">
                  <strong>{ownerName}</strong>
                  {sharing.owner.email ? <small>{sharing.owner.email}</small> : null}
                </span>
                <span className="share-person__fixed">{t('collab.role.owner')}</span>
              </li>
              {people.map((member) => {
                const name = displayName(member, t('collab.share.member.unknown'));
                const mine = member.sub === sharing.you.sub;
                return (
                  <li className="share-person" key={member.sub} data-share-member={member.email ?? member.sub}>
                    <Person name={name} picture={member.picture} id={member.sub} />
                    <span className="share-person__text">
                      <strong>{name}{mine ? ` (${t('collab.share.member.you')})` : ''}</strong>
                      {member.email && member.name ? <small>{member.email}</small> : null}
                      {member.via === 'link' ? <small>{t('collab.share.member.viaLink')}</small> : null}
                    </span>
                    <select
                      aria-label={t('collab.share.member.roleOf', { name })}
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => void changeMember(member, event.target.value as MemberRole | 'remove', Boolean(isOwner))}
                    >
                      {ROLE_OPTIONS.map((option) => <option key={option} value={option}>{t(ROLE_LABEL[option])}</option>)}
                      <option value="remove">{t('collab.role.remove')}</option>
                    </select>
                  </li>
                );
              })}
            </ul>

            {invites.length > 0 ? (
              <>
                <h3 className="share-section__label share-section__heading">{t('collab.share.pending')}</h3>
                <ul className="share-people" aria-label={t('collab.share.pending')}>
                  {invites.map((invite) => (
                    <li className="share-person share-person--pending" key={invite.email} data-share-invite={invite.email}>
                      <span className="share-person__mail" aria-hidden="true"><Mail size={16} /></span>
                      <span className="share-person__text">
                        <strong>{invite.email}</strong>
                        <small>
                          {invite.invitedByName
                            ? t('collab.share.pending.by', { name: invite.invitedByName })
                            : t('collab.share.pending.hint')}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="share-person__copy"
                        title={t('collab.share.pending.copyHint')}
                        onClick={() => copy(view.inviteUrl, `invite:${invite.email}`)}
                      >
                        {copied === `invite:${invite.email}` ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                        {copied === `invite:${invite.email}` ? t('collab.share.linkCopied') : t('collab.share.pending.copy')}
                      </button>
                      <select
                        aria-label={t('collab.share.member.roleOf', { name: invite.email })}
                        value={invite.role}
                        disabled={busy}
                        onChange={(event) => void changeInvite(invite, event.target.value as MemberRole | 'revoke')}
                      >
                        {ROLE_OPTIONS.map((option) => <option key={option} value={option}>{t(ROLE_LABEL[option])}</option>)}
                        <option value="revoke">{t('collab.share.pending.revoke')}</option>
                      </select>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3 className="share-section__label share-section__heading">{t('collab.share.general')}</h3>
            <div className="share-general">
              <span className="share-general__icon" aria-hidden="true">{linkOn ? <Globe size={18} /> : <Lock size={18} />}</span>
              <span className="share-general__text">
                <select
                  aria-label={t('collab.share.general')}
                  value={linkOn ? 'link' : 'restricted'}
                  disabled={busy}
                  onChange={(event) => void setLink(event.target.value === 'link')}
                >
                  <option value="restricted">{t('collab.share.general.restricted')}</option>
                  <option value="link">{t('collab.share.general.link')}</option>
                </select>
                <small>{t(linkOn ? 'collab.share.general.linkHint' : 'collab.share.general.restrictedHint')}</small>
              </span>
            </div>
            {linkOn && view.shareUrl ? (
              <div className="collab-share-dialog__link">
                <label htmlFor="collab-share-url">{t('collab.share.linkLabel')}</label>
                <div className="collab-share-dialog__link-row">
                  <input id="collab-share-url" type="text" readOnly value={view.shareUrl} onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" onClick={() => copy(view.shareUrl ?? '', 'link')}>
                    {copied === 'link' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                    {copied === 'link' ? t('collab.share.linkCopied') : t('collab.share.copyLink')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void regenerate()}>
                    <RefreshCw size={15} aria-hidden="true" /> {t('collab.share.regenerate')}
                  </button>
                </div>
              </div>
            ) : null}

            {isOwner ? (
              <div className="collab-share-dialog__actions share-dialog__end">
                <button type="button" className="share-dialog__end-button" disabled={busy} onClick={() => void endShare()}>
                  {t('collab.share.endShare')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {confirmElement}
      </section>
    </div>
  );
}
