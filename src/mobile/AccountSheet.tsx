import { useEffect, useState, type FormEvent } from 'react';
import { CloudUpload, Download, ExternalLink, Languages, LogIn, LogOut, RefreshCw, Smartphone, Trash2, UserRound } from 'lucide-react';
import { useI18n, type TranslationKey } from '../i18n';
import { SUPPORTED_LANGUAGES } from '../i18n/core';
import { accountMenuViewModel } from '../components/personal-space/AccountMenu';
import { desktopLoginDialogVisible } from '../components/personal-space/DesktopLoginDialog';
import { linkDialogOptions } from '../components/personal-space/SpaceLinkDialog';
import { useKeepLocalChoice } from '../components/personal-space/useKeepLocalChoice';
import { useConfirm } from '../ui/ConfirmDialog';
import { checkAndroidUpdate, openAndroidUpdate, ANDROID_UPDATE_CHECK_INTERVAL_MS, type AndroidUpdateInfo } from '../platform/androidUpdate';
import { isDesktopApp } from '../platform/desktopUpdater';
import { Sheet, SheetAction } from './ui';
import { SyncLine } from './SyncLine';
import type { MobileWorkspace } from './useMobileWorkspace';

/** A newer APK, looked up at start and then every few hours (the app is not in a store). */
export function useAndroidUpdate(): AndroidUpdateInfo | null {
  const [update, setUpdate] = useState<AndroidUpdateInfo | null>(null);
  useEffect(() => {
    if (!isDesktopApp()) return undefined;
    let active = true;
    const look = () => void checkAndroidUpdate().then((found) => {
      if (active && found) setUpdate(found);
    });
    const first = window.setTimeout(look, 4_000);
    const timer = window.setInterval(look, ANDROID_UPDATE_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  return update;
}

/**
 * The account: who is signed in, where the notes are (sync status, a sync
 * now), the app's update, the language, signing out. Signed out, it explains
 * what an account adds and starts the browser sign-in.
 */
export function AccountSheet({
  ws,
  open,
  onClose,
  now,
  update,
}: {
  ws: MobileWorkspace;
  open: boolean;
  onClose: () => void;
  now: Date;
  update: AndroidUpdateInfo | null;
}) {
  const { t, language, setLanguage } = useI18n();
  const model = accountMenuViewModel(ws.auth);
  const choice = useKeepLocalChoice(ws.auth.available ? ws.auth.user?.id : undefined);
  const name = model.signedIn ? model.name ?? model.email ?? t('space.account.title') : null;
  return (
    <Sheet open={open} onClose={onClose} testId="mobile-account">
      <div className="m-account">
        <div className="m-account__avatar" aria-hidden="true">
          {model.signedIn && model.imageUrl ? <img src={model.imageUrl} alt="" referrerPolicy="no-referrer" /> : <UserRound size={28} />}
        </div>
        <div className="m-account__who">
          <strong>{model.signedIn ? name : t('space.status.signedOut')}</strong>
          {model.signedIn && model.email && model.email !== name ? <span>{model.email}</span> : null}
          <SyncLine ws={ws} now={now} />
        </div>
      </div>
      {!model.signedIn ? (
        <>
          <p className="m-sheet__meta">{t('space.account.desktopBenefit')}</p>
          {model.canSignIn ? (
            <SheetAction icon={<LogIn size={20} />} label={t('space.account.signInOrUp')} onClick={() => {
              onClose();
              if (ws.auth.available) ws.auth.openSignIn();
            }} />
          ) : (
            <p className="m-hint">{t('space.account.unavailable')}</p>
          )}
        </>
      ) : ws.spaceStatus.kind === 'link-required' ? (
        <SheetAction
          icon={<CloudUpload size={20} />}
          label={t('space.link.reconsider')}
          onClick={() => {
            choice.reconsider();
            onClose();
          }}
        />
      ) : (
        <SheetAction
          icon={<RefreshCw size={20} />}
          label={t('space.account.syncNow')}
          disabled={!ws.personalSpaceEnabled}
          onClick={() => {
            ws.personalSpace.syncNow();
            onClose();
          }}
        />
      )}
      {update ? (
        <SheetAction
          icon={<Download size={20} />}
          label={t('update.available')}
          hint={t('mobile.update.hint', { version: update.version })}
          onClick={() => void openAndroidUpdate()}
        />
      ) : null}
      <div className="m-sheet-action m-sheet-action--static">
        <span className="m-sheet-action__icon" aria-hidden="true"><Languages size={20} /></span>
        <span className="m-sheet-action__text"><span>{t('app.language.label')}</span></span>
        <div className="m-segmented" role="radiogroup" aria-label={t('app.language.label')}>
          {SUPPORTED_LANGUAGES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={language === option}
              className="m-ripple"
              onClick={() => setLanguage(option)}
            >
              {t(`app.language.${option}` as TranslationKey)}
            </button>
          ))}
        </div>
      </div>
      {model.signedIn && ws.auth.available && ws.auth.signOut ? (
        <SheetAction icon={<LogOut size={20} />} label={t('space.account.signOut')} danger onClick={() => {
          ws.personalSpace.signOut();
          if (ws.auth.available) void ws.auth.signOut?.();
          onClose();
        }} />
      ) : null}
      <p className="m-account__version">{t('mobile.account.version', { version: __CANVINK_VERSION__ })}</p>
    </Sheet>
  );
}

/**
 * The first sign-in on a phone that already holds its own notebooks while the
 * account has others. Nothing is replaced unasked: the phone's notebooks join
 * the account, stay only on the phone, or (after a confirmation) are
 * discarded for the account's.
 */
export function LinkSheet({ ws }: { ws: MobileWorkspace }) {
  const { t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  const choice = useKeepLocalChoice(ws.auth.available ? ws.auth.user?.id : undefined);
  const open = !choice.settled && ws.personalSpaceEnabled && linkDialogOptions(ws.spaceStatus).visible;
  return (
    <>
      <Sheet open={open} onClose={choice.snooze} title={t('space.link.title')} testId="mobile-link">
        <p className="m-sheet__meta">{t('space.link.explain')}</p>
        <SheetAction icon={<CloudUpload size={20} />} label={t('space.link.addLocal')} hint={t('space.link.addLocalHint')} onClick={() => {
          ws.personalSpace.addLocalToAccount();
        }} />
        <SheetAction icon={<Smartphone size={20} />} label={t('space.link.keepLocal')} hint={t('space.link.keepLocalHint')} onClick={choice.keepLocal} />
        <SheetAction icon={<Trash2 size={20} />} label={t('space.link.discard')} hint={t('space.link.discardHint')} danger onClick={() => {
          void confirm({
            title: t('space.link.discardConfirm.title'),
            message: t('space.link.discardConfirm.message'),
            confirmLabel: t('space.link.discard'),
            danger: true,
          }).then((confirmed) => {
            if (confirmed) ws.personalSpace.discardLocalForAccount();
          });
        }} />
      </Sheet>
      {confirmElement}
    </>
  );
}

/**
 * While the browser sign-in runs: the app waits for the `canvink://` hand-off,
 * can open the browser again, or takes the code the browser shows when the
 * hand-off was blocked.
 */
export function SignInSheet({ ws }: { ws: MobileWorkspace }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const auth = ws.auth;
  const open = desktopLoginDialogVisible(auth);
  const desktop = auth.available ? auth.desktop : undefined;
  const errorKeys: Record<'failed' | 'expired' | 'browserFailed', TranslationKey> = {
    failed: 'desktop.login.failed',
    expired: 'desktop.login.expired',
    browserFailed: 'desktop.login.browserFailed',
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop || !code.trim()) return;
    setBusy(true);
    const accepted = await desktop.submitCode(code.trim());
    setBusy(false);
    setRejected(!accepted);
    if (accepted) setCode('');
  };
  return (
    <Sheet open={open} onClose={() => desktop?.cancel()} title={t('desktop.login.title')} testId="mobile-sign-in">
      {desktop ? (
        <>
          <p className="m-sheet__meta" role="status">
            {desktop.error && !desktop.pending ? t(errorKeys[desktop.error]) : t('desktop.login.waiting')}
          </p>
          <SheetAction icon={<ExternalLink size={20} />} label={t('desktop.login.reopen')} onClick={desktop.reopenBrowser} />
          <form className="m-code-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="m-sign-in-code">{t('desktop.login.codeLabel')}</label>
            <div>
              <input
                id="m-sign-in-code"
                value={code}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={rejected}
                onChange={(event) => {
                  setCode(event.target.value);
                  setRejected(false);
                }}
              />
              <button type="submit" className="m-button m-button--filled m-ripple" disabled={busy || !code.trim()}>{t('desktop.login.submit')}</button>
            </div>
            {rejected ? <p className="m-error" role="alert">{t('desktop.login.failed')}</p> : null}
          </form>
          <button type="button" className="m-button m-button--text m-ripple" onClick={desktop.cancel}>{t('desktop.login.cancel')}</button>
        </>
      ) : null}
    </Sheet>
  );
}
