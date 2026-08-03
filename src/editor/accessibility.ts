import type { PageElement } from '../domain/types';

const SUMMARY_CHARACTER_LIMIT = 160;
const SUMMARY_CODE_UNIT_LIMIT = 512;
const SUMMARY_SCAN_CODE_UNIT_LIMIT = 4_096;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

function boundedPlainText(value: string): string {
  let source = value.slice(0, SUMMARY_SCAN_CODE_UNIT_LIMIT);
  const finalCodeUnit = source.charCodeAt(source.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    source = source.slice(0, -1);
  }

  let summary = '';
  let characterCount = 0;
  let pendingSpace = false;
  let truncated = source.length < value.length;

  const segments = [...graphemeSegmenter.segment(source)];
  if (truncated) {
    segments.pop();
  }

  for (const { segment } of segments) {
    if (/^\s+$/u.test(segment)) {
      if (characterCount > 0) pendingSpace = true;
      continue;
    }

    const separatorLength = pendingSpace ? 1 : 0;
    const nextCharacterCount = characterCount + separatorLength + 1;
    const nextCodeUnitCount = summary.length + separatorLength + segment.length;
    if (
      nextCharacterCount > SUMMARY_CHARACTER_LIMIT ||
      nextCodeUnitCount > SUMMARY_CODE_UNIT_LIMIT
    ) {
      truncated = true;
      break;
    }

    if (pendingSpace) {
      summary += ' ';
      characterCount += 1;
      pendingSpace = false;
    }
    summary += segment;
    characterCount += 1;
  }

  if (!summary && truncated) return '…';
  return truncated ? `${summary}…` : summary;
}

export function accessibleElementSummary(element: PageElement): string {
  if (element.kind === 'text') {
    const text = boundedPlainText(element.text);
    return text ? `Text: ${text}` : 'Empty text note';
  }
  if (element.kind === 'stroke') {
    const tool = element.tool === 'highlighter' ? 'Highlighter' : 'Pen';
    return `${tool} stroke with ${element.points.length} points`;
  }
  if (element.kind === 'image') {
    const alt = boundedPlainText(element.alt);
    const name = boundedPlainText(element.name);
    return alt
      ? `Image: ${alt}. File: ${name}`
      : `Image without alt text: ${name}`;
  }
  return `PDF preview: ${boundedPlainText(element.sourceName)}, ${element.pageCount} pages`;
}
