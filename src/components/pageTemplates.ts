import type { RichTextBlock, RichTextElementV2, RichTextSpan } from '../domain/v2';
import type { PageDocV3 } from '../domain/v3';
import type { TranslationKey } from '../i18n/catalog';
import { formatShortDate } from '../editor/richText/slashMenu';

/**
 * Page templates, like OneNote's: a template is either built in or any page
 * the user tagged "vorlage". A section that contains a template page uses it
 * as its default, so "Add page" there starts from it (the weekly homework
 * table of a "Husi" section, for example).
 */
export const TEMPLATE_TAG = 'vorlage';

export type BuiltinTemplateId = 'homework-week' | 'exercise-sheet' | 'lesson-notes';

export type PageTemplateSource = { kind: 'builtin'; id: BuiltinTemplateId } | { kind: 'page'; pageId: string };

export interface TemplatePageSummary {
  pageId: string;
  title: string;
  sectionId: string;
}

export interface BuiltinTemplate {
  id: BuiltinTemplateId;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  { id: 'homework-week', labelKey: 'templates.homeworkWeek', descriptionKey: 'templates.homeworkWeek.description' },
  { id: 'exercise-sheet', labelKey: 'templates.exerciseSheet', descriptionKey: 'templates.exerciseSheet.description' },
  { id: 'lesson-notes', labelKey: 'templates.lessonNotes', descriptionKey: 'templates.lessonNotes.description' },
];

export function isTemplatePage(page: { tags: readonly string[] }): boolean {
  return page.tags.includes(TEMPLATE_TAG);
}

/**
 * Title for a page created from a template: "{datum}" (or "{date}") in the
 * template title becomes today's date; without a placeholder the new page is
 * titled with the date.
 */
export function titleFromTemplate(templateTitle: string, now: Date): string {
  const date = formatShortDate(now);
  return /\{(datum|date)\}/i.test(templateTitle)
    ? templateTitle.replace(/\{(datum|date)\}/gi, date).trim()
    : date;
}

type Translate = (key: TranslationKey) => string;

let blockCounter = 0;
function blockId(prefix: string): string {
  blockCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${blockCounter}`;
}

const text = (value: string, bold = false): RichTextSpan[] =>
  value ? [{ text: value, marks: bold ? [{ type: 'bold' }] : [] }] : [];

function richText(
  id: string,
  frame: { x: number; y: number; width: number; height: number },
  blocks: RichTextBlock[],
  now: string,
): RichTextElementV2 {
  return {
    id,
    kind: 'richText',
    frame: { ...frame, rotation: 0 },
    createdAt: now,
    updatedAt: now,
    locked: false,
    content: { type: 'doc', blocks },
    style: { color: '#111827', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 16, textAlign: 'left' },
  };
}

function withElements(page: PageDocV3, elements: RichTextElementV2[]): PageDocV3 {
  return {
    ...page,
    elementsById: Object.fromEntries(elements.map((element) => [element.id, element])),
    zOrder: elements.map((element) => element.id),
  };
}

/** Fills a fresh page document with the content of a built-in template. */
export function applyBuiltinTemplate(id: BuiltinTemplateId, page: PageDocV3, t: Translate): PageDocV3 {
  const now = page.createdAt;
  if (id === 'homework-week') {
    // A weekly homework table: subject, task, where, must-do.
    const header = ['templates.homework.subject', 'templates.homework.task', 'templates.homework.where', 'templates.homework.mustDo'] as const;
    const subjects = ['De', 'Wr', 'Mt', 'Gp'];
    const rows: RichTextSpan[][][] = [
      header.map((key) => text(t(key), true)),
      ...subjects.map((subject) => [text(subject), [], [], []]),
    ];
    return {
      ...withElements(page, [richText(blockId('text'), { x: 56, y: 40, width: 680, height: 220 }, [
        { id: blockId('table'), type: 'table', rows },
      ], now)]),
      pageType: 'free',
      background: { type: 'plain', color: '#ffffff' },
    };
  }
  if (id === 'exercise-sheet') {
    return {
      ...withElements(page, [richText(blockId('text'), { x: 56, y: 40, width: 520, height: 90 }, [
        { id: blockId('heading'), type: 'heading', level: 2, spans: text(t('templates.exercise.heading')) },
        { id: blockId('paragraph'), type: 'paragraph', spans: text(t('templates.exercise.source')) },
      ], now)]),
      pageType: 'free',
      background: { type: 'grid', color: '#ffffff' },
    };
  }
  return {
    ...withElements(page, [richText(blockId('text'), { x: 56, y: 40, width: 560, height: 220 }, [
      { id: blockId('heading'), type: 'heading', level: 2, spans: text(t('templates.lesson.topic')) },
      { id: blockId('paragraph'), type: 'paragraph', list: 'bullet', spans: [] },
      { id: blockId('heading'), type: 'heading', level: 3, spans: text(t('templates.lesson.important')) },
      { id: blockId('paragraph'), type: 'paragraph', list: 'bullet', spans: [] },
      { id: blockId('heading'), type: 'heading', level: 3, spans: text(t('templates.lesson.homework')) },
      { id: blockId('check'), type: 'checkItem', checked: false, spans: [] },
    ], now)]),
    pageType: 'free',
    background: { type: 'lined', color: '#ffffff' },
  };
}
