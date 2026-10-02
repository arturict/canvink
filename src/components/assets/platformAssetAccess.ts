import type { AttachmentAccess } from '../../assets';

export interface PlatformAssetAccess {
  open(access: AttachmentAccess): PlatformAssetOpenResult;
  download(access: AttachmentAccess): void;
}

export type PlatformAssetOpenResult =
  | 'preview-opened'
  | 'inspection-required'
  | 'popup-blocked';

const SAFE_PREVIEW_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

export function isPassivePreviewMimeType(mimeType: string): boolean {
  return SAFE_PREVIEW_MIME_TYPES.has(mimeType);
}

function blobUrl(access: AttachmentAccess): string {
  return URL.createObjectURL(new Blob([Uint8Array.from(access.bytes)], { type: access.mimeType }));
}

function download(access: AttachmentAccess): void {
  const url = blobUrl(access);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = access.fileName;
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Browser and Tauri webviews share this passive-byte boundary. No native shell
 * command or executable handler is invoked. Active/unknown types return to the
 * React caller for a metadata-only inspection; bytes are neither rendered nor
 * downloaded until a separate explicit download action.
 */
export function createPlatformAssetAccess(): PlatformAssetAccess {
  return {
    open(access) {
      if (!isPassivePreviewMimeType(access.mimeType)) return 'inspection-required';
      const url = blobUrl(access);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        URL.revokeObjectURL(url);
        return 'popup-blocked';
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return 'preview-opened';
    },
    download,
  };
}
