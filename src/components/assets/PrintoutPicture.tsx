import { useEffect, useRef, useState } from 'react';
import { AssetMissingError } from '../../assets';
import type { LivePageElementV2 } from '../../crdt';
import type { AssetRepository } from '../../assets';
import { useI18n } from '../../i18n';
import { imageSources, type ImageLease } from './imageSourceCache';
import { generateThumbnailLater, holdThumbnailUrl, thumbnails } from './previewThumbnails';
import { DecodedBudget, decodedPictures, fetchPriority, useZone, watchSettled } from './previewViewport';
import { renderZoomedPage, type ZoomedPicture } from './zoomRaster';

type PictureElement = Extract<LivePageElementV2, { kind: 'image' | 'pdf' }>;

export interface PrintoutPictureProps {
  element: PictureElement;
  repository: AssetRepository;
  onError?(message: string): void;
}

interface Shown {
  assetId: string;
  url: string;
}

interface Sharp extends Shown {
  /** The picture has loaded; until then the thumbnail underneath still shows. */
  ready: boolean;
}

/** Below this width a picture is its own thumbnail. */
const THUMBNAIL_WORTHWHILE_WIDTH = 400;
/** Re-rendered pictures are large (a zoomed A4 page is about 50 MB decoded), so only a few are kept. */
const zoomedPictures = new DecodedBudget(200 * 1024 * 1024);
/** A zoomed page is rendered again once it shows this much more than the stored picture has. */
const ZOOM_RERENDER_RATIO = 1.1;
const RETRY_MS = [400, 1_000, 2_500, 5_000];

/**
 * The picture of an image or a printout page.
 *
 * The frame's size comes from the element, so a placeholder, a thumbnail and
 * the sharp picture all fill the same box and nothing moves when a picture
 * arrives. Only near the visible area is the sharp picture read, verified and
 * decoded (in the background, before it is swapped in); in the wider
 * surroundings a small thumbnail stands in; further away nothing is decoded.
 * Sharp pictures that scrolled out of view stay for a while within a memory
 * budget, so scrolling back is instant.
 */
