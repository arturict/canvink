import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, File } from 'lucide-react';
import { accessAttachment, AssetMissingError, type AssetRepository } from '../../assets';
import type { LivePageElementV2 } from '../../crdt';
import { useI18n } from '../../i18n';
import PrintoutPicture from './PrintoutPicture';
import { createPlatformAssetAccess, type PlatformAssetAccess } from './platformAssetAccess';
import { formatLocale } from '../../i18n/core';

type AssetElement = Extract<LivePageElementV2, { kind: 'image' | 'pdf' | 'attachment' }>;

interface PassiveAttachmentInspection {
  assetId: string;
  fileName: string;
  mimeType: string;
  size: number;
  checksum: string;
}

export interface AssetElementPreviewProps {
  element: AssetElement;
  repository: AssetRepository;
  access?: PlatformAssetAccess;
  onError?(message: string): void;
}

export default function AssetElementPreview({
  element,
  repository,
  access = createPlatformAssetAccess(),
  onError,
}: AssetElementPreviewProps) {
  const { language, t } = useI18n();
  const inspectionTitleId = useId();
  const elementAssetId = element.kind === 'pdf' ? element.previewAsset.assetId : element.asset.assetId;
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<PassiveAttachmentInspection | null>(null);
  const visibleInspection = inspection?.assetId === elementAssetId ? inspection : null;

  if (element.kind === 'attachment') {
    const run = async (disposition: 'open' | 'download') => {
      try {
        const result = await accessAttachment(repository, element.asset, disposition);
        if (disposition === 'download') {
          access.download(result);
          return;
        }
        const outcome = access.open(result);
        if (outcome === 'inspection-required') {
          setInspection({
            assetId: element.asset.assetId,
            fileName: result.fileName,
            mimeType: result.mimeType,
            size: result.size,
            checksum: element.asset.checksum,
          });
          setError(null);
        } else if (outcome === 'popup-blocked') {
          const message = t('assets.attachment.popupBlocked');
          setError(message);
          onError?.(message);
        } else {
          setInspection(null);
          setError(null);
        }
      } catch (reason) {
        if (reason instanceof AssetMissingError) {
          setError(t('assets.preview.loading'));
          return;
        }
        const message = reason instanceof Error ? reason.message : t('assets.attachment.openError');
        setError(message);
        onError?.(message);
      }
    };
    return (
      <>
        <div
          className="asset-attachment"
          aria-label={t('assets.attachment.label', { name: element.displayName })}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <File size={24} aria-hidden="true" />
          <strong>{element.displayName}</strong>
          <small>{element.asset.mimeType} · {element.asset.size.toLocaleString(formatLocale(language))} Bytes</small>
          <span>
            <button type="button" onClick={() => void run('open')}><ExternalLink size={13} /> {t('assets.attachment.open')}</button>
            <button type="button" onClick={() => void run('download')}><Download size={13} /> {t('assets.attachment.download')}</button>
          </span>
          {error ? <small role="alert">{error}</small> : null}
        </div>
        {visibleInspection && typeof document !== 'undefined' ? createPortal(
          <div
            className="recovery-overlay"
            role="presentation"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <section className="recovery-card" role="dialog" aria-modal="true" aria-labelledby={inspectionTitleId}>
              <File size={24} aria-hidden="true" />
              <h2 id={inspectionTitleId}>{t('assets.attachment.inspection.title')}</h2>
              <p role="status">{t('assets.attachment.inspection.warning')}</p>
              <dl>
                <dt>{t('assets.attachment.inspection.fileNameLabel')}</dt>
                <dd>{visibleInspection.fileName}</dd>
                <dt>{t('assets.attachment.inspection.mimeTypeLabel')}</dt>
                <dd>{visibleInspection.mimeType}</dd>
                <dt>{t('assets.attachment.inspection.sizeLabel')}</dt>
                <dd>{visibleInspection.size.toLocaleString(formatLocale(language))} Bytes</dd>
                <dt>{t('assets.attachment.inspection.checksumLabel')}</dt>
                <dd><code>{visibleInspection.checksum}</code></dd>
              </dl>
              <div className="recovery-card__actions">
                <button type="button" onClick={(event) => {
                  event.stopPropagation();
                  setInspection(null);
                }}>{t('assets.attachment.inspection.close')}</button>
                <button type="button" onClick={() => void run('download')}><Download size={13} /> {t('assets.attachment.download')}</button>
              </div>
            </section>
          </div>,
          document.body,
        ) : null}
      </>
    );
  }

  return <PrintoutPicture element={element} repository={repository} onError={onError} />;
}
