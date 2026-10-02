/** Speicher: what the account holds and how much of each quota is used. */

import { useI18n, type TranslationKey } from '../../i18n';
import type { SpaceDescriptor } from '../../personal-space';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** "338 MB", "1.4 GB": whole numbers from 100 up, one decimal below, like the file manager. */
export function friendlySize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

function Meter({ label, count, used, total }: { label: string; count: string; used: number; total: number }) {
  const { t } = useI18n();
  const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="account-dialog__meter">
      <div className="account-dialog__meter-head">
        <strong>{label}</strong>
        <span>{count}</span>
      </div>
      {total > 0 ? (
        <>
          <span
            className="account-dialog__meter-bar"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-high={percent >= 90 ? 'true' : undefined}
          >
            <span style={{ width: `${percent}%` }} />
          </span>
          <small>{t('account.storage.ofQuota', { used: friendlySize(used), total: friendlySize(total) })}</small>
        </>
      ) : (
        <small>{friendlySize(used)}</small>
      )}
    </div>
  );
}

export default function AccountStorageTab({ descriptor }: { descriptor: SpaceDescriptor | null }) {
  const { t, plural } = useI18n();
  if (!descriptor) {
    return <p className="account-dialog__hint">{t('account.storage.unavailable')}</p>;
  }
  const count = (n: number, one: TranslationKey, other: TranslationKey, size = '') =>
    plural(n, { one, other }, { size });
  return (
    <section className="account-dialog__section" aria-labelledby="account-storage-title">
      <h3 id="account-storage-title" className="sr-only">{t('account.tab.storage')}</h3>
      <p className="account-dialog__headline">
        {count(descriptor.docCount, 'account.storage.summary.one', 'account.storage.summary', friendlySize(descriptor.logBytes + descriptor.assetBytes))}
      </p>
      <Meter
        label={t('account.storage.documents')}
        count={count(descriptor.docCount, 'account.storage.documentsCount.one', 'account.storage.documentsCount')}
        used={descriptor.logBytes}
        total={descriptor.quota.logBytes}
      />
      <Meter
        label={t('account.storage.files')}
        count={count(descriptor.assetCount, 'account.storage.filesCount.one', 'account.storage.filesCount')}
        used={descriptor.assetBytes}
        total={descriptor.quota.assetBytes}
      />
    </section>
  );
}
