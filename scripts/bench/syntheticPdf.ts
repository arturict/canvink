import { PDFDocument, StandardFonts } from 'pdf-lib';

const LINES = [
  'Aufgabe 1: Bestimme die Nullstellen der Funktion und skizziere den Graphen.',
  'Aufgabe 2: Berechne die Ableitung und pruefe die Extremstellen.',
  'Aufgabe 3: Loese das Gleichungssystem mit dem Additionsverfahren.',
  'Aufgabe 4: Berechne die Wahrscheinlichkeit fuer das Ereignis.',
  'Aufgabe 5: Zeige, dass das Dreieck rechtwinklig ist.',
];

/**
 * A worksheet PDF of `pages` A4 pages with a few lines of text each, as an
 * imported OneNote printout carries. Every document holds one word that no
 * other document has (`pdfwort<index>`), so a search can tell them apart.
 */
export async function syntheticPdf(index: number, pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 0; pageNumber < pages; pageNumber += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Arbeitsblatt ${index + 1} Seite ${pageNumber + 1} pdfwort${index}`, { x: 50, y: 790, size: 14, font });
    LINES.forEach((line, row) => page.drawText(`${line} (${(index * 7 + pageNumber * 3 + row) % 97})`, { x: 50, y: 740 - row * 40, size: 10, font }));
  }
  return document.save({ useObjectStreams: false });
}

/**
 * A solution book of `pages` A4 pages as a scanned-in printout looks to the
 * renderer: about 45 dense lines of text and a few drawings per page (a
 * coordinate grid, a triangle, circles), so neither the text nor the vector
 * work is trivial. Page `n` carries the words `seite<n>` for orientation.
 */
export async function bookPdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.TimesRoman);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (let pageNumber = 0; pageNumber < pages; pageNumber += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Kapitel ${Math.floor(pageNumber / 12) + 1}  Loesungen  seite${pageNumber + 1}`, { x: 50, y: 800, size: 13, font: bold });
    for (let row = 0; row < 45; row += 1) {
      const text = `${row + 1}. ${LINES[(row + pageNumber) % LINES.length]} = ${(pageNumber * 31 + row * 17) % 997}`;
      page.drawText(text, { x: 50 + (row % 3 === 0 ? 0 : 14), y: 776 - row * 9.2, size: 7.5, font });
    }
    const originX = 330;
    const originY = 640;
    for (let step = 0; step <= 10; step += 1) {
      page.drawLine({ start: { x: originX + step * 20, y: originY - 100 }, end: { x: originX + step * 20, y: originY + 100 }, thickness: 0.3 });
      page.drawLine({ start: { x: originX, y: originY - 100 + step * 20 }, end: { x: originX + 200, y: originY - 100 + step * 20 }, thickness: 0.3 });
    }
    page.drawCircle({ x: 140, y: 620, size: 40 + (pageNumber % 20), borderWidth: 1 });
    page.drawRectangle({ x: 60, y: 480, width: 120, height: 70, borderWidth: 1 });
    page.drawLine({ start: { x: 60, y: 480 }, end: { x: 180, y: 550 }, thickness: 1.2 });
  }
  return document.save({ useObjectStreams: false });
}
