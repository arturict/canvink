import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { TranslationKey } from './catalog';
import {
  translate,
  translatePlural,
  type Language,
  type TranslationParameters,
} from './core';
import { loadLanguagePreference, saveLanguagePreference } from './preference';

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, parameters?: TranslationParameters) => string;
  plural: (
    count: number,
    keys: Readonly<{ one: TranslationKey; other: TranslationKey }>,
    parameters?: TranslationParameters,
  ) => string;
};

const fallbackContext: I18nContextValue = {
  language: 'de',
  setLanguage: () => undefined,
  t: (key, parameters) => translate('de', key, parameters),
  plural: (count, keys, parameters) => translatePlural('de', count, keys, parameters),
};

const I18nContext = createContext<I18nContextValue>(fallbackContext);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(loadLanguagePreference);
  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    saveLanguagePreference(next);
  }, []);
  const t = useCallback(
    (key: TranslationKey, parameters?: TranslationParameters) => translate(language, key, parameters),
    [language],
  );
  const plural = useCallback(
    (
      count: number,
      keys: Readonly<{ one: TranslationKey; other: TranslationKey }>,
      parameters?: TranslationParameters,
    ) => translatePlural(language, count, keys, parameters),
    [language],
  );

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, t, plural }),
    [language, plural, setLanguage, t],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
