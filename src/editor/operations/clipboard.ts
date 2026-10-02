import type { StrokeElementV2 } from '../../domain/v2/types';
import {
  assertGraphElement,
  assertMathElement,
  type MathElementV3,
  type PageElementV3,
} from '../../domain/v3';

export const CLIPBOARD_FORMAT = 'canvink-elements-v1';
export const MAX_CLIPBOARD_ELEMENTS = 1_000;
export const MAX_CLIPBOARD_BYTES = 8 * 1024 * 1024;
export const MAX_CLIPBOARD_NODES = 2_000_000;
export const MAX_CLIPBOARD_POINTS = 200_000;
export const MAX_CLIPBOARD_DEPTH = 64;

interface ClipboardPayload {
  format: typeof CLIPBOARD_FORMAT;
  elements: PageElementV3[];
  zOrder: string[];
}

export function serializeElementsForClipboard(
  elements: Readonly<Record<string, PageElementV3>>,
  selectedIds: readonly string[],
  zOrder: readonly string[],
): string {
  const unique = collectTransitiveSelection(elements, selectedIds);
  if (unique.length === 0 || unique.length > MAX_CLIPBOARD_ELEMENTS) {
    throw new Error('Clipboard selection has an unsupported element count');
  }
  const selected = unique.map((id) => {
    const element = elements[id];
    if (!element) throw new Error(`Clipboard element ${id} does not exist`);
    return element;
  });
  validateElements(selected);
  const selectedZOrder = zOrder.filter((id) => unique.includes(id));
  if (
    selectedZOrder.length !== unique.length ||
    new Set(selectedZOrder).size !== unique.length
  ) {
    throw new Error('Clipboard zOrder must contain every selected element exactly once');
  }
  const payload: ClipboardPayload = {
    format: CLIPBOARD_FORMAT,
    elements: selected,
    zOrder: selectedZOrder,
  };
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error('Clipboard payload exceeds the byte limit');
  }
  return serialized;
}

export function pasteElementsFromClipboard(
  serialized: string,
  createId: (oldId: string, index: number) => string,
  offset = { x: 20, y: 20 },
): { elementsById: Record<string, PageElementV3>; zOrder: string[]; idMap: Record<string, string> } {
  if (new TextEncoder().encode(serialized).byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error('Clipboard payload exceeds the byte limit');
  }
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value) || value.format !== CLIPBOARD_FORMAT || !Array.isArray(value.elements)) {
    throw new Error('Clipboard payload has an unsupported format');
  }
  assertExactKeys(value, ['format', 'elements', 'zOrder'], [], 'Clipboard payload');
  if (!Array.isArray(value.zOrder)) throw new Error('Clipboard zOrder must be an array');
  const elements = value.elements as PageElementV3[];
  validateElements(elements);
  const ids = new Set(elements.map((element) => element.id));
  if (ids.size !== elements.length) throw new Error('Clipboard element IDs must be unique');
  const idMap: Record<string, string> = {};
  const usedIds = new Set<string>();
  elements.forEach((element, index) => {
    const id = createId(element.id, index);
    if (!id || usedIds.has(id)) throw new Error('Pasted element IDs must be unique');
    usedIds.add(id);
    idMap[element.id] = id;
  });
  const elementsById: Record<string, PageElementV3> = {};
  let blockIndex = elements.length;
  elements.forEach((element) => {
    const copy = structuredClone(element);
    copy.id = idMap[element.id];
    copy.frame = { ...copy.frame, x: copy.frame.x + offset.x, y: copy.frame.y + offset.y };
    if (copy.kind === 'stroke' && copy.sourceStrokeId && idMap[copy.sourceStrokeId]) {
      copy.sourceStrokeId = idMap[copy.sourceStrokeId];
    }
    if (copy.kind === 'stroke') {
      copy.points = copy.points.map((point) => ({
        ...point,
        x: point.x + offset.x,
        y: point.y + offset.y,
      }));
    }
    if (copy.kind === 'shape' && copy.points) {
      copy.points = copy.points.map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
      }));
    }
    if (copy.kind === 'richText') {
      copy.content.blocks = copy.content.blocks.map((block) => {
        const blockId = createId(block.id, blockIndex);
        blockIndex += 1;
        if (!blockId || usedIds.has(blockId)) throw new Error('Pasted block IDs must be unique');
        usedIds.add(blockId);
        return { ...block, id: blockId };
      });
    }
    if (copy.kind === 'math') {
      copy.dependencies.dependsOnElementIds = copy.dependencies.dependsOnElementIds.map((sourceId) => {
        const remapped = idMap[sourceId];
        if (!remapped) throw new Error('Clipboard math dependency references an unknown ID');
        return remapped;
      });
      if (copy.rawInk) {
        copy.rawInk.captureFrame = offsetFrame(copy.rawInk.captureFrame, offset);
        const rawIds: Record<string, string> = {};
        for (const stroke of copy.rawInk.sourceStrokes) {
          const rawId = createId(stroke.id, blockIndex);
          blockIndex += 1;
          if (!rawId || usedIds.has(rawId)) throw new Error('Pasted raw-ink IDs must be unique');
          usedIds.add(rawId);
          rawIds[stroke.id] = rawId;
        }
        copy.rawInk.sourceStrokes = copy.rawInk.sourceStrokes.map((stroke) => translateRawStroke(
          stroke,
          rawIds[stroke.id],
          stroke.sourceStrokeId ? rawIds[stroke.sourceStrokeId] : undefined,
          offset,
        ));
      }
    }
    if (copy.kind === 'graph') {
      copy.series = copy.series.map((series) => {
        const sourceMathElementId = idMap[series.sourceMathElementId];
        if (!sourceMathElementId) throw new Error('Clipboard graph series references an unknown ID');
        const seriesId = createId(series.id, blockIndex);
        blockIndex += 1;
        if (!seriesId || usedIds.has(seriesId)) throw new Error('Pasted graph series IDs must be unique');
        usedIds.add(seriesId);
        return { ...series, id: seriesId, sourceMathElementId };
      });
    }
    elementsById[copy.id] = copy;
  });
  const zOrder = value.zOrder.map((id) => {
    if (typeof id !== 'string' || !idMap[id]) throw new Error('Clipboard zOrder references an unknown ID');
    return idMap[id];
  });
  if (zOrder.length !== elements.length || new Set(zOrder).size !== elements.length) {
    throw new Error('Clipboard zOrder must contain every element exactly once');
  }
  return { elementsById, zOrder, idMap };
}

