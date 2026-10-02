/** Anmeldung: connected Google and GitHub accounts, Clerk's password and two-step pages, and sign-out of other browsers. */

import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { AccountApi, AccountConnection, AccountProfile } from '../../auth';
import { useAccountProfile, type Confirm, type SignedInAuth } from './accountShared';

function ProviderGlyph({ provider }: { provider: string }) {
  if (provider === 'github') {
    return (
      <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  return <span className="account-dialog__glyph" aria-hidden="true">{provider === 'google' ? 'G' : provider.slice(0, 1).toUpperCase()}</span>;
}

export default function AccountSignInTab({ auth, confirm }: { auth: SignedInAuth; confirm: Confirm }) {
  const { t } = useI18n();
  const account = auth.account;
  if (!account) return null;
  return <SignInSections account={account} confirm={confirm} t={t} />;
}

function SignInSections({ account, confirm, t }: { account: AccountApi; confirm: Confirm; t: ReturnType<typeof useI18n>['t'] }) {
  const { state, reload } = useAccountProfile(account);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [othersDone, setOthersDone] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
      await reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return <p className="account-dialog__hint" role="status">{t('account.loading')}</p>;
  if (state.status === 'failed') return <p className="account-dialog__error" role="alert">{t('account.loadFailed')}</p>;
  const profile: AccountProfile = state.profile;
  const providerTitle = (provider: string) => (provider === 'github' ? t('account.avatar.github') : provider === 'google' ? t('account.avatar.google') : provider);

  const disconnect = async (connection: AccountConnection) => {
    const name = connection.title || providerTitle(connection.provider);
    const ok = await confirm({
      title: t('account.signin.disconnectTitle', { provider: name }),
      message: t('account.signin.disconnectMessage', { provider: name }),
      confirmLabel: t('account.signin.disconnect'),
      danger: true,
    });
    if (ok) await run(() => account.disconnect(connection.id));
  };

  return (
    <>
      <section className="account-dialog__section" aria-labelledby="account-connected-title">
        <h3 id="account-connected-title">{t('account.signin.connected')}</h3>
        <p className="account-dialog__hint">{t('account.signin.connectedHint')}</p>
        <ul className="account-dialog__list">
          {profile.connections.map((connection) => {
            const name = connection.title || providerTitle(connection.provider);
            return (
              <li key={connection.id}>
                <ProviderGlyph provider={connection.provider} />
                <span className="account-dialog__list-main">
                  <strong>{name}</strong>
                  <small>{connection.identifier}</small>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t('account.signin.disconnectLabel', { provider: name })}
                  onClick={() => void disconnect(connection)}
                >
                  {t('account.signin.disconnect')}
                </button>
              </li>
            );
          })}
          {profile.connectable.map((provider) => (
            <li key={provider}>
              <ProviderGlyph provider={provider} />
              <span className="account-dialog__list-main">
                <strong>{providerTitle(provider)}</strong>
                <small>{t('account.signin.notConnected')}</small>
              </span>
              <button
                type="button"
                className="account-dialog__primary"
                disabled={busy}
                aria-label={t('account.signin.connectLabel', { provider: providerTitle(provider) })}
                onClick={() => void run(() => account.connect(provider))}
              >
                {t('account.signin.connect')}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="account-dialog__section" aria-labelledby="account-security-title">
        <h3 id="account-security-title">{t('account.signin.security')}</h3>
        <SecurityMount account={account} />
      </section>
      <section className="account-dialog__section" aria-labelledby="account-others-title">
        <h3 id="account-others-title">{t('account.signin.others')}</h3>
        <p className="account-dialog__hint">{t('account.signin.othersHint')}</p>
        <div className="account-dialog__row-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void (async () => {
              const ok = await confirm({
                title: t('account.signin.othersTitle'),
                message: t('account.signin.othersMessage'),
                confirmLabel: t('account.signin.others'),
                danger: true,
              });
              if (!ok) return;
              await run(async () => {
                await account.signOutOtherSessions();
                setOthersDone(true);
              });
            })()}
          >
            <LogOut size={15} aria-hidden="true" />
            {t('account.signin.others')}
          </button>
          {othersDone ? <span className="account-dialog__ok" role="status">{t('account.signin.othersDone')}</span> : null}
        </div>
      </section>
      {failed ? <p className="account-dialog__error" role="alert">{t('account.signin.failed')}</p> : null}
    </>
  );
}

/** Clerk's own password and two-step pages, styled by `clerkProfileAppearance`. */
function SecurityMount({ account }: { account: AccountApi }) {
  const nodeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = nodeRef.current;
    return node ? account.mountSecurity(node) : undefined;
  }, [account]);
  return <div ref={nodeRef} className="account-dialog__clerk" data-testid="account-security-mount" />;
}
