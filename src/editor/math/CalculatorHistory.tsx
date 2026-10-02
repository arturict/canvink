import { useCallback, useEffect, useId, useState } from 'react';
import type {
  CalculatorHistory,
  CalculatorHistoryEntry,
  CalculatorHistoryInput,
} from '../../math/history';

export interface CalculatorHistoryLabels {
  title: string;
  empty: string;
  loading: string;
  copy: string;
  restore: string;
  delete: string;
  clear: string;
  exact: string;
  decimal: string;
  degrees: string;
  radians: string;
  copied: string;
  restored: string;
  deleted: string;
  cleared: string;
  error: string;
}

export interface CalculatorHistoryProps {
  history: CalculatorHistory;
  labels: CalculatorHistoryLabels;
  onCopy: (plainText: string) => void | Promise<void>;
  onRestore: (input: CalculatorHistoryInput) => void | Promise<void>;
  onError?: (error: unknown) => void;
  confirmClear?: () => boolean | Promise<boolean>;
  formatCreatedAt?: (createdAt: string) => string;
  initialEntries?: readonly CalculatorHistoryEntry[];
  className?: string;
}

export function CalculatorHistoryView({
  history,
  labels,
  onCopy,
  onRestore,
  onError,
  confirmClear,
  formatCreatedAt = (value) => value,
  initialEntries = [],
  className,
}: CalculatorHistoryProps) {
  const titleId = useId();
  const [entries, setEntries] = useState<CalculatorHistoryEntry[]>(() =>
    initialEntries.map((entry) => structuredClone(entry))
  );
  const [busy, setBusy] = useState(initialEntries.length === 0);
  const [status, setStatus] = useState('');

  const reportError = useCallback((error: unknown) => {
    setStatus(labels.error);
    onError?.(error);
  }, [labels.error, onError]);

  useEffect(() => {
    let active = true;
    void history.list().then((next) => {
      if (active) setEntries(next);
    }).catch((error: unknown) => {
      if (active) reportError(error);
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [history, reportError]);

  const copy = async (id: string) => {
    setBusy(true);
    try {
      await onCopy(await history.copyPayload(id));
      setStatus(labels.copied);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id: string) => {
    setBusy(true);
    try {
      await history.restore(id, onRestore);
      setStatus(labels.restored);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      if (await history.delete(id)) {
        setEntries((current) => current.filter((entry) => entry.id !== id));
        setStatus(labels.deleted);
      }
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      if (confirmClear && !await confirmClear()) return;
      await history.clear();
      setEntries([]);
      setStatus(labels.cleared);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={className} aria-labelledby={titleId} aria-busy={busy}>
      <header>
        <h2 id={titleId}>{labels.title}</h2>
        <button type="button" onClick={() => void clear()} disabled={busy || entries.length === 0}>
          {labels.clear}
        </button>
      </header>
      {busy && entries.length === 0 ? <p>{labels.loading}</p> : null}
      {!busy && entries.length === 0 ? <p>{labels.empty}</p> : null}
      {entries.length > 0 ? (
        <ol>
          {entries.map((entry) => (
            <li key={entry.id} data-history-entry-id={entry.id}>
              <code>{entry.expression}</code>
              <output>{entry.visibleResult}</output>
              <span>
                {entry.numberMode === 'exact' ? labels.exact : labels.decimal}
                {' · '}
                {entry.angleMode === 'degrees' ? labels.degrees : labels.radians}
              </span>
              <time dateTime={entry.createdAt}>{formatCreatedAt(entry.createdAt)}</time>
              <div role="group" aria-label={entry.expression}>
                <button type="button" onClick={() => void copy(entry.id)} disabled={busy}>
                  {labels.copy}
                </button>
                <button type="button" onClick={() => void restore(entry.id)} disabled={busy}>
                  {labels.restore}
                </button>
                <button type="button" onClick={() => void remove(entry.id)} disabled={busy}>
                  {labels.delete}
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <p role="status" aria-live="polite">{status}</p>
    </section>
  );
}

export default CalculatorHistoryView;
