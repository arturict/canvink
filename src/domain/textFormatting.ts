import type { TextElement } from './types';

export function formattedText(element: TextElement): string {
  if (!element.listStyle || element.listStyle === 'none') return element.text;

  return element.text
    .split('\n')
    .map((line, index) => {
      if (!line.trim()) return '';
      return element.listStyle === 'bullet'
        ? `• ${line}`
        : `${index + 1}. ${line}`;
    })
    .join('\n');
}
