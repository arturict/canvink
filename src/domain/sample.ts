import { createId } from './ids';
import {
  WORKSPACE_SCHEMA_VERSION,
  type InkPoint,
  type Page,
  type Section,
  type TextElement,
  type WorkspaceState,
} from './types';

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

export function createDefaultWorkspace(): WorkspaceState {
  const now = timestamp();
  const quickNotePage = page('Quick note', 'free', []);
  const welcomePage = page('Start here', 'free', [
    textElement('Welcome to Canvink', 92, 88, {
      width: 650,
      height: 70,
      fontSize: 42,
      fontWeight: 700,
    }),
    textElement(
      'A calm, local-first place for handwriting, notes, images, and PDFs. Pick a tool above and make this page yours.',
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
    textElement('Tip: your changes save automatically on this device.', 96, 388, {
      width: 540,
      height: 52,
      fontSize: 17,
      color: '#53615b',
      fontWeight: 400,
    }),
  ]);
  const ideasPage = page('Ideas', 'free', [
    textElement('Loose ideas', 72, 68, {
      fontSize: 34,
      fontWeight: 700,
      width: 500,
      height: 58,
    }),
    textElement('• Drop an image\n• Annotate a PDF\n• Sketch without choosing a page size', 78, 154, {
      width: 560,
      height: 170,
      fontSize: 20,
      fontWeight: 400,
      color: '#53615b',
    }),
  ]);
  const meetingPage = page('Meeting notes', 'a4', [
    textElement('Meeting notes', 72, 76, {
      fontSize: 34,
      fontWeight: 700,
      width: 600,
      height: 58,
    }),
    textElement('Date:\nParticipants:\n\nDecisions\n\nNext steps', 74, 156, {
      width: 640,
      height: 360,
      fontSize: 18,
      fontWeight: 400,
      color: '#53615b',
    }),
  ]);
  const notesSection = section('Notes', [quickNotePage]);
  const examplesSection = section('Examples', [welcomePage, ideasPage]);
  const templatesSection = section('Templates', [meetingPage]);
  const notebook = {
    id: createId('notebook'),
    title: 'My notebook',
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
