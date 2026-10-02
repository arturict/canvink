import { Clock3, CopyPlus, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WorkspaceHistory,
  createPlatformHistorySnapshotStore,
  type HistoryChangePreview,
  type HistorySnapshotMetadata,
} from '../../history';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { useI18n, type TranslationKey, type TranslationParameters } from '../../i18n';
import { formatLocale } from '../../i18n/core';
import './HistoryPanel.css';

/** Editing must pause this long before the automatic snapshot check runs. */
const AUTOMATIC_QUIET_MS = 2_000;
/** Continuous editing still gets the check this often. */
const AUTOMATIC_MAX_WAIT_MS = 60_000;

/** Runs `work` when the browser is idle, at the latest after five seconds; returns the cancel function. */
function whenIdle(work: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(work, { timeout: 5_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(work, 1_500);
  return () => window.clearTimeout(handle);
}

export interface HistoryPanelProps {
  open: boolean;
  runtime: WorkspaceV2Runtime;
  pageId: string;
  onClose: () => void;
  onRestored?: () => void;
}

function snapshotLabel(
  snapshot: HistorySnapshotMetadata,
  t: (key: TranslationKey, parameters?: TranslationParameters) => string,
): string {
  if (snapshot.name) return snapshot.name;
  if (snapshot.kind === 'trash') return t('history.snapshot.beforeDelete');
  return t('history.snapshot.automatic');
}

export default function HistoryPanel({
  open,
  runtime,
  pageId,
  onClose,
  onRestored,
}: HistoryPanelProps) {
  const { language, t } = useI18n();
  const errorMessage = useCallback((error: unknown): string => (
    error instanceof Error && error.message.trim() ? error.message : t('history.error')
  ), [t]);
  const history = useMemo(
    () => new WorkspaceHistory(runtime, createPlatformHistorySnapshotStore()),
    [runtime],
  );
  const automaticQueue = useRef(Promise.resolve());
  const [snapshots, setSnapshots] = useState<HistorySnapshotMetadata[]>([]);
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<HistoryChangePreview>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string>();

  const refresh = useCallback(async () => {
    const items = await history.list(pageId);
    setSnapshots(items);
    setSelected((current) => {
      if (!current || items.some((item) => item.snapshotId === current)) return current;
      return undefined;
    });
  }, [history, pageId]);

  useEffect(() => {
    const capture = () => {
      automaticQueue.current = automaticQueue.current
        .then(async () => {
          const created = await history.captureAutomaticIfDue(pageId);
          if (created && open) await refresh();
        })
        .catch(() => undefined);
    };
    // A page's first snapshot keeps the state from before the first edit. It
    // is taken when the browser is idle, not while the page opens: saving a
    // page with thousands of strokes takes a few hundred milliseconds. Later
    // checks wait for a pause in editing for the same reason: a snapshot saves
    // the whole page, which would stall typing.
    const cancelBaseline = whenIdle(capture);
    let timer: number | undefined;
    let waitingSince = 0;
    const scheduleCapture = () => {
      const now = performance.now();
      if (timer === undefined) waitingSince = now;
      else window.clearTimeout(timer);
      const delay = Math.min(AUTOMATIC_QUIET_MS, Math.max(0, AUTOMATIC_MAX_WAIT_MS - (now - waitingSince)));
      timer = window.setTimeout(() => {
        timer = undefined;
        capture();
      }, delay);
    };
    const unsubscribe = runtime.subscribeToPageChanges(pageId, scheduleCapture);
    return () => {
      cancelBaseline();
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [history, open, pageId, refresh, runtime]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void refresh().catch((error) => setMessage(errorMessage(error)));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [errorMessage, open, refresh]);

  if (!open) return null;

  const createCheckpoint = async () => {
    setBusy(true);
    setMessage('');
    try {
      await history.createManualCheckpoint(pageId, name);
      setName('');
      await refresh();
      setMessage(t('history.checkpoint.saved'));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (snapshotId: string) => {
    setBusy(true);
    setMessage('');
    try {
      setSelected(snapshotId);
      setPreview(await history.preview(snapshotId));
    } catch (error) {
      setPreview(undefined);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage('');
    try {
      const restored = await history.restoreAsCopy(selected);
      setMessage(t('history.restore.success', { title: restored.title }));
      onRestored?.();
      onClose();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (snapshotId: string) => {
    setBusy(true);
    setMessage('');
    try {
      await history.delete(snapshotId);
      setPendingDelete(undefined);
      await refresh();
      setMessage(t('history.delete.success'));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="history-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        aria-busy={busy}
      >
        <header className="history-header">
          <div>
            <p className="history-eyebrow"><Clock3 size={15} aria-hidden="true" /> {t('history.eyebrow')}</p>
            <h2 id="history-title">{t('history.title')}</h2>
          </div>
          <button type="button" className="history-icon-button" onClick={onClose} aria-label={t('history.close')}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <p className="history-safety-note">
          {t('history.safety')}
        </p>

        <form className="history-checkpoint" onSubmit={(event) => {
          event.preventDefault();
          void createCheckpoint();
        }}>
          <label htmlFor="history-name">{t('history.checkpoint.label')}</label>
          <div>
            <input
              id="history-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('history.checkpoint.placeholder')}
              disabled={busy}
            />
            <button type="submit" disabled={busy || !name.trim()}>
              <Save size={16} aria-hidden="true" /> {t('history.checkpoint.save')}
            </button>
          </div>
        </form>

        <div className="history-content">
          <div className="history-list" aria-label={t('history.list.label')}>
            {snapshots.length === 0 ? (
              <p className="history-empty">{t('history.empty')}</p>
            ) : snapshots.map((snapshot) => (
              <article key={snapshot.snapshotId} className={selected === snapshot.snapshotId ? 'selected' : ''}>
                <button type="button" className="history-entry" onClick={() => void inspect(snapshot.snapshotId)}>
                  <strong>{snapshotLabel(snapshot, t)}</strong>
                  <span>{new Intl.DateTimeFormat(formatLocale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.createdAt))}</span>
                  <small>{t('history.device', { device: snapshot.deviceId.slice(0, 8) })} · {snapshot.kind === 'manual' ? t('history.kind.manual') : snapshot.kind === 'trash' ? t('history.kind.trash') : t('history.kind.automatic')}</small>
                </button>
                {pendingDelete === snapshot.snapshotId ? (
                  <div className="history-delete-confirm" role="group" aria-label={t('history.delete.confirmLabel')}>
                    <span>{t('history.delete.question')}</span>
                    <button type="button" onClick={() => void remove(snapshot.snapshotId)} disabled={busy}>{t('history.delete.yes')}</button>
                    <button type="button" onClick={() => setPendingDelete(undefined)}>{t('history.delete.no')}</button>
                  </div>
                ) : (
                  <button type="button" className="history-delete" onClick={() => setPendingDelete(snapshot.snapshotId)} aria-label={t('history.delete.snapshot', { name: snapshotLabel(snapshot, t) })}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </article>
            ))}
          </div>

          <aside className="history-preview" aria-live="polite">
            {preview ? (
              <>
                <h3>{t('history.preview.title', { title: preview.sourceTitle })}</h3>
                <dl>
                  <div><dt>{t('history.preview.laterChanges')}</dt><dd>{preview.changesAfterSnapshot}</dd></div>
                  <div><dt>{t('history.preview.elementDelta')}</dt><dd>{preview.elementDelta > 0 ? '+' : ''}{preview.elementDelta}</dd></div>
                  <div><dt>{t('history.preview.conflicts')}</dt><dd>{preview.snapshotConflicts} / {preview.currentConflicts}</dd></div>
                </dl>
                {preview.changeMessages.length > 0 && (
                  <ul>
                    {preview.changeMessages.slice(0, 5).map((change, index) => (
                      <li key={`${change.actor}-${index}`}>{change.message}</li>
                    ))}
                  </ul>
                )}
                <button type="button" className="history-restore" onClick={() => void restore()} disabled={busy}>
                  <CopyPlus size={17} aria-hidden="true" /> {t('history.restore.copy')}
                </button>
              </>
            ) : (
              <p>{t('history.preview.choose')}</p>
            )}
          </aside>
        </div>

        <p className="history-status" role="status" aria-live="polite">
          {busy ? t('history.processing') : message}
        </p>
      </section>
    </div>
  );
}
