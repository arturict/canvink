/** Profil: picture, name and e-mail addresses. In the desktop and Android apps (no Clerk) it is read-only. */

import { useRef, useState, type FormEvent } from 'react';
import { Check, ImageUp, Plus, Trash2, UserRoundCheck } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { AccountApi, AccountProfile } from '../../auth';
import { presenceColorFor, safeAvatarUrl } from '../../collab/presence';
import { PresenceAvatar } from '../collab/presence/PresenceAvatars';
import { AccountWebLink } from './accountWebLink';
import { useAccountProfile, type Confirm, type SignedInAuth } from './accountShared';

export default function AccountProfileTab({ auth, confirm }: { auth: SignedInAuth; confirm: Confirm }) {
  const { t } = useI18n();
  const account = auth.account;
  if (!account) {
    return (
      <div className="account-dialog__section">
        <h3>{t('account.profile.name')}</h3>
        <p className="account-dialog__value">{auth.user?.fullName ?? ''}</p>
        <p className="account-dialog__value account-dialog__value--soft">{auth.user?.primaryEmailAddress ?? ''}</p>
        <p className="account-dialog__hint">{t('account.appOnly')}</p>
        <AccountWebLink />
      </div>
    );
  }
  return <ProfileForms account={account} auth={auth} confirm={confirm} />;
}

function ProfileForms({ account, auth, confirm }: { account: AccountApi; auth: SignedInAuth; confirm: Confirm }) {
  const { t } = useI18n();
  const { state, reload } = useAccountProfile(account);
  if (state.status === 'loading') return <p className="account-dialog__hint" role="status">{t('account.loading')}</p>;
  if (state.status === 'failed') return <p className="account-dialog__error" role="alert">{t('account.loadFailed')}</p>;
  return (
    <>
      <PictureSection account={account} profile={state.profile} userId={auth.user?.id ?? ''} onChanged={reload} />
      <NameSection account={account} profile={state.profile} onChanged={reload} />
      <EmailSection account={account} profile={state.profile} confirm={confirm} onChanged={reload} />
    </>
  );
}

function PictureSection({
  account,
  profile,
  userId,
  onChanged,
}: {
  account: AccountApi;
  profile: AccountProfile;
  userId: string;
  onChanged(): Promise<void>;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = `${profile.firstName} ${profile.lastName}`.trim() || '?';
  const imageUrl = safeAvatarUrl(profile.avatarUrl ?? undefined);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
      await onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="account-dialog__section" aria-labelledby="account-picture-title">
      <h3 id="account-picture-title">{t('account.profile.picture')}</h3>
      <div className="account-dialog__picture">
        <PresenceAvatar user={{ name, color: presenceColorFor(userId || 'account'), ...(imageUrl ? { imageUrl } : {}) }} size={72} />
        <div className="account-dialog__chips" role="group" aria-label={t('account.profile.picture')}>
          {(['google', 'github'] as const).map((provider) =>
            profile.providerImages[provider] ? (
              <button key={provider} type="button" disabled={busy} onClick={() => void run(() => account.chooseAvatar(provider))}>
                <img src={profile.providerImages[provider]} alt="" width={18} height={18} referrerPolicy="no-referrer" />
                {t(provider === 'google' ? 'account.avatar.google' : 'account.avatar.github')}
              </button>
            ) : null,
          )}
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImageUp size={16} aria-hidden="true" />
            {t('account.avatar.upload')}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-pressed={profile.prefersInitials || profile.avatarUrl === null}
            onClick={() => void run(() => account.chooseAvatar('initials'))}
          >
            {t('account.avatar.initials')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void run(() => account.uploadAvatar(file));
            }}
          />
        </div>
      </div>
      <p className="account-dialog__hint">{t('account.profile.pictureHint')}</p>
      {failed ? <p className="account-dialog__error" role="alert">{t('account.avatar.failed')}</p> : null}
    </section>
  );
}

