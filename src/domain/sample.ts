import { loadLanguagePreference } from '../i18n/preference';
import type { Language } from '../i18n/core';
import { createId } from './ids';
import {
  WORKSPACE_SCHEMA_VERSION,
  type ActiveContext,
  type InkPoint,
  type Page,
  type Section,
  type TextElement,
  type WorkspaceState,
} from './types';

/**
 * The start page id of installs created before 2026-09-25. Every one of them shares it, which
 * made two devices of one account carry "the same" page with unrelated histories.
 */
export const BUNDLED_START_PAGE_ID = 'page-canvink-example-start-here-v1';
/** New installs mark their start page with this prefix and a random suffix, unique per install. */
const BUNDLED_START_PAGE_ID_PREFIX = 'page-canvink-example-start-here-v2-';

/** Whether a page id marks the bundled start page, of an older install or a newer one. */
export function isBundledStartPageId(pageId: string): boolean {
  return pageId === BUNDLED_START_PAGE_ID || pageId.startsWith(BUNDLED_START_PAGE_ID_PREFIX);
}
/**
 * The English sample of installs made before the German one. `findBundledStartPage` still
 * recognizes their start page by these titles and texts when it has lost its id marker.
 */
const LEGACY_EXAMPLES_SECTION_TITLE = 'Examples';
const LEGACY_START_PAGE_TITLE = 'Start here';
const LEGACY_START_PAGE_HEADING = 'Welcome to Canvink';
const LEGACY_START_PAGE_INTRO =
  'A calm, local-first place for handwriting, notes, images, and PDFs. Pick a tool above and make this page yours.';

interface SampleText {
  notebook: string;
  notesSection: string;
  examplesSection: string;
  templatesSection: string;
  quickNotePage: string;
  startPageTitle: string;
  startPageHeading: string;
  startPageIntro: string;
  startPageTip: string;
  ideasPage: string;
  ideasHeading: string;
  ideasList: string;
  meetingPage: string;
  meetingBody: string;
}

/** Terse Swiss German, named as OneNote names its own starter content. */
const SAMPLE_TEXT: Record<Language, SampleText> = {
  de: {
    notebook: 'Notizbuch',
    notesSection: 'Notizen',
    examplesSection: 'Beispiele',
    templatesSection: 'Vorlagen',
    quickNotePage: 'Schnelle Notizen',
    startPageTitle: 'Hier starten',
    startPageHeading: 'Willkommen bei Canvink',
    startPageIntro: 'Stift, Text, Bilder und PDFs an einem Ort. Wähle oben ein Werkzeug.',
    startPageTip: 'Alles wird automatisch auf diesem Gerät gespeichert.',
    ideasPage: 'Ideen',
    ideasHeading: 'Ideen',
    ideasList: '• Bild einfügen\n• PDF beschriften\n• Skizzieren ohne Seitenformat',
    meetingPage: 'Besprechung',
    meetingBody: 'Datum:\nTeilnehmende:\n\nBeschlüsse\n\nNächste Schritte',
  },
  en: {
    notebook: 'My notebook',
    notesSection: 'Notes',
    examplesSection: LEGACY_EXAMPLES_SECTION_TITLE,
    templatesSection: 'Templates',
    quickNotePage: 'Quick note',
    startPageTitle: LEGACY_START_PAGE_TITLE,
    startPageHeading: LEGACY_START_PAGE_HEADING,
    startPageIntro: LEGACY_START_PAGE_INTRO,
    startPageTip: 'Tip: your changes save automatically on this device.',
    ideasPage: 'Ideas',
    ideasHeading: 'Loose ideas',
    ideasList: '• Drop an image\n• Annotate a PDF\n• Sketch without choosing a page size',
    meetingPage: 'Meeting notes',
    meetingBody: 'Date:\nParticipants:\n\nDecisions\n\nNext steps',
  },
};

function timestamp(): string {
  return new Date().toISOString();
}

