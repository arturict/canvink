import { useEffect } from 'react';
import { DESKTOP_DOWNLOAD_PATH } from '../platform/desktopDownload';
import { ANDROID_DOWNLOAD_PATH } from './downloads';
import { LandingVideo, type LandingClip } from './LandingVideo';
import type { LandingKey } from './strings';
import { useInstallPrompt } from './useInstallPrompt';
import { useLandingLanguage } from './useLandingLanguage';
import './landing.css';

const REPOSITORY_URL = 'https://github.com/arturict/canvink';
const APP_PATH = '/app';

type T = (key: LandingKey, parameters?: Record<string, string>) => string;

// Recorded from the app by scripts/record-landing-clips.mjs; sizes are the encoded clips'.
const CLIPS = {
  notebook: { name: 'notebook', width: 1800, height: 1074, label: 'hero.clip' },
  collab: { name: 'collab', width: 1100, height: 538, label: 'collab.clip' },
  ink: { name: 'ink', width: 1000, height: 698, label: 'ink.clip' },
  markdown: { name: 'markdown', width: 1000, height: 580, label: 'markdown.clip' },
} satisfies Record<string, Omit<LandingClip, 'label'> & { label: LandingKey }>;

function clip(t: T, entry: (typeof CLIPS)[keyof typeof CLIPS]): LandingClip {
  return { ...entry, label: t(entry.label) };
}

/* Inline icons keep the landing chunk free of the app's icon bundle. */
const ICONS = {
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-3.2 3.3-3.2 14.7 0 18m0-18c3.2 3.3 3.2 14.7 0 18M3.5 12h17',
  download: 'M12 4v11m0 0 4.5-4.5M12 15 7.5 10.5M4 17v1.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V17',
  arrow: 'M5 12h14m-5.5-5.5L19 12l-5.5 5.5',
  check: 'm5 12.5 4.5 4.5L19 7',
  install: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 14.5v-9ZM9 20h6m-3-4v4',
  android: 'M6 11a6 6 0 0 1 12 0v6H6v-6Zm3-4L7.5 4.5M15 7l1.5-2.5M9 17v3m6-3v3M3.5 11v5m17-5v5M9.5 11h.01m4.99 0h.01',
  code: 'm8 8-4 4 4 4m8-8 4 4-4 4M14 5l-4 14',
} as const;

function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

function Brand({ label }: { label: string }) {
  return (
    <a className="lp-brand" href="/" aria-label={label}>
      <img src="/canvink-mark.svg" alt="" width={30} height={30} />
      Canvink
    </a>
  );
}

