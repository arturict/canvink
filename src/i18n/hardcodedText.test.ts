import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { de, en } from './catalog';

/**
 * Regression guard for the translation work: user-visible text has to go
 * through the catalog (`t('key')`), so a string typed straight into JSX or a
 * user-facing prop, and a German literal anywhere in the source, fails here.
 *
 * To add text that is meant to stay as written (a brand name, a data
 * dictionary keyed by German text), add it to an allowlist below with the
 * reason; do not add real UI copy.
 */

// Every app source file as text. The landing page owns its own DE/EN copy;
// tests, fixtures and the catalog itself are not UI.
const SOURCES = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../landing/**', '!../**/*.test.{ts,tsx}', '!../**/fixtures.ts', '!../i18n/catalog.ts', '!../i18n/notebookSettingsCatalog.ts'],
  { query: '?raw', import: 'default', eager: true },
);
// Imported by nothing; its English strings are dead code, not UI.
const UNUSED_FILES = new Set(['editor/CanvasEditor.tsx']);
// Messages whose braces are literal tokens the user types, not placeholders.
const LITERAL_TOKEN_KEYS = new Set(['templates.useAsTemplate.hint']);
const USER_FACING_PROPS = new Set([
  'title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'label',
  'aria-roledescription', 'aria-valuetext',
]);

// Words that are the same in every language: names, units, key caps.
const NEUTRAL_UI_TEXT = new Set([
  'Canvink',
  'Microsoft OneNote',
  'Bytes',
  'Ctrl K',
  'Esc',
  'Mathpix',
  'Compatible / TexTeller',
]);

// German string literals that are data, not UI copy, with the reason.
// file -> literals (exact text). Anything else German fails the test.
const GERMAN_DATA_LITERALS: Readonly<Record<string, readonly string[]>> = {
  // Clerk's German labels, overridden to Swiss usage.
  'auth/ClerkAuthBridge.tsx': ['Noch kein Konto?', 'Schon ein Konto?', 'Mit {{provider|titleize}} anmelden'],
  // Fixture of a sample notebook per language; the German variant is German.
  'domain/sample.ts': [
    'Notizbuch',
    'Stift, Text, Bilder und PDFs an einem Ort. Wähle oben ein Werkzeug.',
    'Alles wird automatisch auf diesem Gerät gespeichert.',
    '• Bild einfügen\n• PDF beschriften\n• Skizzieren ohne Seitenformat',
    'Datum:\nTeilnehmende:\n\nBeschlüsse\n\nNächste Schritte',
  ],
  // The German preset label is the stored preset name; the toolbar translates it by id.
  'editor/LiveCanvasEditor.tsx': ['Blauer Stift'],
  // Search keywords: both languages find a block whatever the UI language is.
  'editor/richText/slashMenu.ts': ['überschrift 1', 'überschrift 2', 'überschrift 3', 'aufzählung'],
  'editor/markdown/markdownCommands.ts': ['linie'],
  // Parsing of OneNote desktop data (German entity names, German section titles).
  'import/onenoteDesktop/inlineHtml.ts': ['ä', 'ö', 'ü', 'Ä', 'Ö', 'Ü'],
  'import/onenoteDesktop/pageXml.ts': ['Datei'],
  'search/normalize.ts': ['und'],
  // Service messages that the panels map to catalog keys by their exact text
  // (statusMessageKeys, MESSAGE_KEYS). The user never sees these strings.
  'components/search/SearchPanel.tsx': ['*'],
  'components/search/searchRuntime.ts': ['*'],
  'components/sync/SyncCollaborationPanel.tsx': ['*'],
  'components/sync/controller.ts': ['*'],
  'components/sync/deviceApproval.ts': ['*'],
  // Defaults for an injected `errors` argument; the dialog always passes translated texts.
  'components/import/OneNoteImportDialog.tsx': [
    'Das ausgewählte OneNote-Notizbuch ist nicht mehr verfügbar.',
    'Wähle mindestens einen Abschnitt aus.',
  ],
};

