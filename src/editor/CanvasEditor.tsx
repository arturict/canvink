import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type Konva from 'konva';
import {
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Path,
  Rect,
  Stage,
  Text as KonvaText,
  Transformer,
} from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { createId } from '../domain/ids';
import { MAX_POINTS_PER_STROKE, MAX_TEXT_CHARS } from '../domain/limits';
import type {
  BrushSettings,
  EditorTool,
  ImageElement,
  InkPoint,
  Page,
  PageElement,
  PdfElement,
  StrokeElement,
} from '../domain/types';
import { accessibleElementSummary } from './accessibility';
import { A4_PAGE, FREE_PAGE } from './constants';
import { getStrokeOutline, strokeToSvgPath } from './ink';

export interface CanvasEditorHandle {
  toPngDataUrl: (pixelRatio?: number) => string;
  dimensions: () => { width: number; height: number };
  editText: (elementId: string) => void;
}

interface CanvasEditorProps {
  page: Page;
  tool: EditorTool;
  brush: BrushSettings;
  selectedElementId: string | null;
  onSelectElement: (elementId: string | null) => void;
  onAddElement: (element: PageElement) => boolean;
  onUpdateElement: (elementId: string, patch: Partial<PageElement>) => void;
  onDeleteElement: (elementId: string) => void;
  onToolChange: (tool: EditorTool) => void;
}

interface CanvasAssetProps {
  element: ImageElement | PdfElement;
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<PageElement>) => void;
}

function useLoadedImage(source: string): HTMLImageElement | undefined {
  const [image, setImage] = useState<HTMLImageElement>();

  useEffect(() => {
    const nextImage = new window.Image();
    nextImage.onload = () => setImage(nextImage);
    nextImage.src = source;
    return () => {
      nextImage.onload = null;
    };
  }, [source]);

  return image;
}

const CanvasAsset = memo(function CanvasAsset({
  element,
  selected,
  selectable,
  onSelect,
  onUpdate,
}: CanvasAssetProps) {
  const source = element.kind === 'image' ? element.dataUrl : element.previewDataUrl;
  const image = useLoadedImage(source);
  const label = element.kind === 'image' ? element.name : `${element.sourceName} · ${element.pageCount}p`;

  const finishTransform = (event: KonvaEventObject<Event>) => {
    const node = event.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    onUpdate({
      x: node.x(),
      y: node.y(),
      width: Math.max(72, element.width * scaleX),
      height: Math.max(72, element.height * scaleY),
    });
  };

  return (
    <Group
      id={`element-${element.id}`}
      elementId={element.id}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      draggable={selectable}
      onClick={selectable ? onSelect : undefined}
      onTap={selectable ? onSelect : undefined}
      onDragEnd={(event) => onUpdate({ x: event.target.x(), y: event.target.y() })}
      onTransformEnd={finishTransform}
    >
      <Rect
        width={element.width}
        height={element.height}
        fill="#ffffff"
        cornerRadius={element.kind === 'pdf' ? 8 : 4}
        shadowColor="#1e2925"
        shadowBlur={selected ? 14 : 6}
        shadowOpacity={selected ? 0.18 : 0.08}
        shadowOffsetY={3}
      />
      {image ? (
        <KonvaImage
          image={image}
          width={element.width}
          height={element.height}
          cornerRadius={element.kind === 'pdf' ? 8 : 4}
        />
      ) : (
        <Rect
          width={element.width}
          height={element.height}
          fill="#ece9df"
          cornerRadius={8}
        />
      )}
      {element.kind === 'pdf' ? (
        <>
          <Rect
            x={0}
            y={element.height - 34}
            width={element.width}
            height={34}
            fill="rgba(30,41,37,.82)"
            cornerRadius={[0, 0, 8, 8]}
          />
          <KonvaText
            x={12}
            y={element.height - 25}
            width={element.width - 24}
            text={label}
            fill="#ffffff"
            fontSize={12}
            ellipsis
          />
        </>
      ) : null}
    </Group>
  );
});

function findElementId(node: Konva.Node | null): string | null {
  let current = node;
  while (current) {
    const value = current.getAttr('elementId');
    if (typeof value === 'string') return value;
    current = current.getParent();
  }
  return null;
}

