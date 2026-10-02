import { FileText, FileType, ListChecks, ScanText, Tag, TextAlignStart, type LucideIcon } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import { highlightParts } from './searchHighlight';
import type { SearchSourceBadge, SearchUiResult } from './searchRuntime';

export const sourceLabelKeys: Record<SearchSourceBadge, TranslationKey> = {
  title: 'search.source.title',
  text: 'search.source.text',
  tag: 'search.source.tag',
  checklist: 'search.source.checklist',
  pdf: 'search.source.pdf',
  ocr: 'search.source.ocr',
};

const sourceIcons: Record<SearchSourceBadge, LucideIcon> = {
  title: FileText,
  text: TextAlignStart,
  tag: Tag,
  checklist: ListChecks,
  pdf: FileType,
  ocr: ScanText,
};

/** Which match leads the row: what the page says beats what it is called. */
const SOURCE_PRIORITY: readonly SearchSourceBadge[] = ['ocr', 'pdf', 'checklist', 'text', 'tag', 'title'];

function leadingSource(sources: readonly SearchSourceBadge[]): SearchSourceBadge {
  return SOURCE_PRIORITY.find((source) => sources.includes(source)) ?? 'title';
}

export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) => (
        part.match ? <mark key={index}>{part.text}</mark> : part.text
      ))}
    </>
  );
}

export interface SearchResultRowProps {
  id: string;
  result: SearchUiResult;
  query: string;
  active: boolean;
  onActivate(): void;
  onHover(): void;
}

/**
 * One result: an icon for what matched, the page title, a snippet with the
 * query words marked, and small labels for text that is not plain page text
 * (PDF, recognized scan text, tags, checklists) and for task state.
 */
export default function SearchResultRow({ id, result, query, active, onActivate, onHover }: SearchResultRowProps) {
  const { t } = useI18n();
  const Lead = sourceIcons[leadingSource(result.sourceBadges)];
  // A snippet that only repeats a name the group header or the title already shows adds nothing.
  const names = [result.title, result.sectionTitle, result.notebookTitle].map((name) => name.trim());
  const showSnippet = Boolean(result.snippet) && !names.includes(result.snippet.trim());
  const labelled = result.sourceBadges.filter((source) => source !== 'text' && source !== 'title');
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className="search-result"
      data-active={active ? 'true' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onActivate}
    >
      <span className="search-result__icon" aria-hidden="true"><Lead size={15} /></span>
      <span className="search-result__body">
        <span className="search-result__title"><Highlighted text={result.title || t('workspace.page.untitled')} query={query} /></span>
        {showSnippet ? <span className="search-result__snippet"><Highlighted text={result.snippet} query={query} /></span> : null}
      </span>
      <span className="search-result__meta">
        {result.taskState ? (
          <span className="search-tag" data-task={result.taskState}>{t(result.taskState === 'done' ? 'search.tasks.done' : 'search.tasks.open')}</span>
        ) : null}
        {labelled.map((source) => {
          const Icon = sourceIcons[source];
          return (
            <span key={source} className="search-tag">
              <Icon size={11} aria-hidden="true" />
              {t(sourceLabelKeys[source])}
            </span>
          );
        })}
      </span>
    </div>
  );
}
