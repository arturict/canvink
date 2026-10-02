import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../i18n';

/** The web app, where the account is managed when this build has no sign-in provider of its own. */
const WEB_APP_URL = 'https://canvink.example.com/app';

export function AccountWebLink() {
  const { t } = useI18n();
  return (
    <a className="account-dialog__link" href={WEB_APP_URL} target="_blank" rel="noreferrer">
      <ExternalLink size={15} aria-hidden="true" />
      {t('account.openWeb')}
    </a>
  );
}
