/**
 * Synthetic OneNote desktop exports for tests. Everything here is invented;
 * real notebooks never belong in fixtures.
 */
import type { OneNoteDesktopExportManifest, OneNoteDesktopInkFile } from './exportFormat';

const ONE = 'http://schemas.microsoft.com/office/onenote/2013/onenote';

export const FIXTURE_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

export const FIXTURE_PDF = new TextEncoder().encode('%PDF-1.7\n% synthetic worksheet\n');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A worksheet page: a two-page PDF printout as background, handwriting over it, an attachment icon. */
export function worksheetPageXml(printoutAsset: string, pdfFile: string): string {
  return `<?xml version="1.0"?>
<one:Page xmlns:one="${ONE}" ID="{P1}{1}{B0}" name="Arbeitsblatt Brüche" dateTime="2026-03-02T08:00:00.000Z" lastModifiedTime="2026-03-02T09:30:00.000Z" pageLevel="1" lang="de-CH">
  <one:QuickStyleDef index="0" name="PageTitle" fontColor="automatic" highlightColor="automatic" font="Calibri Light" fontSize="20.0" spaceBefore="0.0" spaceAfter="0.0"/>
  <one:PageSettings RTL="false" color="automatic"><one:PageSize><one:Automatic/></one:PageSize><one:RuleLines visible="true"><one:Horizontal color="#CAEBFD" spacing="12.0"/><one:Vertical color="#CAEBFD" spacing="12.0"/></one:RuleLines></one:PageSettings>
  <one:Title lang="de-CH"><one:OE quickStyleIndex="0"><one:T><![CDATA[Arbeitsblatt Brüche]]></one:T></one:OE></one:Title>
  <one:InsertedFile pathCache="C:\\cache\\0001.bin" pathSource="C:\\Schule\\brueche.pdf" preferredName="brueche.pdf" canvinkFile="${pdfFile}">
    <one:Position x="36.0" y="86.4" z="0"/><one:Size width="60.0" height="60.0"/><one:Printout xpsFileIndex="0"/>
  </one:InsertedFile>
  <one:Image format="png" isPrintOut="true" xpsFileIndex="0" originalPageNumber="0" canvinkAsset="${printoutAsset}">
    <one:Position x="36.0" y="160.0" z="1"/><one:Size width="595.0" height="842.0"/>
  </one:Image>
  <one:Image format="png" isPrintOut="true" xpsFileIndex="0" originalPageNumber="1" canvinkAsset="${printoutAsset}">
    <one:Position x="36.0" y="1010.0" z="2"/><one:Size width="595.0" height="842.0"/>
  </one:Image>
  <one:InkDrawing canvinkInk="i0">
    <one:Position x="120.0" y="300.0" z="3"/><one:Size width="75.0" height="30.0"/>
  </one:InkDrawing>
  <one:InkDrawing canvinkInk="i1">
    <one:Position x="100.0" y="400.0" z="4"/><one:Size width="150.0" height="15.0"/>
  </one:InkDrawing>
</one:Page>`;
}

export const WORKSHEET_INK: OneNoteDesktopInkFile = {
  objects: {
    // 100 × 40 device-independent pixels of handwriting, pressure varies.
    i0: {
      bounds: [1000, 2000, 100, 40],
      strokes: [
        { c: '#1f3a93', a: 255, w: 2, h: 2, hl: false, p: [1000, 2000, 0.3, 1050, 2020, 0.6, 1100, 2040, 0.8] },
        { c: '#1f3a93', a: 255, w: 2, h: 2, hl: false, p: [1000, 2040, 0.5, 1100, 2000, 0.5] },
      ],
    },
    // A yellow highlighter pass.
    i1: {
      bounds: [0, 0, 200, 20],
      strokes: [{ c: '#ffff00', a: 255, w: 3, h: 12, hl: true, p: [0, 10, 0.5, 200, 10, 0.5] }],
    },
  },
};

