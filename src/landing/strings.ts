import type { Language } from '../i18n/core';

/**
 * The landing page's own words. They live here and not in the app catalog so
 * the landing chunk stays small and the two can be edited independently; the
 * language itself is shared with the app through its stored preference.
 */
const de = {
  'meta.title': 'Canvink: ein Notizbuch wie OneNote, ohne das Warten',
  'meta.description':
    'Canvink ist ein offenes, lokales Notizbuch für Handschrift, Text, Bilder und PDFs, aufgebaut wie OneNote, mit Live-Zusammenarbeit.',

  'nav.home': 'Canvink, Startseite',
  'nav.main': 'Hauptnavigation',
  'nav.collab': 'Zusammenarbeit',
  'nav.speed': 'Tempo',
  'nav.download': 'Download',
  'nav.open': 'Im Browser öffnen',
  'lang.label': 'Sprache',

  'hero.eyebrow': 'Open Source · lokal · offline',
  'hero.title.a': 'Ein Notizbuch wie OneNote.',
  'hero.title.b': 'Ohne das Warten.',
  'hero.lede':
    'Notizbücher, Abschnitte und Seiten. Handschrift, Text, Bilder und PDF-Ausdrucke auf einer Seite. Alles liegt lokal auf deinem Gerät, und eine schwere Seite öffnet in unseren Messungen in 0,3 Sekunden.',
  'hero.open': 'Im Browser öffnen',
  'hero.windows': 'Für Windows laden',
  'hero.fineprint': 'Anmelden oder direkt loslegen. Ohne Anmeldung speichert Canvink nur in diesem Browser.',
  'hero.clip':
    'Ein Schulnotizbuch in Canvink: Notizbuchwechsler, farbige Abschnitte und Seitenliste wie in OneNote, eine Seite mit Handschrift, Bild und PDF-Ausdruck. Abschnitte und Seiten wechseln sofort.',
  'hero.caption': 'Ein importiertes Schulnotizbuch: Abschnitte, Seitenliste, Handschrift, Bild und PDF-Ausdruck. Jeder Wechsel ist sofort da.',

  'collab.eyebrow': 'Zusammenarbeit',
  'collab.title': 'Live auf derselben Seite.',
  'collab.p1': 'Wer gerade da ist, steht als Avatar in der Titelleiste. Ein Klick springt zu dieser Person, auch auf eine andere Seite.',
  'collab.p2': 'Striche erscheinen bei den anderen, während sie entstehen, mit dem Namen daneben.',
  'collab.p3': 'Teilen per Link. Wer ihn öffnet, schreibt mit.',
  'collab.p4': 'Offline weiterschreiben; beim Wiederverbinden wird zusammengeführt.',
  'collab.clip':
    'Zwei Personen auf einem Notizbuch: Anna klickt auf Bens Avatar, springt zu seiner Seite und sieht seinen Strich live entstehen.',
  'collab.caption': 'Anna klickt auf Bens Avatar und sieht seinen Strich entstehen.',

  'speed.eyebrow': 'Tempo',
  'speed.title': 'Schnell, auch wenn das Notizbuch gross ist.',
  'speed.lede': 'Canvink lädt eine Seite erst, wenn du sie öffnest, und sucht in einem lokalen Index.',
  'speed.m1.value': '0,3',
  'speed.m1.text': 'bis eine besonders schwere Seite offen ist',
  'speed.m2.value': '1,6',
  'speed.m2.text': 'bis ein PDF mit 300 Seiten seine erste Seite zeigt',
  'speed.m3.value': '0,05',
  'speed.m3.text': 'bis die erste Suche antwortet',
  'speed.unit': 's',
  'speed.fineprint': 'In unseren Messungen; die Werte hängen vom Gerät ab.',

  'ink.title': 'Stift und Lasso.',
  'ink.text': 'Die Tinte folgt dem Stift ohne spürbare Verzögerung. Die Stifttasten lassen sich mit Radierer oder Lasso belegen.',
  'ink.clip': 'Schnelle Stiftstriche schreiben das Wort IDEE, dann wählt ein Lasso einen Stern aus und verschiebt ihn.',
  'markdown.title': 'Text und Markdown.',
  'markdown.text': '«/» öffnet das Blockmenü, «/h1» setzt eine Überschrift. Kürzel wie «-», «[]» und «>» gehen auch.',
  'markdown.clip': 'Eine Markdown-Seite: Mit /h1 entsteht eine Überschrift, danach Fettschrift, Code und eine Aufgabenliste.',

  'features.eyebrow': 'Was drin ist',
  'features.title': 'Aufgebaut wie OneNote, und ein paar Dinge anders.',
  'features.f1': 'Notizbücher, Abschnitte, Seiten',
  'features.f2': 'Handschrift mit dem Stift',
  'features.f3': 'Text und Markdown',
  'features.f4': 'Bilder und PDF-Ausdrucke',
  'features.f5': 'Suche über alles',
  'features.f6': 'Importiert ganze OneNote-Notizbücher',
  'features.f7': 'Offline',
  'features.f8': 'Open Source, AGPL-3.0',
  'features.f9': 'Web und Windows',
  'features.f10': 'Android-App zum Lesen',

  'download.eyebrow': 'Download',
  'download.title': 'Canvink holen.',
  'download.lede': 'Vier Wege, ein Notizbuch-Format. Zum Ausprobieren brauchst du keine Installation.',
  'download.windows.title': 'Windows',
  'download.windows.text': '64-Bit-Installer. Die App aktualisiert sich selbst.',
  'download.windows.button': 'Canvink für Windows laden',
  'download.windows.fineprint':
    'Der Installer ist noch nicht signiert. Windows fragt beim ersten Start nach: «Weitere Informationen», dann «Trotzdem ausführen».',
  'download.browser.title': 'Im Browser',
  'download.browser.text': 'Anmelden oder direkt loslegen, auf jedem Gerät.',
  'download.browser.button': 'Im Browser öffnen',
  'download.pwa.title': 'Als App installieren',
  'download.pwa.text': 'Eigenes Fenster, Start vom Startbildschirm, läuft auch ohne Netz.',
  'download.pwa.button': 'Jetzt installieren',
  'download.pwa.done': 'Bereits installiert',
  'download.pwa.howto': 'So geht es in deinem Browser',
  'download.pwa.chrome': 'Chrome und Edge: Installieren-Symbol in der Adressleiste, oder Menü, «Installieren».',
  'download.pwa.ios': 'iPhone und iPad (Safari): Teilen, «Zum Home-Bildschirm».',
  'download.pwa.android': 'Android (Chrome): Menü, «App installieren».',
  'download.android.title': 'Android',
  'download.android.text': 'Unterwegs lesen, Text bearbeiten und suchen. Zeichnen geht nur auf Computer und Tablet.',
  'download.android.button': 'APK laden',
  'download.android.fineprint': 'Direkter Download als APK, nicht aus dem Play Store. Android fragt beim ersten Mal, ob der Browser Apps installieren darf.',
  'download.selfhost': 'Lieber selbst betreiben? Canvink läuft auch als Docker-Container,',
  'download.selfhost.link': 'Anleitung auf GitHub',

  'footer.version': 'Version {version}, offene Beta.',
  'footer.links': 'Weitere Links',
  'footer.source': 'Quellcode',
  'footer.licence': 'Lizenz',
  'footer.roadmap': 'Roadmap',
  'footer.feedback': 'Feedback',
};