function sampleFromPointer(event: PointerEvent, rect: DOMRect, scaleX: number, scaleY: number): InkPoint {
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    pressure: event.pressure > 0 ? event.pressure : 0.5,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    time: event.timeStamp,
    pointerType: event.pointerType || 'mouse',
  };
}

function deduplicateSamples(points: InkPoint[]): InkPoint[] {
  const result: InkPoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y || previous.time !== point.time) {
      result.push(point);
    }
  }
  return result;
}

function elementCursor(tool: EditorTool): string {
  if (tool === 'select') return 'default';
  if (tool === 'text') return 'text';
  if (tool === 'eraser') return 'cell';
  return 'crosshair';
}

const CanvasEditor = forwardRef<CanvasEditorHandle, CanvasEditorProps>(function CanvasEditor(
  {
    page,
    tool,
    brush,
    selectedElementId,
    onSelectElement,
    onAddElement,
    onUpdateElement,
    onDeleteElement,
    onToolChange,
  },
  ref,
) {
  const canvasPageRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const inlineTextEditorRef = useRef<HTMLTextAreaElement>(null);
  const canvasDescriptionId = useId();
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const draftPointsRef = useRef<InkPoint[]>([]);
  const draftRef = useRef<StrokeElement | null>(null);
  const erasedDuringGestureRef = useRef(new Set<string>());
  const finishPointerRef = useRef<(event: PointerEvent, cancelled?: boolean) => void>(
    () => undefined,
  );
  const dimensions = page.mode === 'a4' ? A4_PAGE : FREE_PAGE;
  const selectedElement = page.elements.find(
    (element) => element.id === selectedElementId,
  );
  const editingTextElement =
    selectedElement?.kind === 'text' && selectedElement.id === editingTextId
      ? selectedElement
      : null;
  const beginTextEditing = useCallback((elementId: string) => {
    setEditingTextId(elementId);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      toPngDataUrl: (pixelRatio = 2) => {
        const stage = stageRef.current;
        if (!stage) return '';
        const transformer = transformerRef.current;
        const transformerWasVisible = transformer?.visible() ?? false;
        const editingNode = editingTextId
          ? stage.findOne(
              (node: Konva.Node) => node.getAttr('elementId') === editingTextId,
            )
          : undefined;
        const editingNodeWasVisible = editingNode?.visible();
        try {
          transformer?.visible(false);
          editingNode?.visible(true);
          stage.draw();
          return stage.toDataURL({ pixelRatio, mimeType: 'image/png' });
        } finally {
          transformer?.visible(transformerWasVisible);
          if (editingNode && editingNodeWasVisible !== undefined) {
            editingNode.visible(editingNodeWasVisible);
          }
          stage.draw();
        }
      },
      dimensions: () => dimensions,
      editText: beginTextEditing,
    }),
    [beginTextEditing, dimensions, editingTextId],
  );

  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (
      !transformer ||
      !stage ||
      !selectedElementId ||
      tool !== 'select' ||
      editingTextId === selectedElementId
    ) {
      transformer?.nodes([]);
      transformer?.getLayer()?.batchDraw();
      return;
    }

    const selectedNode = stage.findOne(
      (node: Konva.Node) => node.getAttr('elementId') === selectedElementId,
    );
    transformer.nodes(selectedNode ? [selectedNode] : []);
    transformer.getLayer()?.batchDraw();
  }, [editingTextId, page.elements, selectedElementId, tool]);

  useLayoutEffect(() => {
    if (editingTextId && editingTextId === selectedElementId) {
      inlineTextEditorRef.current?.focus();
    }
  }, [editingTextId, selectedElementId]);

  const gridLines = useMemo(() => {
    const lines: Array<{ points: number[]; major: boolean }> = [];
    const spacing = page.mode === 'a4' ? 32 : 40;
    for (let x = spacing; x < dimensions.width; x += spacing) {
      lines.push({ points: [x, 0, x, dimensions.height], major: x % (spacing * 5) === 0 });
    }
    for (let y = spacing; y < dimensions.height; y += spacing) {
      lines.push({ points: [0, y, dimensions.width, y], major: y % (spacing * 5) === 0 });
    }
    return lines;
  }, [dimensions.height, dimensions.width, page.mode]);

  const pointerSamples = (event: PointerEvent): InkPoint[] => {
    const stage = stageRef.current;
    if (!stage) return [];
    const rect = stage.container().getBoundingClientRect();
    const scaleX = dimensions.width / rect.width;
    const scaleY = dimensions.height / rect.height;
    const coalesced =
      typeof event.getCoalescedEvents === 'function' && event.getCoalescedEvents().length > 0
        ? event.getCoalescedEvents()
        : [event];
    return coalesced.map((item) => sampleFromPointer(item, rect, scaleX, scaleY));
  };

  const paintDraft = (stroke: StrokeElement | null) => {
    const canvas = previewCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!stroke) return;
    const pointerIsPen = stroke.points.some((point) => point.pointerType === 'pen');
    const outline = getStrokeOutline(stroke.points, stroke.size, !pointerIsPen);
    if (outline.length < 2) return;
    context.save();
    context.globalAlpha = stroke.opacity;
    context.fillStyle = stroke.color;
    context.beginPath();
    context.moveTo(outline[0][0], outline[0][1]);
    for (const point of outline.slice(1)) {
      context.lineTo(point[0], point[1]);
    }
    context.closePath();
    context.fill();
    context.restore();
  };

  const eraseTarget = (target: Konva.Node | null) => {
    const elementId = findElementId(target);
    if (!elementId || erasedDuringGestureRef.current.has(elementId)) return;
    erasedDuringGestureRef.current.add(elementId);
    onDeleteElement(elementId);
    if (selectedElementId === elementId) onSelectElement(null);
  };

  const handlePointerDown = (event: KonvaEventObject<PointerEvent>) => {
    const nativeEvent = event.evt;
    const stage = stageRef.current;
    if (!stage) return;

    const elementId = findElementId(event.target);
    if (tool === 'select') {
      onSelectElement(elementId);
      return;
    }

    if (tool === 'eraser') {
      erasedDuringGestureRef.current.clear();
      activePointerRef.current = nativeEvent.pointerId;
      eraseTarget(event.target);
      try {
        stage.container().setPointerCapture?.(nativeEvent.pointerId);
      } catch {
        // Window-level pointer completion still closes the gesture.
      }
      nativeEvent.preventDefault();
      return;
    }

    if (tool === 'text') {
      nativeEvent.preventDefault();
      const [point] = pointerSamples(nativeEvent);
      if (!point) return;
      const createdAt = new Date().toISOString();
      const element: PageElement = {
        id: createId('text'),
        kind: 'text',
        x: point.x,
        y: point.y,
        width: 360,
        height: 100,
        text: '',
        color: brush.color,
        fontSize: 22,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontWeight: 400,
        createdAt,
        updatedAt: createdAt,
      };
      if (!onAddElement(element)) return;
      onSelectElement(element.id);
      onToolChange('select');
      beginTextEditing(element.id);
      return;
    }

    if (tool !== 'pen' && tool !== 'highlighter') return;
    nativeEvent.preventDefault();
    activePointerRef.current = nativeEvent.pointerId;
    try {
      stage.container().setPointerCapture?.(nativeEvent.pointerId);
    } catch {
      // Window-level pointer completion still closes the gesture.
    }
    const points = pointerSamples(nativeEvent).slice(0, MAX_POINTS_PER_STROKE);
    draftPointsRef.current = points;
    const createdAt = new Date().toISOString();
    const nextDraft: StrokeElement = {
      id: 'draft-stroke',
      kind: 'stroke',
      tool,
      x: 0,
      y: 0,
      points,
      color: tool === 'highlighter' ? '#f1b654' : brush.color,
      size: tool === 'highlighter' ? Math.max(18, brush.size * 2.8) : brush.size,
      opacity: tool === 'highlighter' ? 0.34 : 1,
      createdAt,
      updatedAt: createdAt,
    };
    draftRef.current = nextDraft;
    paintDraft(nextDraft);
  };

  const handlePointerMove = (event: KonvaEventObject<PointerEvent>) => {
    const nativeEvent = event.evt;
    if (activePointerRef.current !== nativeEvent.pointerId) return;
    nativeEvent.preventDefault();

    if (tool === 'eraser') {
      eraseTarget(event.target);
      return;
    }
    if (tool !== 'pen' && tool !== 'highlighter') return;

    const nextPoints = deduplicateSamples([
      ...draftPointsRef.current,
      ...pointerSamples(nativeEvent),
    ]).slice(0, MAX_POINTS_PER_STROKE);
    draftPointsRef.current = nextPoints;
    if (draftRef.current) {
      draftRef.current = { ...draftRef.current, points: nextPoints };
      paintDraft(draftRef.current);
    }
  };

  const finishPointer = (nativeEvent: PointerEvent, cancelled = false) => {
    if (activePointerRef.current !== nativeEvent.pointerId) return;
    const stage = stageRef.current;
    try {
      if (stage?.container().hasPointerCapture?.(nativeEvent.pointerId)) {
        stage.container().releasePointerCapture(nativeEvent.pointerId);
      }
    } catch {
      // The browser may release capture before the bubbled completion event.
    }

    const draft = draftRef.current;
    if (!cancelled && draft && (tool === 'pen' || tool === 'highlighter')) {
      const completedPoints = deduplicateSamples([
        ...draftPointsRef.current,
        ...pointerSamples(nativeEvent),
      ]).slice(0, MAX_POINTS_PER_STROKE);
      if (completedPoints.length === 1) {
        completedPoints.push({ ...completedPoints[0], x: completedPoints[0].x + 0.01, time: completedPoints[0].time + 1 });
      }
      const completedAt = new Date().toISOString();
      onAddElement({
        ...draft,
        id: createId('stroke'),
        points: completedPoints,
        updatedAt: completedAt,
      });
    }

    activePointerRef.current = null;
    draftPointsRef.current = [];
    erasedDuringGestureRef.current.clear();
    draftRef.current = null;
    paintDraft(null);
  };

  useLayoutEffect(() => {
    finishPointerRef.current = finishPointer;
  });

  useEffect(() => {
    const handlePointerUp = (event: PointerEvent) => finishPointerRef.current(event);
    const handlePointerCancel = (event: PointerEvent) =>
      finishPointerRef.current(event, true);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, []);

  return (
    <div
      ref={canvasPageRef}
      id="page-editor"
      className={`canvas-page canvas-page--${page.mode}`}
      style={{ width: dimensions.width, height: dimensions.height, cursor: elementCursor(tool) }}
      data-page-mode={page.mode}
      data-editor-tool={tool}
      role="region"
      tabIndex={0}
      aria-label={`Canvas editor for ${page.title.trim() || 'Untitled page'}`}
      aria-describedby={canvasDescriptionId}
    >
      <p id={canvasDescriptionId} className="sr-only">
        {page.elements.length === 0
          ? 'This page has no canvas objects.'
          : `${page.elements.length} canvas ${
              page.elements.length === 1 ? 'object' : 'objects'
            }. Use the object selector above to inspect an object.`}
      </p>
      {page.elements.length > 0 ? (
        <ul className="sr-only" aria-label="Canvas objects">
          {page.elements.map((element) => (
            <li key={element.id}>{accessibleElementSummary(element)}</li>
          ))}
        </ul>
      ) : null}
      <Stage
        ref={stageRef}
        width={dimensions.width}
        height={dimensions.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event.evt)}
        onPointerCancel={(event) => finishPointer(event.evt, true)}
      >
        <Layer listening={false}>
          <Rect width={dimensions.width} height={dimensions.height} fill="#fffefa" name="page-bg" />
          {gridLines.map((line, index) => (
            <Line
              key={index}
              points={line.points}
              stroke={line.major ? '#dfe3dc' : '#eef0eb'}
              strokeWidth={line.major ? 0.8 : 0.45}
              listening={false}
            />
          ))}
        </Layer>
        <Layer>
          {page.elements.map((element) => {
            if (element.kind === 'stroke') {
              return (
                <Path
                  key={element.id}
                  id={`element-${element.id}`}
                  elementId={element.id}
                  x={element.x}
                  y={element.y}
                  data={strokeToSvgPath(element)}
                  fill={element.color}
                  opacity={element.opacity}
                  draggable={tool === 'select'}
                  onClick={
                    tool === 'select' ? () => onSelectElement(element.id) : undefined
                  }
                  onTap={
                    tool === 'select' ? () => onSelectElement(element.id) : undefined
                  }
                  onDragEnd={(moveEvent) =>
                    onUpdateElement(element.id, {
                      x: moveEvent.target.x(),
                      y: moveEvent.target.y(),
                    })
                  }
                />
              );
            }

            if (element.kind === 'text') {
              return (
                <KonvaText
                  key={element.id}
                  id={`element-${element.id}`}
                  elementId={element.id}
                  x={element.x}
                  y={element.y}
                  width={element.width}
                  height={element.height}
                  text={element.text}
                  fill={element.color}
                  fontSize={element.fontSize}
                  fontFamily={element.fontFamily}
                  fontStyle={element.fontWeight >= 600 ? 'bold' : 'normal'}
                  lineHeight={1.35}
                  wrap="word"
                  visible={editingTextId !== element.id}
                  draggable={tool === 'select'}
                  onClick={
                    tool === 'select' ? () => onSelectElement(element.id) : undefined
                  }
                  onTap={
                    tool === 'select' ? () => onSelectElement(element.id) : undefined
                  }
                  onDblClick={
                    tool === 'select'
                      ? () => {
                          onSelectElement(element.id);
                          beginTextEditing(element.id);
                        }
                      : undefined
                  }
                  onDblTap={
                    tool === 'select'
                      ? () => {
                          onSelectElement(element.id);
                          beginTextEditing(element.id);
                        }
                      : undefined
                  }
                  onDragEnd={(moveEvent) =>
                    onUpdateElement(element.id, {
                      x: moveEvent.target.x(),
                      y: moveEvent.target.y(),
                    })
                  }
                  onTransformEnd={(transformEvent) => {
                    const node = transformEvent.target;
                    const scaleX = node.scaleX();
                    const scaleY = node.scaleY();
                    node.scaleX(1);
                    node.scaleY(1);
                    onUpdateElement(element.id, {
                      x: node.x(),
                      y: node.y(),
                      width: Math.max(100, element.width * scaleX),
                      height: Math.max(42, element.height * scaleY),
                    });
                  }}
                />
              );
            }

            return (
              <CanvasAsset
                key={element.id}
                element={element}
                selected={element.id === selectedElementId}
                selectable={tool === 'select'}
                onSelect={() => onSelectElement(element.id)}
                onUpdate={(patch) => onUpdateElement(element.id, patch)}
              />
            );
          })}
          <Transformer
            ref={transformerRef}
            visible={tool === 'select'}
            rotateEnabled={false}
            resizeEnabled={selectedElement?.kind !== 'stroke'}
            keepRatio={false}
            flipEnabled={false}
            anchorFill="#fffefa"
            anchorStroke="#d7653b"
            borderStroke="#d7653b"
            anchorCornerRadius={8}
            enabledAnchors={
              selectedElement?.kind === 'stroke'
                ? []
                : [
                    'top-left',
                    'top-right',
                    'bottom-left',
                    'bottom-right',
                    'middle-left',
                    'middle-right',
                  ]
            }
            boundBoxFunc={(oldBox, nextBox) =>
              nextBox.width < 40 || nextBox.height < 30 ? oldBox : nextBox
            }
          />
        </Layer>
      </Stage>
      <canvas
        ref={previewCanvasRef}
        className="ink-preview-layer"
        width={dimensions.width}
        height={dimensions.height}
        aria-hidden="true"
      />
      {editingTextElement ? (
        <textarea
          ref={inlineTextEditorRef}
          className="canvas-inline-text-editor"
          data-testid="canvas-inline-text-editor"
          aria-label="Edit text on page"
          value={editingTextElement.text}
          maxLength={MAX_TEXT_CHARS}
          placeholder="Write your note"
          spellCheck
          style={{
            left: editingTextElement.x,
            top: editingTextElement.y,
            width: editingTextElement.width,
            height: editingTextElement.height,
            color: editingTextElement.color,
            fontSize: editingTextElement.fontSize,
            fontFamily: editingTextElement.fontFamily,
            fontWeight: editingTextElement.fontWeight,
          }}
          onChange={(event) => {
            const availableHeight = Math.max(
              editingTextElement.height,
              dimensions.height - Math.max(0, editingTextElement.y),
            );
            const height = Math.min(
              availableHeight,
              Math.max(editingTextElement.height, event.currentTarget.scrollHeight),
            );
            onUpdateElement(editingTextElement.id, {
              text: event.currentTarget.value,
              height,
            });
          }}
          onBlur={() =>
            setEditingTextId((current) =>
              current === editingTextElement.id ? null : current,
            )
          }
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              setEditingTextId(null);
              canvasPageRef.current?.focus();
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : null}
    </div>
  );
});

export default CanvasEditor;