export default function PrintoutPicture({ element, repository, onError }: PrintoutPictureProps) {
  const { t } = useI18n();
  const asset = element.kind === 'image' ? element.asset : element.previewAsset;
  const { assetId, checksum, size, mimeType } = asset;
  const pageNumber = element.kind === 'pdf' ? element.sourcePageNumber ?? 1 : undefined;
  const alt = element.kind === 'image' ? element.alt || t('assets.preview.imageAlt') : t('assets.preview.pdfAlt', { page: pageNumber ?? 1 });
  const [box, setBox] = useState<HTMLElement | null>(null);
  const zone = useZone(box);
  const [sharp, setSharp] = useState<Sharp | null>(null);
  const [thumb, setThumb] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sharpRef = useRef<{ assetId: string; lease: ImageLease } | null>(null);
  const [zoomed, setZoomed] = useState<{ assetId: string; url: string } | null>(null);
  const zoomedRef = useRef<ZoomedPicture | null>(null);
  const originalAsset = element.kind === 'pdf' && element.sourceAvailability === 'original' ? element.originalAsset : null;
  const sourcePage = pageNumber ?? 1;
  const near = zone === 'near';
  const sharpFor = sharp?.assetId === assetId;
  const sharpReady = sharpFor && sharp.ready;

  // Keeps an already decoded picture while it is within the budget; looking at it pins it.
  useEffect(() => {
    decodedPictures.pin(`${assetId}:${element.id}`, near);
  }, [assetId, element.id, near]);

  // The sharp picture, once the page is near.
  useEffect(() => {
    if (!near || sharpRef.current?.assetId === assetId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    void (async () => {
      try {
        const options = { priority: fetchPriority(box), signal: controller.signal };
        const lease = await imageSources.lease(repository, { assetId, checksum, size, mimeType }, options);
        if (controller.signal.aborted) {
          lease.release();
          return;
        }
        const previous = sharpRef.current;
        sharpRef.current = { assetId, lease };
        previous?.lease.release();
        setSharp({ assetId, url: lease.url, ready: false });
        setError(null);
      } catch (reason: unknown) {
        if (controller.signal.aborted) return;
        if (reason instanceof AssetMissingError) {
          // Not on this device and not in the cloud yet (or offline): look again shortly. This is not an error.
          timer = window.setTimeout(() => setRetry((count) => count + 1), RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]);
          return;
        }
        const message = reason instanceof Error ? reason.message : t('assets.preview.openError');
        setError(message);
        onError?.(message);
      }
    })();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [assetId, box, checksum, element.id, mimeType, near, onError, repository, retry, size, t]);

  // The thumbnail, in the wider surroundings and until the sharp picture is there.
  useEffect(() => {
    if (zone === 'far' || sharpReady) return;
    let active = true;
    let held: { url: string; release(): void } | undefined;
    void thumbnails.get(assetId).then((blob) => {
      if (!active || !blob) return;
      held = holdThumbnailUrl(assetId, blob);
      setThumb({ assetId, url: held.url });
    });
    return () => {
      active = false;
      held?.release();
      setThumb(null);
    };
  }, [assetId, sharpReady, zone]);

  // After a zoom has settled, a page that shows more pixels than its stored
  // picture has is rendered again from the original PDF at its size on screen.
  useEffect(() => {
    if (!near || !sharpReady || !box || !originalAsset) return;
    const zoomKey = `${assetId}:${element.id}`;
    zoomedPictures.pin(zoomKey, true);
    let cancelled = false;
    let requested = 0;
    const check = () => {
      const image = box.querySelector<HTMLImageElement>('img[data-quality="sharp"]');
      if (!image || image.naturalWidth === 0) return;
      const needed = Math.ceil(box.getBoundingClientRect().width * (window.devicePixelRatio || 1));
      if (needed <= image.naturalWidth * ZOOM_RERENDER_RATIO) {
        // Back to a size the stored picture serves.
        if (zoomedRef.current) {
          zoomedPictures.remove(zoomKey);
          zoomedRef.current.release();
          zoomedRef.current = null;
          setZoomed(null);
        }
        return;
      }
      if (zoomedRef.current && zoomedRef.current.width >= needed * 0.9) return;
      if (requested >= needed) return;
      requested = needed;
      void renderZoomedPage(repository, originalAsset, sourcePage, needed).then((picture) => {
        if (cancelled) {
          picture.release();
          return;
        }
        const previous = zoomedRef.current;
        zoomedRef.current = picture;
        setZoomed({ assetId, url: picture.url });
        previous?.release();
        zoomedPictures.add(zoomKey, Math.max(1, picture.width * Math.round(picture.width * 1.414) * 4), () => {
          if (zoomedRef.current !== picture) return;
          zoomedRef.current = null;
          picture.release();
          setZoomed(null);
        });
        zoomedPictures.pin(zoomKey, true);
      }, () => undefined);
    };
    const stop = watchSettled(box, check);
    check();
    return () => {
      cancelled = true;
      stop();
      zoomedPictures.pin(zoomKey, false);
    };
  }, [assetId, box, element.id, near, originalAsset, repository, sharpReady, sourcePage]);

  useEffect(() => () => {
    decodedPictures.remove(`${assetId}:${element.id}`);
    sharpRef.current?.lease.release();
    sharpRef.current = null;
    zoomedPictures.remove(`${assetId}:${element.id}`);
    zoomedRef.current?.release();
    zoomedRef.current = null;
  }, [assetId, element.id]);

  const onSharpLoaded = (image: HTMLImageElement) => {
    const held = sharpRef.current;
    if (!held || held.lease.url !== image.currentSrc) return;
    setSharp((current) => (current && current.url === held.lease.url ? { ...current, ready: true } : current));
    const { lease } = held;
    decodedPictures.add(`${assetId}:${element.id}`, Math.max(1, image.naturalWidth * image.naturalHeight * 4), () => {
      if (sharpRef.current?.lease !== lease) return;
      sharpRef.current = null;
      lease.release();
      setSharp(null);
    });
    decodedPictures.pin(`${assetId}:${element.id}`, near);
    if (image.naturalWidth >= THUMBNAIL_WORTHWHILE_WIDTH) {
      void imageSources.blob(repository, { assetId, checksum, size, mimeType }).then((blob) => generateThumbnailLater(assetId, blob), () => undefined);
    }
  };

  if (error) return <span ref={setBox} className="asset-preview-error" role="alert">{t('assets.preview.corrupt')}</span>;
  const state = sharpReady ? 'sharp' : thumb?.assetId === assetId ? 'thumb' : 'placeholder';
  return (
    <span
      ref={setBox}
      className="asset-preview-frame"
      data-preview-state={state}
      data-page={pageNumber}
      aria-busy={state === 'placeholder' ? true : undefined}
    >
      {!sharpReady && thumb?.assetId === assetId ? (
        <img className="asset-preview-image" data-quality="thumb" src={thumb.url} alt={alt} decoding="async" draggable={false} />
      ) : null}
      {sharpFor && sharp ? (
        <img
          className="asset-preview-image"
          data-quality="sharp"
          src={sharp.url}
          alt={alt}
          decoding="async"
          draggable={false}
          onLoad={(event) => onSharpLoaded(event.currentTarget)}
        />
      ) : null}
      {zoomed?.assetId === assetId ? (
        <img className="asset-preview-image" data-quality="zoom" src={zoomed.url} alt={alt} decoding="async" draggable={false} />
      ) : null}
    </span>
  );
}