const GERMAN_WORDS = /(?<![\p{L}])(der|die|das|den|dem|und|oder|nicht|wird|werden|wurde|ist|sind|kein|keine|einen?|mit|für|von|zum|zur|auf|nach|noch|bitte|Seite|Seiten|Abschnitt|Notizbuch|Notiz|Fehler|konnte|Datei|Speichern|Löschen|Abbrechen|Schliessen|Öffnen|Alle|Zurück|Weiter|Fertig|Linie|Farbe|Stift|Gerät|Konto|Freigabe|ungültig|fehlgeschlagen|verfügbar|geladen|Suche|Ansicht|Einfügen|Zeichnen)(?![\p{L}])|[äöüÄÖÜ]/iu;

type Finding = { file: string; line: number; kind: string; text: string };

const isPlainString = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

function scan(): { untranslated: Finding[]; german: Finding[] } {
  const untranslated: Finding[] = [];
  const german: Finding[] = [];
  for (const [key, content] of Object.entries(SOURCES)) {
    const relative = key.replace(/^\.\.\//, '');
    if (UNUSED_FILES.has(relative)) continue;
    const file = relative;
    const source = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (/\p{L}{2}/u.test(text)) untranslated.push({ file: relative, line: at(node), kind: 'JSX text', text });
      } else if (ts.isJsxAttribute(node) && USER_FACING_PROPS.has(node.name.getText()) && node.initializer) {
        const init = node.initializer;
        const literal = isPlainString(init) ? init.text
          : ts.isJsxExpression(init) && isPlainString(init.expression) ? init.expression.text
            : undefined;
        if (literal !== undefined && /\p{L}{2}/u.test(literal)) {
          untranslated.push({ file: relative, line: at(node), kind: node.name.getText(), text: literal });
        }
      }
      const isLiteralPart = isPlainString(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      if (isLiteralPart && !ts.isImportDeclaration(node.parent) && !ts.isLiteralTypeNode(node.parent)
        && GERMAN_WORDS.test(node.text)) {
        german.push({ file: relative, line: at(node), kind: 'German literal', text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { untranslated, german };
}

const describeFinding = (f: Finding) => `${f.file}:${f.line} [${f.kind}] ${f.text.replace(/\s+/g, ' ').slice(0, 100)}`;

describe('i18n regression guard', () => {
  const { untranslated, german } = scan();

  it('keeps user-visible JSX text and props in the catalog', () => {
    const offenders = untranslated.filter((f) => !NEUTRAL_UI_TEXT.has(f.text));
    expect(offenders.map(describeFinding)).toEqual([]);
  });

  it('has no German text outside the catalog except the listed data literals', () => {
    const offenders = german.filter((f) => {
      const allowed = GERMAN_DATA_LITERALS[f.file];
      return !allowed || !(allowed.includes('*') || allowed.includes(f.text));
    });
    expect(offenders.map(describeFinding)).toEqual([]);
  });

  it('lists only allowlist entries that still exist', () => {
    const stale = Object.entries(GERMAN_DATA_LITERALS)
      .filter(([file, literals]) => !literals.includes('*')
        ? literals.some((literal) => !german.some((f) => f.file === file && f.text === literal))
        : !german.some((f) => f.file === file))
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });

  it('uses the same {placeholders} in German and English', () => {
    const placeholders = (message: string) => [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort();
    const mismatched = Object.keys(de).filter((key) => !LITERAL_TOKEN_KEYS.has(key)).filter((key) => {
      const english = (en as Record<string, string>)[key];
      return english !== undefined
        && placeholders(english).join() !== placeholders((de as Record<string, string>)[key]).join();
    });
    expect(mismatched).toEqual([]);
  });

  it('has no German letters in the English catalog', () => {
    const offenders = Object.entries(en).filter(([, message]) => /[äöüÄÖÜß]/.test(message)).map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
