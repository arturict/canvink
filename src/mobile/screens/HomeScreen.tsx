import { useMemo, type CSSProperties } from 'react';
import { CloudOff, Pin, NotebookTabs, UserRound } from 'lucide-react';
import { formatLocale } from '../../i18n/core';
import { useI18n } from '../../i18n';
import type { PageEntry, RecencyGroup } from '../model';
import { continueEntry, recentlyChanged, relativeTime, pinnedEntries } from '../model';
import { PageThumbnail } from '../PageThumbnail';
import { EmptyState, IconButton, ListScreen, SectionDot } from '../ui';
import type { MobileWorkspace } from '../useMobileWorkspace';
import { SyncLine } from '../SyncLine';

const GROUP_KEYS = {
  today: 'mobile.recent.today',
  yesterday: 'mobile.recent.yesterday',
  week: 'mobile.recent.week',
  earlier: 'mobile.recent.earlier',
} as const satisfies Record<RecencyGroup, string>;

export interface HomeScreenProps {
  ws: MobileWorkspace;
  entries: readonly PageEntry[];
  now: Date;
  onOpen: (entry: PageEntry) => void;
  onAccount: () => void;
  onRefresh: () => Promise<void> | void;
  avatar: string | null;
}

/**
 * Start: what a student opens the app for, most likely first. The page they
 * left (with its handwriting), their pinned pages, and what changed lately on
 * any device, grouped by day.
 */
export function HomeScreen({ ws, entries, now, onOpen, onAccount, onRefresh, avatar }: HomeScreenProps) {
  const { t, language } = useI18n();
  const locale = formatLocale(language);
  const resume = useMemo(() => continueEntry(entries, ws.uiState.recentPageIds), [entries, ws.uiState.recentPageIds]);
  const pinned = useMemo(() => pinnedEntries(entries), [entries]);
  const recent = useMemo(() => recentlyChanged(entries, now), [entries, now]);
  const today = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  const signedOut = ws.auth.available && !ws.auth.isSignedIn;

  return (
    <ListScreen
      title={today}
      testId="mobile-home"
      subtitle={<SyncLine ws={ws} now={now} />}
      onRefresh={onRefresh}
      actions={(
        <IconButton label={ws.auth.available && ws.auth.isSignedIn ? t('account.button.signedIn', { name: ws.auth.user?.fullName ?? ws.auth.user?.primaryEmailAddress ?? '' }) : t('account.button.signedOut')} onClick={onAccount} className="m-avatar-button">
          {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : <UserRound size={22} aria-hidden="true" />}
        </IconButton>
      )}
    >
      {resume ? (
        <section className="m-home-section" aria-labelledby="m-home-continue">
          <h2 id="m-home-continue" className="m-overline">{t('mobile.home.continue')}</h2>
          <button type="button" className="m-continue m-ripple" onClick={() => onOpen(resume)} data-testid="mobile-continue">
            <PageThumbnail pageId={resume.page.pageId} updatedAt={resume.page.updatedAt} markdown={resume.page.pageContentKind === 'markdown'} />
            <span className="m-continue__text">
              <strong>{resume.page.title || t('workspace.page.untitled')}</strong>
              <span className="m-location">
                <SectionDot color={resume.sectionColor} />
                {resume.notebookTitle} · {resume.sectionTitle}
              </span>
              <small>{relativeTime(resume.page.updatedAt, now, locale)}</small>
            </span>
          </button>
        </section>
      ) : null}

      <section className="m-home-section" aria-labelledby="m-home-pinned">
        <h2 id="m-home-pinned" className="m-overline">{t('mobile.home.pinned')}</h2>
        {pinned.length > 0 ? (
          <ul className="m-pinned" role="list">
            {pinned.map((entry) => (
              <li key={entry.page.pageId}>
                <button
                  type="button"
                  className="m-pinned__card m-ripple"
                  style={{ '--m-section': entry.sectionColor } as CSSProperties}
                  onClick={() => onOpen(entry)}
                >
                  <Pin size={14} aria-hidden="true" className="m-pinned__pin" />
                  <strong>{entry.page.title || t('workspace.page.untitled')}</strong>
                  <small>{entry.sectionTitle}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-hint">{t('mobile.home.pinnedEmpty')}</p>
        )}
      </section>

      <section className="m-home-section" aria-labelledby="m-home-recent">
        <h2 id="m-home-recent" className="m-overline">{t('mobile.home.recent')}</h2>
        {recent.length === 0 ? (
          <EmptyState
            icon={<NotebookTabs size={28} />}
            title={t('mobile.home.empty.title')}
            text={signedOut ? t('mobile.home.empty.signedOut') : t('mobile.home.empty.text')}
            action={signedOut ? (
              <button type="button" className="m-button m-button--filled m-ripple" onClick={onAccount}>{t('space.account.signIn')}</button>
            ) : undefined}
          />
        ) : recent.map(({ group, entries: groupEntries }) => (
          <div key={group} className="m-group">
            <h3 className="m-group__title">{t(GROUP_KEYS[group])}</h3>
            <ul className="m-list" role="list">
              {groupEntries.map((entry) => (
                <li key={entry.page.pageId}>
                  <PageRow entry={entry} now={now} locale={locale} available={ws.isAvailable(entry.page.documentId)} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </ListScreen>
  );
}

export function PageRow({
  entry,
  now,
  locale,
  available,
  onOpen,
  showLocation = true,
  depth = 0,
}: {
  entry: PageEntry;
  now: Date;
  locale: string;
  available: boolean;
  onOpen: (entry: PageEntry) => void;
  showLocation?: boolean;
  depth?: number;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="m-row m-ripple"
      data-depth={depth || undefined}
      onClick={() => onOpen(entry)}
      data-testid="mobile-page-row"
    >
      <span className="m-row__lead" aria-hidden="true">
        <SectionDot color={entry.sectionColor} />
      </span>
      <span className="m-row__text">
        <span className="m-row__title">{entry.page.title || t('workspace.page.untitled')}</span>
        <span className="m-row__meta">
          {showLocation ? `${entry.notebookTitle} · ${entry.sectionTitle} · ` : ''}
          {relativeTime(entry.page.updatedAt, now, locale)}
        </span>
      </span>
      {!available ? (
        <span className="m-row__trail" title={t('mobile.page.notDownloaded')}>
          <CloudOff size={16} aria-label={t('mobile.page.notDownloaded')} />
        </span>
      ) : null}
    </button>
  );
}
