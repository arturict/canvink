import { useI18n } from './I18nProvider';
import { SUPPORTED_LANGUAGES, type Language } from './core';

/**
 * The language choice. The label reads "Sprache / Language" in both languages
 * so a reader who ended up in the wrong one can still find it.
 */
export function LanguageSwitcher({ className, visibleLabel = false }: { className?: string; visibleLabel?: boolean }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <label className={className}>
      <span className={visibleLabel ? 'language-switcher__label' : 'sr-only'}>{t('app.language.label')}</span>
      <select
        aria-label={t('app.language.label')}
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        {SUPPORTED_LANGUAGES.map((option) => (
          <option key={option} value={option}>{t(`app.language.${option}`)}</option>
        ))}
      </select>
    </label>
  );
}
