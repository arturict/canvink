import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, LogIn, MonitorCheck, TriangleAlert, X } from 'lucide-react';
import { useOptionalAuth } from '../auth';
import { useI18n, type TranslationKey } from '../i18n';
import {
  PersonalSpaceHttpError,
  desktopCodeStatus,
  requestDesktopCode,
} from '../personal-space';
import { desktopDeepLink, parseDesktopLoginParams } from './desktopLoginParams';
import './desktopLogin.css';

/**
 * `/desktop-login` (PERSONAL-SYNC.md §3.7). Canvink Desktop opens this page in
 * the default browser. Clerk runs only here; after one confirming click the
 * page gets a one-time code for the app's PKCE challenge and hands it to the
 * app through `canvink://auth`. It then watches the code: once the app has
 * redeemed it the page says so, and "Code anzeigen" covers a blocked or
 * declined scheme prompt.
 */

type Phase =
  | { kind: 'confirm' }
  | { kind: 'issuing' }
  | { kind: 'handoff'; code: string; deepLink: string; showCode: boolean }
  | { kind: 'done' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: TranslationKey };

const STATUS_POLL_MS = 1_500;

function syncUrl(): string | undefined {
  return (import.meta.env.VITE_COLLAB_SYNC_URL as string | undefined) || undefined;
}

export default function DesktopLoginPage() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const [params] = useState(() => parseDesktopLoginParams(window.location.search));
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' });
  const [copied, setCopied] = useState(false);
  const signInOpened = useRef(false);
  const signedIn = auth.available && auth.isSignedIn;

  const app = params?.platform === 'android' ? 'Canvink Android' : 'Canvink Desktop';

  useEffect(() => {
    document.title = t('desktopLogin.title', { app });
  }, [t, app]);

  // Signed out: open Clerk's sign-in once, as a login page would.
  useEffect(() => {
    if (!params || !auth.available || auth.isSignedIn || signInOpened.current) return;
    signInOpened.current = true;
    auth.openSignIn();
  }, [auth, params]);

  const approve = useCallback(async () => {
    if (!params || !auth.available) return;
    const url = syncUrl();
    if (!url) {
      setPhase({ kind: 'error', message: 'desktopLogin.unavailable' });
      return;
    }
    setPhase({ kind: 'issuing' });
    try {
      const jwt = await auth.getToken();
      if (!jwt) throw new PersonalSpaceHttpError(401, 'unauthorized');
      const { code } = await requestDesktopCode({ syncUrl: url }, jwt, params.challenge);
      const deepLink = desktopDeepLink(code, params.state);
      setPhase({ kind: 'handoff', code, deepLink, showCode: false });
      window.location.assign(deepLink);
    } catch (error) {
      const tooMany = error instanceof PersonalSpaceHttpError && error.code === 'too-many-devices';
      setPhase({ kind: 'error', message: tooMany ? 'desktopLogin.tooManyDevices' : 'desktopLogin.failed' });
    }
  }, [auth, params]);

  // Hand-off: poll until the app has redeemed the code, or it expired.
  const handoffCode = phase.kind === 'handoff' ? phase.code : null;
  useEffect(() => {
    if (!handoffCode || !auth.available) return undefined;
    const url = syncUrl();
    if (!url) return undefined;
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const jwt = await auth.getToken();
          if (!jwt || stopped) return;
          const status = await desktopCodeStatus({ syncUrl: url }, jwt, handoffCode);
          if (stopped) return;
          if (status === 'used') setPhase({ kind: 'done' });
          else if (status === 'expired' || status === 'unknown') setPhase({ kind: 'expired' });
        } catch {
          // A failed poll is retried on the next tick.
        }
      })();
    }, STATUS_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [auth, handoffCode]);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // The code field stays selectable for a manual copy.
    }
  };

  const name = signedIn
    ? auth.user?.fullName?.trim() || auth.user?.primaryEmailAddress || null
    : null;

  let body;
  if (!params) {
    body = <p className="desktop-login__message" role="alert"><TriangleAlert size={18} aria-hidden="true" />{t('desktopLogin.invalid', { app })}</p>;
  } else if (!auth.available) {
    body = <p className="desktop-login__message" role="alert">{t('desktopLogin.unavailable')}</p>;
  } else if (!signedIn) {
    body = (
      <>
        <p className="desktop-login__message">{t('desktopLogin.signInFirst')}</p>
        <div className="desktop-login__actions">
          <button type="button" className="desktop-login__primary" onClick={() => auth.openSignIn()}>
            <LogIn size={16} aria-hidden="true" />
            {t('desktopLogin.signIn')}
          </button>
        </div>
      </>
    );
  } else if (phase.kind === 'confirm' || phase.kind === 'issuing') {
    body = (
      <>
        <p className="desktop-login__message">
          {name ? t('desktopLogin.confirmAs', { app, name }) : t('desktopLogin.confirm', { app })}
        </p>
        <div className="desktop-login__actions">
          <button
            type="button"
            className="desktop-login__primary"
            disabled={phase.kind === 'issuing'}
            onClick={() => void approve()}
          >
            <LogIn size={16} aria-hidden="true" />
            {t('desktopLogin.approve')}
          </button>
          <button type="button" onClick={() => setPhase({ kind: 'cancelled' })} disabled={phase.kind === 'issuing'}>
            {t('desktopLogin.cancel')}
          </button>
        </div>
      </>
    );
  } else if (phase.kind === 'handoff') {
    body = (
      <>
        <p className="desktop-login__message" role="status">{t('desktopLogin.opening', { app })}</p>
        <div className="desktop-login__actions">
          <a className="desktop-login__primary" href={phase.deepLink} data-testid="desktop-login-deep-link">
            {t('desktopLogin.openAgain')}
          </a>
          {!phase.showCode ? (
            <button type="button" onClick={() => setPhase({ ...phase, showCode: true })}>
              {t('desktopLogin.showCode')}
            </button>
          ) : null}
        </div>
        {phase.showCode ? (
          <div className="desktop-login__code">
            <label htmlFor="desktop-login-code">{t('desktopLogin.codeHint', { app })}</label>
            <div>
              <input
                id="desktop-login-code"
                readOnly
                value={phase.code}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" onClick={() => void copyCode(phase.code)}>
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied ? t('desktopLogin.copied') : t('desktopLogin.copy')}
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  } else if (phase.kind === 'done') {
    body = (
      <p className="desktop-login__message desktop-login__message--done" role="status">
        <MonitorCheck size={28} aria-hidden="true" />
        {t('desktopLogin.done', { app })}
      </p>
    );
  } else if (phase.kind === 'expired') {
    body = <p className="desktop-login__message" role="alert">{t('desktopLogin.expired', { app })}</p>;
  } else if (phase.kind === 'cancelled') {
    body = <p className="desktop-login__message" role="status"><X size={18} aria-hidden="true" />{t('desktopLogin.cancelled')}</p>;
  } else {
    body = (
      <>
        <p className="desktop-login__message" role="alert">{t(phase.message)}</p>
        <div className="desktop-login__actions">
          <button type="button" className="desktop-login__primary" onClick={() => setPhase({ kind: 'confirm' })}>
            {t('desktopLogin.retry')}
          </button>
        </div>
      </>
    );
  }

  return (
    <main className="desktop-login">
      <section className="desktop-login__card" aria-labelledby="desktop-login-title">
        <span className="brand-mark" aria-hidden="true">C</span>
        <h1 id="desktop-login-title">{t('desktopLogin.title', { app })}</h1>
        {body}
      </section>
    </main>
  );
}
