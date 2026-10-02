import {
  Suspense,
  createContext,
  lazy,
  useContext,
  useState,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import { useI18n } from '../i18n';

/**
 * Where the notice for a chunk that could not load appears. `screen` replaces
 * the whole view, `floating` sits over the current page, and `silent` shows
 * nothing for code that only enhances the page (the Clerk bridge).
 */
type FailureLayout = 'screen' | 'floating' | 'silent';

interface RetryableLazyOptions {
  fallback?: ReactNode;
  layout?: FailureLayout;
}

interface RetryableLazyComponent<Props extends object> {
  (props: Props): JSX.Element;
  /**
   * Starts loading the chunk ahead of its first use. Never rejects and does
   * nothing offline, where the request could only fail and log a network error.
   */
  preload: () => void;
}

const RetryContext = createContext<() => void>(() => undefined);

function ChunkFailure({ layout }: { layout: FailureLayout }) {
  const { t } = useI18n();
  const retry = useContext(RetryContext);
  if (layout === 'silent') return null;
  const notice = (
    <div className="chunk-failure" data-layout={layout} role="alert">
      <button type="button" onClick={retry}>{t('app.chunk.failed')}</button>
    </div>
  );
  return layout === 'screen' ? <main className="fatal-state">{notice}</main> : notice;
}

/**
 * `React.lazy` that survives a chunk that cannot load. A plain lazy component
 * remembers the rejected import for good and throws it into the tree, which
 * ends in a white screen and an unhandled rejection; offline (or right after a
 * deploy removed a file) that is a normal condition. Here a failed import
 * resolves to a retry button instead, and the retry builds a fresh lazy
 * component, so the import runs again (a browser that keeps the failed import
 * is served by a page reload, see below).
 */
export function retryableLazy<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  { fallback = null, layout = 'floating' }: RetryableLazyOptions = {},
): RetryableLazyComponent<Props> {
  const failure = { default: () => <ChunkFailure layout={layout} /> };
  let failedBefore = false;
  const create = () => lazy(() => load().catch((error: unknown) => {
    console.warn('Canvink could not load part of the app.', error);
    // Chrome remembers a failed dynamic import for the life of the page, so a
    // retry after a failure cannot succeed without a new page load. The retry
    // was the user's click, and every piece of work is already saved locally,
    // so reloading is safe, but only online: offline it would drop the page
    // without a way back in when no cached copy exists.
    if (failedBefore && navigator.onLine) window.location.reload();
    failedBefore = true;
    return failure;
  }));
  let Loaded = create();

  function RetryableLazy(props: Props): JSX.Element {
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
      Loaded = create();
      setAttempt((count) => count + 1);
    };
    return (
      <RetryContext.Provider key={attempt} value={retry}>
        <Suspense fallback={fallback}>
          <Loaded {...props} />
        </Suspense>
      </RetryContext.Provider>
    );
  }

  RetryableLazy.preload = (): void => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    load().catch(() => undefined);
  };
  return RetryableLazy;
}
