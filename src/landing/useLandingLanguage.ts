import { useCallback, useState } from 'react';
import { isLanguage, type Language } from '../i18n/core';
import { LANGUAGE_STORAGE_KEY, saveLanguagePreference } from '../i18n/preference';
import { landingStrings, type LandingKey } from './strings';

/**
 * The browser's preferred language, when nothing has been chosen yet. German
 * is the default for German-speaking browsers; every other browser gets
 * English.
 */
function detectLanguage(): Language {
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    if (tag.toLowerCase().startsWith('de')) return 'de';
    if (tag.toLowerCase().startsWith('en')) return 'en';
  }
  return 'en';
}

function storedLanguage(): Language | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The landing's language: a stored choice wins, else the browser's. Choosing
 * one stores it under the same key the app reads, so the notebook opens in
 * the language picked here.
 */
export function useLandingLanguage(): {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: LandingKey, parameters?: Record<string, string>) => string;
} {
  const [language, setLanguageState] = useState<Language>(() => storedLanguage() ?? detectLanguage());
  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    saveLanguagePreference(next);
  }, []);
  const t = useCallback(
    (key: LandingKey, parameters: Record<string, string> = {}) =>
      landingStrings[language][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => parameters[name] ?? placeholder),
    [language],
  );
  return { language, setLanguage, t };
}
