/**
 * Canvink Desktop, while its browser sign-in is open (PERSONAL-SYNC.md §3.7):
 * says the app is waiting, reopens the browser, takes a pasted code when the
 * `canvink://` hand-off was blocked, and cancels.
 */

import { useState, type FormEvent } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type { OptionalAuthValue } from '../../auth';

const ERROR_KEYS: Record<'failed' | 'expired' | 'browserFailed', TranslationKey> = {
  failed: 'desktop.login.failed',
  expired: 'desktop.login.expired',
  browserFailed: 'desktop.login.browserFailed',
};

/** Pure: open while waiting for the browser, or to explain why signing in stopped. */
export function desktopLoginDialogVisible(auth: OptionalAuthValue): boolean {
  if (!auth.available || !auth.desktop) return false;
  return auth.desktop.pending || (auth.desktop.error !== null && !auth.isSignedIn);
}

export default function DesktopLoginDialog({ auth }: { auth: OptionalAuthValue }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  if (!desktopLoginDialogVisible(auth) || !auth.available || !auth.desktop) return null;
  const desktop = auth.desktop;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    const accepted = await desktop.submitCode(code.trim());
    setBusy(false);
    setRejected(!accepted);
    if (accepted) setCode('');
  };

  const message = desktop.error && !desktop.pending ? t(ERROR_KEYS[desktop.error]) : t('desktop.login.waiting');

  return (
    <div className="recovery-overlay" role="presentation">
      <section className="desktop-login-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-login-dialog-title">
        <button type="button" className="desktop-login-dialog__close" aria-label={t('desktop.login.cancel')} onClick={desktop.cancel}>
          <X size={16} aria-hidden="true" />
        </button>
        <h2 id="desktop-login-dialog-title">{t('desktop.login.title')}</h2>
        <p role="status">{message}</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="desktop-login-dialog-code">{t('desktop.login.codeLabel')}</label>
          <div>
            <input
              id="desktop-login-dialog-code"
              value={code}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={rejected}
              onChange={(event) => {
                setCode(event.target.value);
                setRejected(false);
              }}
            />
            <button type="submit" disabled={busy || !code.trim()}>{t('desktop.login.submit')}</button>
          </div>
          {rejected ? <p className="desktop-login-dialog__error" role="alert">{t('desktop.login.failed')}</p> : null}
        </form>
        <div className="desktop-login-dialog__actions">
          <button type="button" onClick={desktop.reopenBrowser}>
            <ExternalLink size={15} aria-hidden="true" />
            {t('desktop.login.reopen')}
          </button>
          <button type="button" onClick={desktop.cancel}>{t('desktop.login.cancel')}</button>
        </div>
      </section>
    </div>
  );
}