function validateElements(elements: PageElementV3[]): void {
  if (elements.length === 0 || elements.length > MAX_CLIPBOARD_ELEMENTS) {
    throw new Error('Clipboard selection has an unsupported element count');
  }
  let points = 0;
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = elements.map((value) => ({ value, depth: 1 }));
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > MAX_CLIPBOARD_NODES) throw new Error('Clipboard payload has too many values');
    if (depth > MAX_CLIPBOARD_DEPTH) throw new Error('Clipboard payload is nested too deeply');
    if (Array.isArray(current)) {
      for (const child of current) stack.push({ value: child, depth: depth + 1 });
    } else if (isRecord(current)) {
      for (const child of Object.values(current)) stack.push({ value: child, depth: depth + 1 });
    }
  }
  for (const element of elements) {
    if (!isRecord(element) || typeof element.id !== 'string' || !element.id) {
      throw new Error('Clipboard element requires an ID');
    }
    if (!['richText', 'stroke', 'shape', 'image', 'pdf', 'attachment', 'math', 'graph'].includes(element.kind)) {
      throw new Error('Clipboard element kind is unsupported');
    }
    validateElementExactShape(element as unknown as Record<string, unknown>);
    if (
      !isRecord(element.frame) ||
      ![
        element.frame.x,
        element.frame.y,
        element.frame.width,
        element.frame.height,
        element.frame.rotation,
      ].every(Number.isFinite)
    ) {
      throw new Error('Clipboard element frame is malformed');
    }
    if (typeof element.locked !== 'boolean') throw new Error('Clipboard element lock state is malformed');
    if (typeof element.createdAt !== 'string' || typeof element.updatedAt !== 'string') {
      throw new Error('Clipboard element timestamps are malformed');
    }
    if (element.kind === 'stroke') {
      if (!Array.isArray(element.points)) throw new Error('Clipboard stroke points are malformed');
      if (element.tool !== 'pen' && element.tool !== 'highlighter') {
        throw new Error('Clipboard stroke tool is malformed');
      }
      if (
        typeof element.color !== 'string' ||
        !Number.isFinite(element.size) ||
        !Number.isFinite(element.opacity)
      ) {
        throw new Error('Clipboard stroke style is malformed');
      }
      points += element.points.length;
      if (points > MAX_CLIPBOARD_POINTS) throw new Error('Clipboard payload has too many stroke points');
      element.points.forEach((point) => {
        if (
          !isRecord(point) ||
          ![
            point.x,
            point.y,
            point.pressure,
            point.tiltX,
            point.tiltY,
            point.time,
          ].every(Number.isFinite) ||
          typeof point.pointerType !== 'string'
        ) {
          throw new Error('Clipboard stroke point is malformed');
        }
      });
    } else if (element.kind === 'richText') {
      if (
        !isRecord(element.content) ||
        element.content.type !== 'doc' ||
        !Array.isArray(element.content.blocks) ||
        !isRecord(element.style)
      ) {
        throw new Error('Clipboard rich-text element is malformed');
      }
      element.content.blocks.forEach((block) => {
        if (!isRecord(block) || typeof block.id !== 'string' || !block.id) {
          throw new Error('Clipboard rich-text block is malformed');
        }
      });
    } else if (element.kind === 'shape') {
      if (
        !['line', 'arrow', 'rectangle', 'ellipse', 'triangle', 'axes'].includes(
          element.shape,
        ) ||
        typeof element.strokeColor !== 'string' ||
        !Number.isFinite(element.strokeWidth)
      ) {
        throw new Error('Clipboard shape is malformed');
      }
      element.points?.forEach((point) => {
        if (!isRecord(point) || ![point.x, point.y].every(Number.isFinite)) {
          throw new Error('Clipboard shape point is malformed');
        }
      });
    } else if (element.kind === 'image') {
      validateAssetRef(element.asset);
      if (typeof element.alt !== 'string') throw new Error('Clipboard image is malformed');
    } else if (element.kind === 'pdf') {
      validateAssetRef(element.previewAsset);
      if (element.originalAsset) validateAssetRef(element.originalAsset);
      if (!Number.isSafeInteger(element.pageCount) || element.pageCount < 1) {
        throw new Error('Clipboard PDF is malformed');
      }
    } else if (element.kind === 'attachment') {
      validateAssetRef(element.asset);
      if (typeof element.displayName !== 'string') {
        throw new Error('Clipboard attachment is malformed');
      }
    } else if (element.kind === 'math') {
      assertMathElement(element, `Clipboard math element ${element.id}`);
      points += element.rawInk?.sourceStrokes.reduce(
        (total, stroke) => total + stroke.points.length,
        0,
      ) ?? 0;
      if (points > MAX_CLIPBOARD_POINTS) throw new Error('Clipboard payload has too many stroke points');
    } else if (element.kind === 'graph') {
      assertGraphElement(element, `Clipboard graph element ${element.id}`);
    }
  }
  const ids = new Set(elements.map((element) => element.id));
  for (const element of elements) {
    if (element.kind === 'math' && element.dependencies.dependsOnElementIds.some((id) => !ids.has(id))) {
      throw new Error('Clipboard math dependency references an unknown ID');
    }
    if (element.kind === 'graph' && element.series.some((series) => !ids.has(series.sourceMathElementId))) {
      throw new Error('Clipboard graph series references an unknown ID');
    }
  }
}

