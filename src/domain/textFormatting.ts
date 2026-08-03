import type { TextElement } from './types';

export function formattedText(element: TextElement): string {
  if (!element.listStyle || element.listStyle === 'none') return element.text;

  let ordinal = 0;
  return element.text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      ordinal += 1;
      return element.listStyle === 'bullet'
        ? `• ${line}`
        : `${ordinal}. ${line}`;
    })
    .join('\n');
}

export function markdownText(element: TextElement): string {
  if (!element.listStyle || element.listStyle === 'none') return element.text;

  let ordinal = 0;
  return element.text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      ordinal += 1;
      return element.listStyle === 'bullet'
        ? `- ${line}`
        : `${ordinal}. ${line}`;
    })
    .join('\n');
}
