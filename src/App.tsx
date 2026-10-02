import { I18nProvider, LanguageSwitcher, useI18n } from './i18n';
import { shouldRenderNotebook } from './routing';
import { retryableLazy } from './components/retryableLazy';
import { startupInkRaster } from './editor/inkRasterDisplay';
import { StartupInkRaster } from './editor/InkRasterLayer';

function NotebookLoading() {
  const { t } = useI18n();
  return (
    <main className="app-loading" aria-live="polite">
      <span className="brand-mark" aria-hidden="true">C</span>
      <p>{t('app.loading')}</p>
      <LanguageSwitcher className="app-language-switcher" />
      <StartupInkRaster />
    </main>
  );
}

// The phone app (pnpm build:android) has its own shell; the build flag is a
// constant, so each bundle holds only one of the two and the phone never
// downloads the desktop shell.
const NotebookApp = __CANVINK_VIEWER__
  ? retryableLazy(() => import('./mobile/MobileApp'), { fallback: <MobileLoading />, layout: 'screen' })
  : retryableLazy(() => import('./components/V2NotebookApp'), {
    fallback: <NotebookLoading />,
    layout: 'screen',
  });

/** The phone app's first frame while its shell loads: plain paper, as its splash screen. */
function MobileLoading() {
  return <main className="app-loading app-loading--mobile" aria-busy="true" />;
}
// The landing page is its own chunk: opening the notebook never downloads it, and the landing never downloads the editor.
const LandingPage = retryableLazy(() => import('./landing/LandingPage'), { layout: 'screen' });
const DesktopLoginPage = retryableLazy(() => import('./desktop-login/DesktopLoginPage'), { layout: 'screen' });

export default function App() {
  // The browser half of the desktop sign-in (PERSONAL-SYNC.md §3.7). Never
  // inside the desktop app itself.
  if (window.location.pathname === '/desktop-login' && typeof window.__TAURI_INTERNALS__ === 'undefined') {
    return (
      <I18nProvider>
        <DesktopLoginPage />
      </I18nProvider>
    );
  }

  const isNotebook = shouldRenderNotebook(
    window.location.pathname,
    typeof window.__TAURI_INTERNALS__ !== 'undefined',
  );

  if (!isNotebook) {
    return (
      <I18nProvider>
        <LandingPage />
      </I18nProvider>
    );
  }
  // The start page's ink picture is looked up while the notebook's code loads.
  if (!__CANVINK_VIEWER__) void startupInkRaster();

  return (
    <I18nProvider>
      <NotebookApp />
    </I18nProvider>
  );
}
