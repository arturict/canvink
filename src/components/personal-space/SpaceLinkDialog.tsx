/**
 * P8's first-contact choice (§5.9, §6/decision log P8): shown only when the
 * status is `link-required` AND both sides actually hold data. The notebooks
 * of this device are added to the account, kept only here (nothing changes,
 * nothing is uploaded) or, after a confirmation, discarded for the account's.
 */

import { X } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { SpaceStatus } from '../../personal-space';
import { useConfirm } from '../../ui/ConfirmDialog';

export interface LinkDialogOptions {
  /** True only for `link-required` with `localHasData` and `remoteDocCount > 0` (P8). */
  visible: boolean;
  remoteDocCount: number;
}

/** Pure: whether the dialog should render, and what it needs to render. */
export function linkDialogOptions(status: SpaceStatus): LinkDialogOptions {
  if (status.kind !== 'link-required') return { visible: false, remoteDocCount: 0 };
  return {
    visible: status.localHasData && status.remoteDocCount > 0,
    remoteDocCount: status.remoteDocCount,
  };
}

export interface SpaceLinkDialogProps {
  status: SpaceStatus;
  onAddLocal(): void;
  onKeepLocal(): void;
  /** Called only after the person confirmed. */
  onDiscard(): void;
  onClose(): void;
}

export default function SpaceLinkDialog({
  status,
  onAddLocal,
  onKeepLocal,
  onDiscard,
  onClose,
}: SpaceLinkDialogProps) {
  const { t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  const options = linkDialogOptions(status);
  if (!options.visible) return null;

  const discard = () => {
    void confirm({
      title: t('space.link.discardConfirm.title'),
      message: t('space.link.discardConfirm.message'),
      confirmLabel: t('space.link.discard'),
      danger: true,
    }).then((confirmed) => {
      if (confirmed) onDiscard();
    });
  };

  return (
    <div className="recovery-overlay" role="presentation">
      <section
        className="recovery-card space-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-link-title"
      >
        <button
          type="button"
          className="recovery-card__close"
          aria-label={t('space.link.close')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <h2 id="space-link-title">{t('space.link.title')}</h2>
        <p>{t('space.link.explain')}</p>
        <div className="space-link-dialog__actions">
          <button type="button" onClick={onAddLocal}>
            {t('space.link.addLocal')}
          </button>
          <p className="space-link-dialog__hint">{t('space.link.addLocalHint')}</p>
          <button type="button" onClick={onKeepLocal}>
            {t('space.link.keepLocal')}
          </button>
          <p className="space-link-dialog__hint">{t('space.link.keepLocalHint')}</p>
          <button type="button" onClick={discard}>
            {t('space.link.discard')}
          </button>
          <p className="space-link-dialog__hint">{t('space.link.discardHint')}</p>
        </div>
      </section>
      {confirmElement}
    </div>
  );
}