export type LandingKey = keyof typeof de;

const en: Record<LandingKey, string> = {
  'meta.title': 'Canvink: a notebook like OneNote, without the waiting',
  'meta.description':
    'Canvink is an open, local notebook for handwriting, text, images and PDFs, built like OneNote, with live collaboration.',

  'nav.home': 'Canvink, home',
  'nav.main': 'Main navigation',
  'nav.collab': 'Collaboration',
  'nav.speed': 'Speed',
  'nav.download': 'Download',
  'nav.open': 'Open in browser',
  'lang.label': 'Language',

  'hero.eyebrow': 'Open source · local · offline',
  'hero.title.a': 'A notebook like OneNote.',
  'hero.title.b': 'Without the waiting.',
  'hero.lede':
    'Notebooks, sections and pages. Handwriting, text, images and PDF printouts on one page. Everything stays on your device, and in our measurements a heavy page opens in 0.3 seconds.',
  'hero.open': 'Open in browser',
  'hero.windows': 'Download for Windows',
  'hero.fineprint': 'Sign in or start right away. Without an account Canvink saves in this browser only.',
  'hero.clip':
    'A school notebook in Canvink: notebook switcher, coloured sections and page list like OneNote, a page with handwriting, an image and a PDF printout. Sections and pages switch at once.',
  'hero.caption': 'An imported school notebook: sections, page list, handwriting, an image and a PDF printout. Every switch is instant.',

  'collab.eyebrow': 'Collaboration',
  'collab.title': 'Live on the same page.',
  'collab.p1': 'Whoever is there shows as an avatar in the title bar. One click jumps to that person, even on another page.',
  'collab.p2': 'Strokes appear for the others while they are being drawn, with the name next to them.',
  'collab.p3': 'Share with a link. Whoever opens it writes along.',
  'collab.p4': 'Keep writing offline; changes merge when you reconnect.',
  'collab.clip':
    'Two people on one notebook: Anna clicks Ben’s avatar, jumps to his page and watches his stroke appear live.',
  'collab.caption': 'Anna clicks Ben’s avatar and watches his stroke appear.',

  'speed.eyebrow': 'Speed',
  'speed.title': 'Fast, even when the notebook is big.',
  'speed.lede': 'Canvink loads a page only when you open it and searches a local index.',
  'speed.m1.value': '0.3',
  'speed.m1.text': 'until an especially heavy page is open',
  'speed.m2.value': '1.6',
  'speed.m2.text': 'until a 300-page PDF shows its first page',
  'speed.m3.value': '0.05',
  'speed.m3.text': 'until the first search answers',
  'speed.unit': 's',
  'speed.fineprint': 'In our measurements; the numbers depend on the device.',

  'ink.title': 'Pen and lasso.',
  'ink.text': 'Ink follows the pen without noticeable lag. The pen buttons can be set to eraser or lasso.',
  'ink.clip': 'Quick pen strokes write the word IDEE, then a lasso selects a star and moves it.',
  'markdown.title': 'Text and Markdown.',
  'markdown.text': '“/” opens the block menu, “/h1” makes a heading. Shortcuts like “-”, “[]” and “>” work too.',
  'markdown.clip': 'A Markdown page: /h1 makes a heading, then bold text, code and a task list.',

  'features.eyebrow': 'What is in it',
  'features.title': 'Built like OneNote, with a few things done differently.',
  'features.f1': 'Notebooks, sections, pages',
  'features.f2': 'Handwriting with a pen',
  'features.f3': 'Text and Markdown',
  'features.f4': 'Images and PDF printouts',
  'features.f5': 'Search across everything',
  'features.f6': 'Imports whole OneNote notebooks',
  'features.f7': 'Offline',
  'features.f8': 'Open source, AGPL-3.0',
  'features.f9': 'Web and Windows',
  'features.f10': 'Android app for reading',

  'download.eyebrow': 'Download',
  'download.title': 'Get Canvink.',
  'download.lede': 'Four ways, one notebook format. Trying it needs no installation.',
  'download.windows.title': 'Windows',
  'download.windows.text': '64-bit installer. The app updates itself.',
  'download.windows.button': 'Download for Windows',
  'download.windows.fineprint':
    'The installer is not signed yet. Windows asks on first start: “More info”, then “Run anyway”.',
  'download.browser.title': 'In the browser',
  'download.browser.text': 'Sign in or start right away, on any device.',
  'download.browser.button': 'Open in browser',
  'download.pwa.title': 'Install as an app',
  'download.pwa.text': 'Its own window, starts from the home screen, works without a network.',
  'download.pwa.button': 'Install now',
  'download.pwa.done': 'Already installed',
  'download.pwa.howto': 'How to in your browser',
  'download.pwa.chrome': 'Chrome and Edge: the install icon in the address bar, or menu, “Install”.',
  'download.pwa.ios': 'iPhone and iPad (Safari): Share, “Add to Home Screen”.',
  'download.pwa.android': 'Android (Chrome): menu, “Install app”.',
  'download.android.title': 'Android',
  'download.android.text': 'Read, edit text and search on the go. Drawing stays on computer and tablet.',
  'download.android.button': 'Download APK',
  'download.android.fineprint': 'Direct download as an APK, not from the Play Store. Android asks once whether your browser may install apps.',
  'download.selfhost': 'Prefer to self-host? Canvink also runs as a Docker container,',
  'download.selfhost.link': 'guide on GitHub',

  'footer.version': 'Version {version}, open beta.',
  'footer.links': 'More links',
  'footer.source': 'Source code',
  'footer.licence': 'Licence',
  'footer.roadmap': 'Roadmap',
  'footer.feedback': 'Feedback',
};

export const landingStrings: Record<Language, Record<LandingKey, string>> = { de, en };