/** An invented study plan in a table, beside the worksheet's printouts and ink. */
export function studyWorksheetPageXml(printoutAsset: string, pdfFile: string): string {
  return worksheetPageXml(printoutAsset, pdfFile).replace('</one:Page>', `
  <one:TagDef index="0" type="0" symbol="3" name="Aufgabe"/>
  <one:TagDef index="1" type="1" symbol="13" name="Wichtig"/>
  <one:Outline>
    <one:Position x="36.0" y="110.0" z="5"/><one:Size width="400.0" height="50.0"/>
    <one:OEChildren><one:OE><one:Table>
      <one:Row><one:Cell><one:OEChildren>
        <one:OE><one:Tag index="0" completed="false"/><one:Tag index="1"/><one:T><![CDATA[Brüche wiederholen]]></one:T></one:OE>
        <one:OE><one:Tag index="0" completed="true"/><one:T><![CDATA[Beispiel gelöst]]></one:T></one:OE>
      </one:OEChildren></one:Cell></one:Row>
    </one:Table></one:OE></one:OEChildren>
  </one:Outline>
</one:Page>`);
}

/** A text-heavy page: heading, formatted text, lists, a to-do, a table, a flow picture, ink words and a subpage. */
export function notesPageXml(pictureAsset: string): string {
  return `<?xml version="1.0"?>
<one:Page xmlns:one="${ONE}" ID="{P2}{1}{B0}" name="Zusammenfassung" pageLevel="1">
  <one:TagDef index="0" type="0" symbol="3" fontColor="automatic" highlightColor="none" name="Aufgabe"/>
  <one:TagDef index="1" type="1" symbol="13" fontColor="automatic" highlightColor="none" name="Wichtig"/>
  <one:QuickStyleDef index="0" name="PageTitle" font="Calibri Light" fontSize="20.0" spaceBefore="0.0" spaceAfter="0.0"/>
  <one:QuickStyleDef index="1" name="p" fontColor="automatic" font="Calibri" fontSize="11.0" spaceBefore="0.0" spaceAfter="0.0"/>
  <one:QuickStyleDef index="2" name="h1" fontColor="#1e4e79" font="Calibri" fontSize="16.0" spaceBefore="0.0" spaceAfter="0.0"/>
  <one:Title><one:OE quickStyleIndex="0"><one:T><![CDATA[Zusammenfassung &amp; Übungen]]></one:T></one:OE></one:Title>
  <one:Outline>
    <one:Position x="36.0" y="86.4" z="0"/><one:Size width="400.0" height="300.0"/>
    <one:OEChildren>
      <one:OE quickStyleIndex="2"><one:T><![CDATA[Grundlagen]]></one:T></one:OE>
      <one:OE quickStyleIndex="1"><one:T><![CDATA[Ein <span style='font-weight:bold'>Bruch</span> hat <span style='font-style:italic'>Zähler</span> und <span lang=de-CH style='color:#FF0000'>Nenner</span>.<br>Zweite Zeile]]></one:T></one:OE>
      <one:OE quickStyleIndex="1"><one:List><one:Bullet bullet="2" fontSize="11.0"/></one:List><one:T><![CDATA[erweitern]]></one:T>
        <one:OEChildren><one:OE quickStyleIndex="1"><one:List><one:Number numberSequence="0" numberFormat="##." fontSize="11.0" text="1."/></one:List><one:T><![CDATA[mit 2]]></one:T></one:OE></one:OEChildren>
      </one:OE>
      <one:OE quickStyleIndex="1"><one:Tag index="0" completed="true" disabled="false"/><one:Tag index="1"/><one:T><![CDATA[Serie 3 lösen]]></one:T></one:OE>
      <one:OE><one:Table bordersVisible="true"><one:Columns><one:Column index="0" width="100"/><one:Column index="1" width="100"/></one:Columns>
        <one:Row><one:Cell><one:OEChildren><one:OE><one:T><![CDATA[a]]></one:T></one:OE><one:OE><one:T><![CDATA[b]]></one:T></one:OE></one:OEChildren></one:Cell><one:Cell><one:OEChildren><one:OE><one:List><one:Number numberSequence="1" numberFormat="##)" text="a)"/></one:List><one:T><![CDATA[1/2]]></one:T></one:OE></one:OEChildren></one:Cell></one:Row>
      </one:Table></one:OE>
      <one:OE><one:Image format="png" canvinkAsset="${pictureAsset}"><one:Size width="150.0" height="75.0"/></one:Image></one:OE>
      <one:OE><one:InkParagraph><one:InkLine><one:InkWord recognizedText="3/4" canvinkInk="w0"/></one:InkLine></one:InkParagraph></one:OE>
      <one:OE quickStyleIndex="1"><one:T><![CDATA[Nach dem Bild <a href="onenote:#Seite">intern</a> und <a href="https://example.test/bruch">extern</a>]]></one:T></one:OE>
    </one:OEChildren>
  </one:Outline>
  <one:Image format="png" backgroundImage="true" canvinkAsset="${pictureAsset}">
    <one:Position x="-10.0" y="0.0" z="0"/><one:Size width="100.0" height="100.0"/>
  </one:Image>
</one:Page>`;
}