function collectTransitiveSelection(
  elements: Readonly<Record<string, PageElementV3>>,
  selectedIds: readonly string[],
): string[] {
  const selected = [...new Set(selectedIds)];
  const included = new Set(selected);
  for (let index = 0; index < selected.length; index += 1) {
    const id = selected[index];
    const element = elements[id];
    if (!element) throw new Error(`Clipboard element ${id} does not exist`);
    const referenced = element.kind === 'math'
      ? element.dependencies.dependsOnElementIds
      : element.kind === 'graph'
        ? element.series.map((series) => series.sourceMathElementId)
        : [];
    for (const sourceId of referenced) {
      const source = elements[sourceId];
      if (!source || source.kind !== 'math') {
        throw new Error(`Clipboard element ${id} references missing math element ${sourceId}`);
      }
      if (!included.has(sourceId)) {
        included.add(sourceId);
        selected.push(sourceId);
      }
    }
  }
  if (selected.length > MAX_CLIPBOARD_ELEMENTS) {
    throw new Error('Clipboard selection has an unsupported element count');
  }
  return selected;
}

function offsetFrame(
  frame: MathElementV3['frame'],
  offset: { x: number; y: number },
): MathElementV3['frame'] {
  return { ...frame, x: frame.x + offset.x, y: frame.y + offset.y };
}

