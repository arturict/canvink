import { formatLocale } from '../i18n/core';

/** "Donnerstag, 24. September 2026 um 11:36", the date line under a OneNote page title. */
export function formatPageDate(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return pageDateFormat(formatLocale(language)).format(date);
}

// Building an Intl.DateTimeFormat costs about a millisecond, and the page
// header formats on every render of the notebook shell.
const pageDateFormats = new Map<string, Intl.DateTimeFormat>();

function pageDateFormat(locale: string): Intl.DateTimeFormat {
  let format = pageDateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    pageDateFormats.set(locale, format);
  }
  return format;
}