export const NOTES_INK: OneNoteDesktopInkFile = {
  objects: {
    w0: { bounds: [500, 500, 30, 20], strokes: [{ c: '#000000', a: 255, w: 1.5, h: 1.5, hl: false, ip: true, p: [500, 500, 0.5, 530, 520, 0.5] }] },
  },
};

export function subpageXml(): string {
  return `<?xml version="1.0"?>
<one:Page xmlns:one="${ONE}" ID="{P3}{1}{B0}" name="" pageLevel="2">
  <one:Outline><one:Position x="36.0" y="86.4" z="0"/><one:Size width="200.0" height="20.0"/>
    <one:OEChildren><one:OE><one:T><![CDATA[Unterseite]]></one:T></one:OE></one:OEChildren>
  </one:Outline>
</one:Page>`;
}

/** A complete synthetic export as path → bytes, laid out as the PowerShell exporter writes it. */
export async function syntheticDesktopExport(options: { studyWorksheet?: boolean } = {}): Promise<Map<string, Uint8Array>> {
  const encoder = new TextEncoder();
  const pngHash = await sha256Hex(FIXTURE_PNG);
  const pdfHash = await sha256Hex(FIXTURE_PDF);
  const png = `assets/${pngHash}.png`;
  const pdf = `files/${pdfHash}.pdf`;
  const manifest: OneNoteDesktopExportManifest = {
    format: 'canvink-onenote-desktop-export',
    version: 1,
    exportedAt: '2026-09-24T10:00:00.000Z',
    generator: 'fixture',
    notebook: { id: '{NB}{1}{B0}', name: 'Schulheft' },
    sections: [{
      id: '{S1}{1}{B0}',
      name: 'Mathe',
      groupPath: ['Semester 1'],
      color: '#8AA8E4',
      pages: [
        { id: '{P1}{1}{B0}', name: 'Arbeitsblatt Brüche', level: 1, created: '2026-03-02T08:00:00.000Z', modified: '2026-03-02T09:30:00.000Z', file: 'pages/0001.xml', ink: 'ink/0001.json' },
        { id: '{P2}{1}{B0}', name: 'Zusammenfassung', level: 1, created: '2026-03-03T08:00:00.000Z', file: 'pages/0002.xml', ink: 'ink/0002.json' },
        { id: '{P3}{1}{B0}', name: '', level: 2, file: 'pages/0003.xml' },
      ],
    }, {
      id: '{S2}{1}{B0}',
      name: 'Geschützt',
      groupPath: [],
      encrypted: true,
      pages: [{ id: '{P4}{1}{B0}', name: 'Gesperrt', level: 1, error: 'The section is password protected.' }],
    }],
    assets: [
      { path: png, mediaType: 'image/png', bytes: FIXTURE_PNG.byteLength, sha256: pngHash, width: 1, height: 1 },
      { path: pdf, mediaType: 'application/pdf', bytes: FIXTURE_PDF.byteLength, sha256: pdfHash, originalName: 'brueche.pdf' },
    ],
  };
  return new Map<string, Uint8Array>([
    ['manifest.json', encoder.encode(JSON.stringify(manifest))],
    ['pages/0001.xml', encoder.encode((options.studyWorksheet ? studyWorksheetPageXml : worksheetPageXml)(png, pdf))],
    ['ink/0001.json', encoder.encode(JSON.stringify(WORKSHEET_INK))],
    ['pages/0002.xml', encoder.encode(notesPageXml(png))],
    ['ink/0002.json', encoder.encode(JSON.stringify(NOTES_INK))],
    ['pages/0003.xml', encoder.encode(subpageXml())],
    [png, FIXTURE_PNG],
    [pdf, FIXTURE_PDF],
  ]);
}
