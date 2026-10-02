export { de, en, catalogs, type TranslationKey } from './catalog';
export {
  SUPPORTED_LANGUAGES,
  catalogKeyDifference,
  interpolate,
  isLanguage,
  translate,
  translatePlural,
  type Language,
  type TranslationParameters,
} from './core';
export { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, languageFromBrowser, loadLanguagePreference, saveLanguagePreference } from './preference';
export { I18nProvider, useI18n } from './I18nProvider';
export { LanguageSwitcher } from './LanguageSwitcher';
export { currentLanguage, translateNow } from './current';
