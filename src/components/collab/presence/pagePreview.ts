import type { LivePageDocV2 } from '../../../crdt';
import { drawInkStroke } from '../../../editor/ink';
import { strokeBounds } from '../../../editor/inkGeometry';
import type { PresencePeer, PresencePoint } from '../../../collab/presence';

/** Page units across the round preview when the person's window is unknown. */
export const PREVIEW_DEFAULT_SPAN = 560;
const PREVIEW_MIN_SPAN = 360;
const PREVIEW_MAX_SPAN = 900;
const RULE_COLOR = 'rgba(70, 110, 160, 0.22)';

/** How much page the round preview shows: about what the person's window shows, within limits. */
export function previewSpan(view: PresencePeer['view']): number {
  if (!view) return PREVIEW_DEFAULT_SPAN;
  return Math.min(PREVIEW_MAX_SPAN, Math.max(PREVIEW_MIN_SPAN, Math.min(view.width, view.height)));
}

interface Window {
  x: number;
  y: number;
  size: number;
}

function overlaps(window: Window, x: number, y: number, width: number, height: number): boolean {
  return x < window.x + window.size && x + width > window.x && y < window.y + window.size && y + height > window.y;
}

function drawRuling(ctx: CanvasRenderingContext2D, page: LivePageDocV2, window: Window): void {
  const type = page.background.type;
  if (type === 'plain') return;
  const spacing = page.background.spacing ?? (type === 'millimeter' ? 19 : type === 'grid' ? 28 : 32);
  ctx.strokeStyle = RULE_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const startY = Math.floor(window.y / spacing) * spacing;
  for (let y = startY; y <= window.y + window.size; y += spacing) {
    ctx.moveTo(window.x, y);
    ctx.lineTo(window.x + window.size, y);
  }
  if (type !== 'lined') {
    const startX = Math.floor(window.x / spacing) * spacing;
    for (let x = startX; x <= window.x + window.size; x += spacing) {
      ctx.moveTo(x, window.y);
      ctx.lineTo(x, window.y + window.size);
    }
  }
  ctx.stroke();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawRichText(
  ctx: CanvasRenderingContext2D,
  element: Extract<LivePageDocV2['elementsById'][string], { kind: 'richText' }>,
): void {
  const { fontSize, color, fontFamily } = element.style;
  ctx.font = `${fontSize}px ${fontFamily || 'sans-serif'}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  let y = element.frame.y;
  // Automerge marks a block boundary with an object-replacement character; it is not text.
  for (const paragraph of String(element.text ?? '').replace(/\uFFFC/gu, '\n').split('\n')) {
    for (const line of wrapText(ctx, paragraph, Math.max(40, element.frame.width))) {
      if (y > element.frame.y + Math.max(element.frame.height, fontSize * 2)) return;
      ctx.fillText(line, element.frame.x, y);
      y += fontSize * 1.35;
    }
  }
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  element: Extract<LivePageDocV2['elementsById'][string], { kind: 'shape' }>,
): void {
  const { x, y, width, height } = element.frame;
  ctx.strokeStyle = element.strokeColor;
  ctx.lineWidth = element.strokeWidth;
  ctx.beginPath();
  if (element.shape === 'ellipse') ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (element.shape === 'rectangle') ctx.rect(x, y, width, height);
  else if (element.shape === 'triangle') {
    ctx.moveTo(x + width / 2, y);
    ctx.lineTo(x + width, y + height);
    ctx.lineTo(x, y + height);
    ctx.closePath();
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y + height);
  }
  if (element.fillColor) {
    ctx.fillStyle = element.fillColor;
    ctx.fill();
  }
  ctx.stroke();
}

const NO_IMAGES: ReadonlyMap<string, CanvasImageSource> = new Map();

function drawBox(ctx: CanvasRenderingContext2D, frame: { x: number; y: number; width: number; height: number }): void {
  const { x, y, width, height } = frame;
  ctx.fillStyle = 'rgba(120, 130, 125, 0.14)';
  ctx.strokeStyle = 'rgba(120, 130, 125, 0.4)';
  ctx.lineWidth = 2;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
}

/**
 * Paints the part of a page around `center` as a small static picture:
 * ruling, ink, text, shapes and the pictures of images (grey boxes for files
 * and for images this device does not hold). It is a preview, not the editor:
 * nothing is fetched here and nothing is interactive.
 */
export function drawPagePreview(
  ctx: CanvasRenderingContext2D,
  page: LivePageDocV2 | null,
  center: PresencePoint,
  span: number,
  pixels: number,
  peers: readonly Pick<PresencePeer, 'cursor' | 'ink' | 'user'>[],
  images: ReadonlyMap<string, CanvasImageSource> = NO_IMAGES,
): void {
  const scale = pixels / span;
  const window: Window = { x: center.x - span / 2, y: center.y - span / 2, size: span };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixels, pixels);
  ctx.fillStyle = '#fffefa';
  ctx.fillRect(0, 0, pixels, pixels);
  ctx.scale(scale, scale);
  ctx.translate(-window.x, -window.y);
  if (page) {
    ctx.fillStyle = page.background.color || '#fffefa';
    ctx.fillRect(window.x, window.y, window.size, window.size);
    drawRuling(ctx, page, window);
    for (const id of page.zOrder) {
      const element = page.elementsById[id];
      if (!element) continue;
      ctx.save();
      if (element.kind === 'stroke') {
        if (!element.tombstonedAt) {
          const bounds = strokeBounds(element);
          if (overlaps(window, bounds.x, bounds.y, bounds.width, bounds.height)) drawInkStroke(ctx, element);
        }
      } else if (!('frame' in element) || !overlaps(window, element.frame.x, element.frame.y, element.frame.width, element.frame.height)) {
        // Off the visible part of the page.
      } else if (element.kind === 'richText') drawRichText(ctx, element);
      else if (element.kind === 'shape') drawShape(ctx, element);
      else {
        const assetId = element.kind === 'image' ? element.asset.assetId : element.kind === 'pdf' ? element.previewAsset.assetId : undefined;
        const picture = assetId ? images.get(assetId) : undefined;
        if (picture) ctx.drawImage(picture, element.frame.x, element.frame.y, element.frame.width, element.frame.height);
        else drawBox(ctx, element.frame);
      }
      ctx.restore();
    }
  }
  for (const peer of peers) {
    const ink = peer.ink;
    if (ink && ink.points.length > 1) {
      ctx.strokeStyle = ink.style.color;
      ctx.globalAlpha = ink.style.opacity;
      ctx.lineWidth = ink.style.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ink.points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (peer.cursor) {
      const { x, y } = peer.cursor;
      const unit = 1 / scale;
      ctx.fillStyle = peer.user.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * unit;
      ctx.beginPath();
      ctx.moveTo(x + 1 * unit, y + 1 * unit);
      ctx.lineTo(x + 14 * unit, y + 7 * unit);
      ctx.lineTo(x + 8 * unit, y + 8.5 * unit);
      ctx.lineTo(x + 5.5 * unit, y + 14 * unit);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