function translateRawStroke(
  stroke: StrokeElementV2,
  id: string,
  sourceStrokeId: string | undefined,
  offset: { x: number; y: number },
): StrokeElementV2 {
  return {
    ...stroke,
    id,
    frame: offsetFrame(stroke.frame, offset),
    ...(sourceStrokeId ? { sourceStrokeId } : { sourceStrokeId: undefined }),
    points: stroke.points.map((point) => ({ ...point, x: point.x + offset.x, y: point.y + offset.y })),
  };
}

function validateAssetRef(value: unknown): void {
  assertExactKeys(
    value,
    ['assetId', 'checksum', 'mimeType', 'size', 'role'],
    ['fileName'],
    'Clipboard asset reference',
  );
  if (
    !isRecord(value) ||
    typeof value.assetId !== 'string' ||
    typeof value.checksum !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.role !== 'original' && value.role !== 'preview')
  ) {
    throw new Error('Clipboard asset reference is malformed');
  }
}

const BASE_ELEMENT_KEYS = ['id', 'kind', 'frame', 'createdAt', 'updatedAt', 'locked'] as const;

function validateElementExactShape(element: Record<string, unknown>): void {
  assertExactKeys(element.frame, ['x', 'y', 'width', 'height', 'rotation'], [], 'Clipboard frame');
  switch (element.kind) {
    case 'stroke':
      validateStrokeExactShape(element);
      return;
    case 'richText': {
      assertExactKeys(element, [...BASE_ELEMENT_KEYS, 'content', 'style'], [], 'Clipboard rich-text element');
      const content = exactRecord(element.content, 'Clipboard rich-text document');
      assertExactKeys(content, ['type', 'blocks'], [], 'Clipboard rich-text document');
      if (!Array.isArray(content.blocks)) throw new Error('Clipboard rich-text blocks are malformed');
      for (const blockValue of content.blocks) {
        const block = exactRecord(blockValue, 'Clipboard rich-text block');
        if (block.type === 'table') {
          assertExactKeys(block, ['id', 'type', 'rows'], [], 'Clipboard table block');
          if (!Array.isArray(block.rows)) throw new Error('Clipboard table rows are malformed');
          for (const row of block.rows) {
            if (!Array.isArray(row)) throw new Error('Clipboard table row is malformed');
            for (const cell of row) {
              if (!Array.isArray(cell)) throw new Error('Clipboard table cell is malformed');
              for (const span of cell) validateRichTextSpan(span);
            }
          }
        } else if (block.type === 'checkItem') {
          assertExactKeys(block, ['id', 'type', 'checked', 'spans'], [], 'Clipboard check-item block');
          validateSpanArray(block.spans);
        } else if (block.type === 'paragraph' || block.type === 'heading') {
          assertExactKeys(block, ['id', 'type', 'spans'], ['level', 'list'], 'Clipboard text block');
          validateSpanArray(block.spans);
        } else throw new Error('Clipboard rich-text block type is unsupported');
      }
      assertExactKeys(element.style, ['color', 'fontFamily', 'fontSize', 'textAlign'], [], 'Clipboard rich-text style');
      return;
    }
    case 'shape':
      assertExactKeys(element, [...BASE_ELEMENT_KEYS, 'shape', 'strokeColor', 'strokeWidth'], ['fillColor', 'points'], 'Clipboard shape element');
      if (element.points !== undefined) {
        if (!Array.isArray(element.points)) throw new Error('Clipboard shape points are malformed');
        for (const point of element.points) assertExactKeys(point, ['x', 'y'], [], 'Clipboard shape point');
      }
      return;
    case 'image':
      assertExactKeys(element, [...BASE_ELEMENT_KEYS, 'asset', 'alt'], [], 'Clipboard image element');
      return;
    case 'pdf':
      assertExactKeys(
        element,
        [...BASE_ELEMENT_KEYS, 'previewAsset', 'pageCount', 'sourceAvailability'],
        ['originalAsset', 'sourcePageNumber'],
        'Clipboard PDF element',
      );
      return;
    case 'attachment':
      assertExactKeys(element, [...BASE_ELEMENT_KEYS, 'asset', 'displayName'], [], 'Clipboard attachment element');
      return;
    case 'math': {
      assertExactKeys(
        element,
        [...BASE_ELEMENT_KEYS, 'inputKind', 'autoRecognition', 'recognition', 'result', 'dependencies'],
        ['rawInk', 'typedLatex', 'recognizedLatex', 'correctedLatex'],
        'Clipboard Math element',
      );
      const recognition = exactRecord(element.recognition, 'Clipboard Math recognition');
      assertExactKeys(recognition, ['state', 'alternatives', 'warnings'], ['provider'], 'Clipboard Math recognition');
      if (recognition.provider !== undefined) {
        assertExactKeys(recognition.provider, ['kind'], ['apiVersion', 'modelVersion', 'durationMs'], 'Clipboard Math provider');
      }
      const result = exactRecord(element.result, 'Clipboard Math result');
      assertExactKeys(
        result,
        ['state', 'diagnostics'],
        ['sourceFingerprint', 'engineVersion', 'exactLatex', 'decimalText', 'unit', 'currencyRate'],
        'Clipboard Math result',
      );
      if (result.currencyRate !== undefined) {
        assertExactKeys(
          result.currencyRate,
          ['base', 'quote', 'asOf', 'source', 'status', 'snapshotVersion'],
          [],
          'Clipboard currency rate',
        );
      }
      assertExactKeys(
        element.dependencies,
        ['defines', 'references', 'dependsOnElementIds', 'state'],
        ['sourceFingerprint'],
        'Clipboard Math dependencies',
      );
      if (element.rawInk !== undefined) {
        const rawInk = exactRecord(element.rawInk, 'Clipboard Math raw ink');
        assertExactKeys(rawInk, ['captureFrame', 'sourceStrokes'], [], 'Clipboard Math raw ink');
        assertExactKeys(rawInk.captureFrame, ['x', 'y', 'width', 'height', 'rotation'], [], 'Clipboard Math capture frame');
        if (!Array.isArray(rawInk.sourceStrokes)) throw new Error('Clipboard Math raw strokes are malformed');
        for (const stroke of rawInk.sourceStrokes) validateStrokeExactShape(exactRecord(stroke, 'Clipboard Math raw stroke'));
      }
      return;
    }
    case 'graph': {
      assertExactKeys(element, [...BASE_ELEMENT_KEYS, 'series', 'viewport'], [], 'Clipboard Graph element');
      if (!Array.isArray(element.series)) throw new Error('Clipboard Graph series are malformed');
      for (const series of element.series) {
        assertExactKeys(series, ['id', 'sourceMathElementId', 'color', 'visible'], [], 'Clipboard Graph series');
      }
      assertExactKeys(
        element.viewport,
        ['xMin', 'xMax', 'yMin', 'yMax', 'equalScale', 'axesVisible', 'gridVisible'],
        [],
        'Clipboard Graph viewport',
      );
      return;
    }
    default:
      throw new Error('Clipboard element kind is unsupported');
  }
}

