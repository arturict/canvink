import type { TranslationKey } from './catalog';
import { isLanguage, translate, type Language, type TranslationParameters } from './core';
import { languageFromBrowser, loadLanguagePreference } from './preference';

/**
 * The language in effect outside React: `<html lang>` (kept current by
 * `I18nProvider`), else the stored choice, else the browser language. Workers
 * have no document and no storage and fall back to the browser language.
 */
export function currentLanguage(): Language {
  if (typeof document !== 'undefined' && isLanguage(document.documentElement.lang)) {
    return document.documentElement.lang;
  }
  return typeof window === 'undefined' ? languageFromBrowser() : loadLanguagePreference();
}

/** Translates for code that runs outside components, such as thrown user-facing errors. */
export function translateNow(key: TranslationKey, parameters?: TranslationParameters): string {
  return translate(currentLanguage(), key, parameters);
}
