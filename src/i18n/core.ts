import { catalogs, type TranslationKey } from './catalog';

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export type TranslationParameters = Readonly<Record<string, string | number>>;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value as Language);
}

/**
 * The locale for dates and numbers in the given UI language: Swiss German for
 * German, and for English the browser's own English variant (en-GB, en-AU, ...)
 * so day and month order match what the reader is used to, else en-US.
 */
export function formatLocale(language: string): string {
  if (language === 'de') return 'de-CH';
  const browser = typeof navigator === 'undefined' ? undefined : navigator.language;
  return browser && browser.toLowerCase().startsWith('en') ? browser : 'en-US';
}

export function interpolate(template: string, parameters: TranslationParameters = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    const value = parameters[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function translate(
  language: Language,
  key: TranslationKey,
  parameters?: TranslationParameters,
): string {
  return interpolate(catalogs[language][key], parameters);
}

export function translatePlural(
  language: Language,
  count: number,
  keys: Readonly<{ one: TranslationKey; other: TranslationKey }>,
  parameters: TranslationParameters = {},
): string {
  const category = new Intl.PluralRules(language).select(count);
  return translate(language, category === 'one' ? keys.one : keys.other, {
    ...parameters,
    count,
  });
}

export function catalogKeyDifference(
  reference: Readonly<Record<string, string>>,
  candidate: Readonly<Record<string, string>>,
): { missing: string[]; extra: string[] } {
  const referenceKeys = new Set(Object.keys(reference));
  const candidateKeys = new Set(Object.keys(candidate));
  return {
    missing: [...referenceKeys].filter((key) => !candidateKeys.has(key)).sort(),
    extra: [...candidateKeys].filter((key) => !referenceKeys.has(key)).sort(),
  };
}