function validateStrokeExactShape(stroke: Record<string, unknown>): void {
  assertExactKeys(
    stroke,
    [...BASE_ELEMENT_KEYS, 'tool', 'points', 'color', 'size', 'opacity'],
    ['tombstonedAt', 'sourceStrokeId'],
    'Clipboard stroke element',
  );
  assertExactKeys(stroke.frame, ['x', 'y', 'width', 'height', 'rotation'], [], 'Clipboard stroke frame');
  if (!Array.isArray(stroke.points)) throw new Error('Clipboard stroke points are malformed');
  for (const point of stroke.points) {
    assertExactKeys(
      point,
      ['x', 'y', 'pressure', 'tiltX', 'tiltY', 'time', 'pointerType'],
      [],
      'Clipboard stroke point',
    );
  }
}

function validateSpanArray(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('Clipboard rich-text spans are malformed');
  for (const span of value) validateRichTextSpan(span);
}

function validateRichTextSpan(value: unknown): void {
  const span = exactRecord(value, 'Clipboard rich-text span');
  assertExactKeys(span, ['text', 'marks'], [], 'Clipboard rich-text span');
  if (!Array.isArray(span.marks)) throw new Error('Clipboard rich-text marks are malformed');
  for (const mark of span.marks) {
    assertExactKeys(mark, ['type'], ['href'], 'Clipboard rich-text mark');
  }
}

function assertExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  const record = exactRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))
  ) throw new Error(`${label} has unsupported fields`);
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
