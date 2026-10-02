import { Lock } from 'lucide-react';
import { useI18n } from '../../i18n';

/**
 * Shown in the title bar while the open notebook can only be read by this account: a notebook that
 * was shared with the "Lesen" role. Its text says what still works, for people who look for the
 * tools that are off.
 */
export default function ReadOnlyBadge() {
  const { t } = useI18n();
  return (
    <span className="read-only-badge" role="status" title={t('collab.readOnly.hint')} data-read-only-badge="true">
      <Lock size={12} aria-hidden="true" />
      <span>{t('collab.readOnly.badge')}</span>
      <span className="sr-only">{t('collab.readOnly.hint')}</span>
    </span>
  );
}
