import { lazy, Suspense } from 'react';
import { LandingPage } from './landing/LandingPage';
import { shouldRenderNotebook } from './routing';

const NotebookApp = lazy(() => import('./components/NotebookApp'));

export default function App() {
  const isNotebook = shouldRenderNotebook(
    window.location.pathname,
    typeof window.__TAURI_INTERNALS__ !== 'undefined',
  );

  if (!isNotebook) {
    return <LandingPage />;
  }

  return (
    <Suspense
      fallback={
        <main className="app-loading" aria-live="polite">
          <span className="brand-mark" aria-hidden="true">C</span>
          <p>Opening your workspace…</p>
        </main>
      }
    >
      <NotebookApp />
    </Suspense>
  );
}
