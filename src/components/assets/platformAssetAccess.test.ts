import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentAccess } from '../../assets';
import { createPlatformAssetAccess, isPassivePreviewMimeType } from './platformAssetAccess';

const createObjectURL = vi.fn(() => 'blob:verified-attachment');
const revokeObjectURL = vi.fn();
const openWindow = vi.fn<() => Window | null>(() => ({}) as Window);
const click = vi.fn();
const setTimeoutStub = vi.fn(() => 1);

function attachment(mimeType: string): AttachmentAccess {
  return {
    fileName: 'lesson.bin',
    mimeType,
    size: 4,
    bytes: Uint8Array.from([0, 1, 2, 3]),
    disposition: 'open',
  };
}

beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.stubGlobal('window', { open: openWindow, setTimeout: setTimeoutStub });
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({ href: '', download: '', rel: '', click })),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('platform attachment access', () => {
  it('previews only the exact passive allowlist in an isolated window', () => {
    const access = createPlatformAssetAccess();
    for (const mimeType of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'text/plain',
    ]) {
      expect(isPassivePreviewMimeType(mimeType)).toBe(true);
      expect(access.open(attachment(mimeType))).toBe('preview-opened');
    }
    expect(openWindow).toHaveBeenCalledTimes(6);
    expect(openWindow).toHaveBeenCalledWith('blob:verified-attachment', '_blank', 'noopener,noreferrer');
    expect(setTimeoutStub).toHaveBeenCalledTimes(6);
    expect(click).not.toHaveBeenCalled();
  });

  it.each([
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'application/x-msdownload',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/octet-stream',
    'TEXT/PLAIN',
    'text/plain;charset=utf-8',
  ])('routes active or non-canonical %s to metadata-only inspection without touching bytes', (mimeType) => {
    const access = createPlatformAssetAccess();
    expect(isPassivePreviewMimeType(mimeType)).toBe(false);
    expect(access.open(attachment(mimeType))).toBe('inspection-required');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('fails closed when a passive preview popup is blocked and never falls back to download', () => {
    openWindow.mockReturnValueOnce(null);
    const access = createPlatformAssetAccess();
    expect(access.open(attachment('application/pdf'))).toBe('popup-blocked');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:verified-attachment');
    expect(setTimeoutStub).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('downloads active bytes only through the separate explicit download method', () => {
    const access = createPlatformAssetAccess();
    const value = { ...attachment('text/html'), disposition: 'download' as const };
    access.download(value);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
    expect(setTimeoutStub).toHaveBeenCalledTimes(1);
  });
});