function textElement(
  text: string,
  x: number,
  y: number,
  overrides: Partial<TextElement> = {},
): TextElement {
  const now = timestamp();
  return {
    id: createId('text'),
    kind: 'text',
    x,
    y,
    width: 500,
    height: 88,
    text,
    color: '#1e2925',
    fontSize: 22,
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontWeight: 500,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function linePoints(): InkPoint[] {
  const base = Date.now();
  return [
    { x: 94, y: 342, pressure: 0.3, tiltX: 0, tiltY: 0, time: base, pointerType: 'pen' },
    { x: 155, y: 350, pressure: 0.48, tiltX: 0, tiltY: 0, time: base + 8, pointerType: 'pen' },
    { x: 230, y: 338, pressure: 0.62, tiltX: 0, tiltY: 0, time: base + 16, pointerType: 'pen' },
    { x: 308, y: 344, pressure: 0.44, tiltX: 0, tiltY: 0, time: base + 24, pointerType: 'pen' },
  ];
}

function page(title: string, mode: Page['mode'], elements: Page['elements']): Page {
  const now = timestamp();
  return {
    id: createId('page'),
    title,
    mode,
    createdAt: now,
    updatedAt: now,
    elements,
  };
}

function section(title: string, pages: Page[]): Section {
  const now = timestamp();
  return {
    id: createId('section'),
    title,
    createdAt: now,
    updatedAt: now,
    pages,
  };
}

/** The starter workspace, in the language chosen when it is created; existing ones never change. */
export function createDefaultWorkspace(language: Language = loadLanguagePreference()): WorkspaceState {
  const text = SAMPLE_TEXT[language];
  const now = timestamp();
  const quickNotePage = page(text.quickNotePage, 'free', []);
  const welcomePage = {
    ...page(text.startPageTitle, 'free', [
      textElement(text.startPageHeading, 92, 88, {
        width: 650,
        height: 70,
        fontSize: 42,
        fontWeight: 700,
      }),
      textElement(
        text.startPageIntro,
        96,
        172,
        {
          width: 630,
          height: 110,
          color: '#53615b',
          fontSize: 20,
          fontWeight: 400,
        },
      ),
      {
        id: createId('stroke'),
        kind: 'stroke',
        tool: 'pen',
        x: 0,
        y: 0,
        points: linePoints(),
        color: '#d7653b',
        size: 7,
        opacity: 1,
        createdAt: now,
        updatedAt: now,
      },
      textElement(text.startPageTip, 96, 388, {
        width: 540,
        height: 52,
        fontSize: 17,
        color: '#53615b',
        fontWeight: 400,
      }),
    ]),
    id: createId(BUNDLED_START_PAGE_ID_PREFIX.slice(0, -1)),
  };
  const ideasPage = page(text.ideasPage, 'free', [
    textElement(text.ideasHeading, 72, 68, {
      fontSize: 34,
      fontWeight: 700,
      width: 500,
      height: 58,
    }),
    textElement(text.ideasList, 78, 154, {
      width: 560,
      height: 170,
      fontSize: 20,
      fontWeight: 400,
      color: '#53615b',
    }),
  ]);
  const meetingPage = page(text.meetingPage, 'a4', [
    textElement(text.meetingPage, 72, 76, {
      fontSize: 34,
      fontWeight: 700,
      width: 600,
      height: 58,
    }),
    textElement(text.meetingBody, 74, 156, {
      width: 640,
      height: 360,
      fontSize: 18,
      fontWeight: 400,
      color: '#53615b',
    }),
  ]);
  const notesSection = section(text.notesSection, [quickNotePage]);
  const examplesSection = section(text.examplesSection, [welcomePage, ideasPage]);
  const templatesSection = section(text.templatesSection, [meetingPage]);
  const notebook = {
    id: createId('notebook'),
    title: text.notebook,
    color: '#d7653b',
    createdAt: now,
    updatedAt: now,
    sections: [notesSection, examplesSection, templatesSection],
  };

  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    updatedAt: now,
    notebooks: [notebook],
    trash: [],
    activeNotebookId: notebook.id,
    activeSectionId: notesSection.id,
    activePageId: quickNotePage.id,
  };
}

export function findBundledStartPage(workspace: WorkspaceState): ActiveContext | null {
  for (const notebook of workspace.notebooks) {
    for (const section of notebook.sections) {
      const markedPage = section.pages.find(
        (candidate) => isBundledStartPageId(candidate.id),
      );
      if (markedPage) {
        return { notebook, section, page: markedPage };
      }
    }
  }

  for (const notebook of workspace.notebooks) {
    const section = notebook.sections.find(
      (candidate) => candidate.title === LEGACY_EXAMPLES_SECTION_TITLE,
    );
    const legacyPage = section?.pages.find(
      (candidate) =>
        candidate.title === LEGACY_START_PAGE_TITLE &&
        [LEGACY_START_PAGE_HEADING, LEGACY_START_PAGE_INTRO].every(
          (signature) =>
            candidate.elements.some(
              (element) =>
                element.kind === 'text' &&
                element.text.trim() === signature,
            ),
        ),
    );
    if (section && legacyPage) {
      return { notebook, section, page: legacyPage };
    }
  }

  return null;
}