function LanguageToggle({ language, setLanguage, label }: { language: 'de' | 'en'; setLanguage: (language: 'de' | 'en') => void; label: string }) {
  return (
    <div className="lp-lang" role="group" aria-label={label}>
      {(['de', 'en'] as const).map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={language === option}
          onClick={() => setLanguage(option)}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** A hand-drawn double underline that draws itself in once (not with reduced motion). */
function InkUnderline() {
  return (
    <svg className="lp-ink-stroke" viewBox="0 0 400 30" preserveAspectRatio="none" aria-hidden="true">
      <path d="M6 14C70 6 130 18 200 11s130-10 194 4" pathLength={1} />
      <path d="M90 25c60-5 130 1 200-3" pathLength={1} />
    </svg>
  );
}

function InstallCard({ t }: { t: T }) {
  const { canPrompt, installed, install } = useInstallPrompt();
  return (
    <article className="lp-card" data-tab="4">
      <Icon name="install" size={28} />
      <h3>{t('download.pwa.title')}</h3>
      <p>{t('download.pwa.text')}</p>
      {installed ? (
        <p className="lp-card__done">
          <Icon name="check" size={16} /> {t('download.pwa.done')}
        </p>
      ) : canPrompt ? (
        <button type="button" className="lp-button" onClick={() => void install()}>
          <Icon name="install" />
          {t('download.pwa.button')}
        </button>
      ) : (
        <details className="lp-howto">
          <summary>{t('download.pwa.howto')}</summary>
          <ul>
            <li>{t('download.pwa.chrome')}</li>
            <li>{t('download.pwa.ios')}</li>
            <li>{t('download.pwa.android')}</li>
          </ul>
        </details>
      )}
    </article>
  );
}

/** Isolated so the Android viewer can be switched on by setting ANDROID_DOWNLOAD_PATH alone. */
function AndroidCard({ t, path }: { t: T; path: string }) {
  return (
    <article className="lp-card" data-tab="5">
      <Icon name="android" size={28} />
      <h3>{t('download.android.title')}</h3>
      <p>{t('download.android.text')}</p>
      <a className="lp-button" href={path} download>
        <Icon name="download" />
        {t('download.android.button')}
      </a>
      <p className="lp-fineprint">{t('download.android.fineprint')}</p>
    </article>
  );
}

const FEATURES: LandingKey[] = [
  'features.f1', 'features.f2', 'features.f3', 'features.f4', 'features.f5',
  'features.f6', 'features.f7', 'features.f8', 'features.f9', 'features.f10',
];

const COLLAB_POINTS: LandingKey[] = ['collab.p1', 'collab.p2', 'collab.p3', 'collab.p4'];

const MEASUREMENTS: Array<{ value: LandingKey; text: LandingKey }> = [
  { value: 'speed.m1.value', text: 'speed.m1.text' },
  { value: 'speed.m2.value', text: 'speed.m2.text' },
  { value: 'speed.m3.value', text: 'speed.m3.text' },
];

export default function LandingPage() {
  const { language, setLanguage, t } = useLandingLanguage();

  useEffect(() => {
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
  }, [t]);

  return (
    <main className="lp" lang={language}>
      <header className="lp-nav lp-wrap">
        <Brand label={t('nav.home')} />
        <nav aria-label={t('nav.main')}>
          <a className="lp-nav__link" href="#zusammen">{t('nav.collab')}</a>
          <a className="lp-nav__link" href="#tempo">{t('nav.speed')}</a>
          <a className="lp-nav__link" href="#download">{t('nav.download')}</a>
          <LanguageToggle language={language} setLanguage={setLanguage} label={t('lang.label')} />
          <a className="lp-button lp-button--primary lp-button--small lp-nav__cta" href={APP_PATH}>{t('nav.open')}</a>
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-wrap">
          <div className="lp-hero__copy">
            <div>
              <p className="lp-eyebrow" data-tab="1">{t('hero.eyebrow')}</p>
              <h1>
                {t('hero.title.a')}{' '}
                <span className="lp-hero__ink">
                  {t('hero.title.b')}
                  <InkUnderline />
                </span>
              </h1>
            </div>
            <div className="lp-hero__row">
              <p className="lp-lede">{t('hero.lede')}</p>
              <div className="lp-hero__aside">
                <div className="lp-actions">
                  <a className="lp-button lp-button--primary" href={APP_PATH}>
                    <Icon name="globe" />
                    {t('hero.open')}
                  </a>
                  <a className="lp-button" href={DESKTOP_DOWNLOAD_PATH} download>
                    <Icon name="download" />
                    {t('hero.windows')}
                  </a>
                </div>
                <p className="lp-fineprint">{t('hero.fineprint')}</p>
              </div>
            </div>
          </div>
          <figure className="lp-figure lp-figure--hero">
            <div className="lp-frame lp-frame--tabs">
              <span className="lp-frame__tabs" aria-hidden="true"><i /><i /><i /><i /><i /></span>
              <LandingVideo clip={clip(t, CLIPS.notebook)} priority />
            </div>
            <figcaption>{t('hero.caption')}</figcaption>
          </figure>
        </div>
      </section>

      <section className="lp-band" id="zusammen" aria-labelledby="zusammen-title">
        <div className="lp-wrap">
          <div className="lp-band__head">
            <p className="lp-eyebrow" data-tab="6">{t('collab.eyebrow')}</p>
            <h2 id="zusammen-title">{t('collab.title')}</h2>
          </div>
          <figure className="lp-figure lp-band__figure">
            <div className="lp-frame">
              <LandingVideo clip={clip(t, CLIPS.collab)} />
            </div>
            <figcaption>{t('collab.caption')}</figcaption>
          </figure>
          <ul className="lp-points lp-band__points">
            {COLLAB_POINTS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lp-speed" id="tempo" aria-labelledby="tempo-title">
        <div className="lp-wrap">
          <div className="lp-head">
            <p className="lp-eyebrow" data-tab="2">{t('speed.eyebrow')}</p>
            <h2 id="tempo-title">{t('speed.title')}</h2>
            <p>{t('speed.lede')}</p>
          </div>
          <ol className="lp-measures">
            {MEASUREMENTS.map((item) => (
              <li key={item.value} className="lp-measure">
                <span className="lp-measure__value">
                  {t(item.value)}
                  <span className="lp-measure__unit">{t('speed.unit')}</span>
                </span>
                <span className="lp-measure__text">{t(item.text)}</span>
              </li>
            ))}
          </ol>
          <p className="lp-fineprint">{t('speed.fineprint')}</p>
          <div className="lp-pair">
            <figure className="lp-figure">
              <div className="lp-frame">
                <LandingVideo clip={clip(t, CLIPS.ink)} />
              </div>
              <figcaption>
                <strong>{t('ink.title')}</strong>
                {t('ink.text')}
              </figcaption>
            </figure>
            <figure className="lp-figure">
              <div className="lp-frame">
                <LandingVideo clip={clip(t, CLIPS.markdown)} />
              </div>
              <figcaption>
                <strong>{t('markdown.title')}</strong>
                {t('markdown.text')}
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="lp-features" aria-labelledby="features-title">
        <div className="lp-wrap">
          <div className="lp-head">
            <p className="lp-eyebrow" data-tab="3">{t('features.eyebrow')}</p>
            <h2 id="features-title">{t('features.title')}</h2>
          </div>
          <ul className="lp-tabs">
            {FEATURES.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lp-download" id="download" aria-labelledby="download-title">
        <div className="lp-wrap">
          <div className="lp-head">
            <p className="lp-eyebrow" data-tab="5">{t('download.eyebrow')}</p>
            <h2 id="download-title">{t('download.title')}</h2>
            <p>{t('download.lede')}</p>
          </div>
          <div className="lp-cards">
            <article className="lp-card" data-tab="6">
              <Icon name="download" size={28} />
              <h3>{t('download.windows.title')}</h3>
              <p>{t('download.windows.text')}</p>
              <a className="lp-button lp-button--primary" href={DESKTOP_DOWNLOAD_PATH} download>
                <Icon name="download" />
                {t('download.windows.button')}
              </a>
              <p className="lp-fineprint">{t('download.windows.fineprint')}</p>
            </article>
            <article className="lp-card" data-tab="2">
              <Icon name="globe" size={28} />
              <h3>{t('download.browser.title')}</h3>
              <p>{t('download.browser.text')}</p>
              <a className="lp-button" href={APP_PATH}>
                {t('download.browser.button')}
                <Icon name="arrow" />
              </a>
            </article>
            <InstallCard t={t} />
            {ANDROID_DOWNLOAD_PATH ? <AndroidCard t={t} path={ANDROID_DOWNLOAD_PATH} /> : null}
          </div>
          <p className="lp-fineprint lp-fineprint--center">
            {t('download.selfhost')}{' '}
            <a href={`${REPOSITORY_URL}#build-from-source`} target="_blank" rel="noreferrer">{t('download.selfhost.link')}</a>.
          </p>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <Brand label={t('nav.home')} />
          <p>{t('footer.version', { version: __CANVINK_VERSION__ })}</p>
          <nav aria-label={t('footer.links')}>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              <Icon name="code" size={16} /> {t('footer.source')}
            </a>
            <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">{t('footer.licence')}</a>
            <a href={`${REPOSITORY_URL}/blob/main/ROADMAP.md`} target="_blank" rel="noreferrer">{t('footer.roadmap')}</a>
            <a href={`${REPOSITORY_URL}/issues`} target="_blank" rel="noreferrer">{t('footer.feedback')}</a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
