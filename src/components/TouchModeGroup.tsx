import { Hand } from 'lucide-react';
import { useI18n, type TranslationKey } from '../i18n';
import { setTouchModePreference, useTouchMode, type TouchModePreference } from '../ui/touchMode';

const CHOICES: ReadonlyArray<{ value: TouchModePreference; labelKey: TranslationKey }> = [
  { value: 'auto', labelKey: 'ribbon.touchMode.auto' },
  { value: 'on', labelKey: 'ribbon.touchMode.on' },
  { value: 'off', labelKey: 'ribbon.touchMode.off' },
];

/** "Touch-Modus" in the Ansicht tab: automatic by default, or forced on or off. */
export function TouchModeGroup() {
  const { t } = useI18n();
  const { preference, active } = useTouchMode();
  return (
    <div className="ribbon-group" role="group" aria-label={t('ribbon.group.touchMode')}>
      <div
        className="touch-mode-choice"
        role="radiogroup"
        aria-label={t('ribbon.touchMode')}
        title={t('ribbon.touchMode.hint')}
        data-active={active ? 'true' : 'false'}
      >
        <Hand size={16} aria-hidden="true" />
        <span className="touch-mode-choice__label">{t('ribbon.touchMode')}</span>
        {CHOICES.map(({ value, labelKey }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={preference === value}
            className="touch-mode-choice__option"
            onClick={() => setTouchModePreference(value)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