function NameSection({
  account,
  profile,
  onChanged,
}: {
  account: AccountApi;
  profile: AccountProfile;
  onChanged(): Promise<void>;
}) {
  const { t } = useI18n();
  const [first, setFirst] = useState(profile.firstName);
  const [last, setLast] = useState(profile.lastName);
  const [message, setMessage] = useState<'saved' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = first.trim() !== profile.firstName || last.trim() !== profile.lastName;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await account.updateName(first.trim(), last.trim());
      setMessage('saved');
      await onChanged();
    } catch {
      setMessage('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="account-dialog__section" onSubmit={(event) => void submit(event)} aria-labelledby="account-name-title">
      <h3 id="account-name-title">{t('account.profile.name')}</h3>
      <div className="account-dialog__fields">
        <label>
          <span>{t('account.profile.firstName')}</span>
          <input value={first} autoComplete="given-name" onChange={(event) => { setFirst(event.target.value); setMessage(null); }} />
        </label>
        <label>
          <span>{t('account.profile.lastName')}</span>
          <input value={last} autoComplete="family-name" onChange={(event) => { setLast(event.target.value); setMessage(null); }} />
        </label>
      </div>
      <div className="account-dialog__row-actions">
        <button type="submit" className="account-dialog__primary" disabled={!dirty || busy}>{t('account.profile.save')}</button>
        {message === 'saved' ? <span className="account-dialog__ok" role="status"><Check size={14} aria-hidden="true" />{t('account.profile.saved')}</span> : null}
        {message === 'failed' ? <span className="account-dialog__error" role="alert">{t('account.profile.saveFailed')}</span> : null}
      </div>
    </form>
  );
}

type AddState = { step: 'closed' } | { step: 'entering' } | { step: 'verifying'; id: string; address: string };

function EmailSection({
  account,
  profile,
  confirm,
  onChanged,
}: {
  account: AccountApi;
  profile: AccountProfile;
  confirm: Confirm;
  onChanged(): Promise<void>;
}) {
  const { t } = useI18n();
  const [add, setAdd] = useState<AddState>({ step: 'closed' });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
      await onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="account-dialog__section" aria-labelledby="account-email-title">
      <h3 id="account-email-title">{t('account.email.title')}</h3>
      <ul className="account-dialog__list">
        {profile.emails.map((email) => (
          <li key={email.id}>
            <span className="account-dialog__list-main">
              <strong>{email.address}</strong>
              <small>
                {email.primary ? <span className="account-dialog__badge">{t('account.email.primary')}</span> : null}
                {email.verified ? null : <span className="account-dialog__badge account-dialog__badge--warn">{t('account.email.unverified')}</span>}
              </small>
            </span>
            {!email.primary && email.verified ? (
              <button
                type="button"
                disabled={busy}
                aria-label={t('account.email.makePrimaryLabel', { address: email.address })}
                onClick={() => void run(() => account.makePrimaryEmail(email.id))}
              >
                <UserRoundCheck size={15} aria-hidden="true" />
                {t('account.email.makePrimary')}
              </button>
            ) : null}
            {!email.primary ? (
              <button
                type="button"
                disabled={busy}
                aria-label={t('account.email.removeLabel', { address: email.address })}
                onClick={() => void (async () => {
                  const ok = await confirm({
                    title: t('account.email.removeTitle', { address: email.address }),
                    message: t('account.email.removeMessage'),
                    confirmLabel: t('account.email.remove'),
                    danger: true,
                  });
                  if (ok) await run(() => account.removeEmail(email.id));
                })()}
              >
                <Trash2 size={15} aria-hidden="true" />
                {t('account.email.remove')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {add.step === 'closed' ? (
        <button type="button" className="account-dialog__link" onClick={() => { setAdd({ step: 'entering' }); setFailed(false); }}>
          <Plus size={15} aria-hidden="true" />
          {t('account.email.add')}
        </button>
      ) : null}
      {add.step === 'entering' ? (
        <form
          className="account-dialog__inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const id = await account.addEmail(address.trim());
              setAdd({ step: 'verifying', id, address: address.trim() });
              setCode('');
            });
          }}
        >
          <label>
            <span>{t('account.email.address')}</span>
            <input type="email" required autoFocus autoComplete="email" value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
          <button type="submit" className="account-dialog__primary" disabled={busy || !address.trim()}>{t('account.email.sendCode')}</button>
          <button type="button" onClick={() => setAdd({ step: 'closed' })}>{t('common.cancel')}</button>
        </form>
      ) : null}
      {add.step === 'verifying' ? (
        <form
          className="account-dialog__inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const { id } = add;
            void run(async () => {
              await account.verifyEmail(id, code.trim());
              setAdd({ step: 'closed' });
              setAddress('');
            });
          }}
        >
          <p className="account-dialog__hint">{t('account.email.codeHint', { address: add.address })}</p>
          <label>
            <span>{t('account.email.code')}</span>
            <input inputMode="numeric" autoComplete="one-time-code" required autoFocus value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
          <button type="submit" className="account-dialog__primary" disabled={busy || !code.trim()}>{t('account.email.verify')}</button>
          <button type="button" disabled={busy} onClick={() => void run(() => account.resendEmailCode(add.id))}>{t('account.email.resend')}</button>
          <button type="button" onClick={() => setAdd({ step: 'closed' })}>{t('common.cancel')}</button>
        </form>
      ) : null}
      {failed ? <p className="account-dialog__error" role="alert">{t('account.email.failed')}</p> : null}
    </section>
  );
}
