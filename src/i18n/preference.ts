import { isLanguage, type Language } from './core';

export const LANGUAGE_STORAGE_KEY = 'canvink:language:v1';
/** Fallback when the browser reports no language at all. */
export const DEFAULT_LANGUAGE: Language = 'de';

/** German for any `de*` browser language, English for everything else. */
export function languageFromBrowser(
  languages: readonly string[] | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.languages?.length ? navigator.languages : [navigator.language],
): Language {
  const first = languages?.find((tag) => typeof tag === 'string' && tag.length > 0);
  if (!first) return DEFAULT_LANGUAGE;
  return first.toLowerCase().startsWith('de') ? 'de' : 'en';
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadLanguagePreference(
  storage: Storage | null = browserStorage(),
  fallback: Language = languageFromBrowser(),
): Language {
  if (!storage) return fallback;
  try {
    const stored = storage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function saveLanguagePreference(
  language: Language,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Language selection is optional and must never prevent note editing.
  }
}
