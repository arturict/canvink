import { Link2, LoaderCircle, LogIn, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { UseJoinLinkResult } from './useJoinLink';

/**
 * What a share link shows over the normal app while it is followed: a prompt
 * to sign in, the progress of adding the notebook, or why that did not work.
 * It never shows the notebook itself: once the notebook is in the workspace
 * the app opens it like any other.
 */
export default function JoinLinkDialog({ join }: { join: UseJoinLinkResult }) {
  const { t } = useI18n();
  const { state } = join;
  if (state.kind === 'idle') return null;
  const notebook = 'title' in state && state.title ? state.title : null;

  return (
    <div className="recovery-overlay" role="presentation">
      <section
        className="recovery-card collab-join-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-join-title"
        data-join-state={state.kind}
      >
        <button type="button" className="recovery-card__close" aria-label={t('collab.join.close')} onClick={join.dismiss}>
          <X size={16} />
        </button>
        <Link2 size={24} aria-hidden="true" />
        <h2 id="collab-join-title">{notebook ?? t('collab.join.title')}</h2>

        {state.kind === 'sign-in' ? (
          <>
            <p>{t('collab.join.signInPrompt')}</p>
            <p className="collab-share-dialog__hint">{t('collab.join.signInHint')}</p>
            <div className="collab-share-dialog__actions">
              <button type="button" onClick={join.signIn}>
                <LogIn size={15} aria-hidden="true" /> {t('collab.join.signIn')}
              </button>
            </div>
          </>
        ) : null}

        {state.kind === 'joining' ? (
          <p role="status" className="collab-join-dialog__progress">
            <LoaderCircle size={16} className="collab-join-dialog__spinner" aria-hidden="true" /> {t('collab.join.joining')}
          </p>
        ) : null}

        {state.kind === 'unavailable' ? (
          <p className="collab-share-dialog__error" role="alert">{t('collab.join.unavailable')}</p>
        ) : null}

        {state.kind === 'error' ? (
          <>
            <p className="collab-share-dialog__error" role="alert">
              {t(
                state.reason === 'unauthorized'
                  ? 'collab.join.errorUnauthorized'
                  : state.reason === 'conflict' ? 'collab.join.errorConflict' : 'collab.join.error',
              )}
            </p>
            <div className="collab-share-dialog__actions">
              <button type="button" onClick={join.retry}>{t('collab.join.retry')}</button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
