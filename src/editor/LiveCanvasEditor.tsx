import { VIEWER_APP } from "../platform/viewerApp";
import { subscribeCaretReveal } from "../ui/keyboardInset";
import type {
  ChangeFn,
} from "@automerge/automerge";
import type {
  ReadonlyDocHandle,
} from "../storage/workspaceV2Runtime";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  BringToFront,
  ClipboardPaste,
  Copy,
  ImageOff,
  Scissors,
  SendToBack,
  Trash2,
  Wallpaper,
} from "lucide-react";
import {
  liveRichTextPath,
  projectLiveRichText,
  type PageAutomergeDoc,
  type LivePageDocV2,
  type LivePageElementV2,
} from "../crdt";
import type {
  RichTextDocument,
  ShapeElementV2,
  StrokeElementV2,
  StrokePointV2,
} from "../domain/v2";
import {
  mathPageSettings,
  type GraphElementV3,
  type MathElementV3,
  type PageElementV3 as PageElementV2,
  type PageDocV3,
} from "../domain/v3";
import {
  useI18n,
  type TranslationKey,
  type TranslationParameters,
} from "../i18n";
import {
  LocalPerformanceRecorder,
  performanceEvidenceBinding,
  type PenPerformanceAcceptanceEvidence,
} from "../performance/metrics";
import {
  recordPenPreviewOnNextFrame,
} from "../performance/penPreview";
import {
  createPortal,
  flushSync,
} from "react-dom";
import RichTextEditor, {
  RichTextToolbarSlotContext,
  type RichTextDocHandle,
  type RichTextWriter,
} from "./richText/RichTextEditor";
import { RICH_TEXT_EDIT_MESSAGE, stampTextEdit } from "./richText/editStamp";
import {
  clampInkSize,
  INK_PALETTE,
  INK_WIDTH_LABELS,
  INK_WIDTHS,
  loadInkStyles,
  saveInkStyles,
  type InkStyle,
  type InkTool,
} from "./penStyles";
import {
  backgroundAt,
  canBecomeBackground,
  isBackgroundElement,
  orderWithBackgrounds,
  reorderElements,
  sameOrder,
  type OrderAction,
} from "./canvasOrder";
import { CanvasContextMenu, type CanvasMenuEntry } from "./CanvasContextMenu";
import {
  createHeldInkShapeElement,
  INK_SHAPE_HOLD_MS,
  recognizeHeldInkShape,
  type HeldInkShapeCandidate,
} from "./inkShapeRecognition";
import "./LiveCanvasEditor.css";
import {
  framesOverlap,
  pathBounds,
  selectByLasso,
  strokeBounds,
  strokesCrossedBy,
  topmostStrokeAt,
} from "./inkGeometry";
import { PEN_THINNING, type InkStroke } from "./ink";
import { InkCommitQueue, onInkLeave } from "./inkCommitQueue";
import { stashUnsavedInk, takeUnsavedInk } from "./unsavedInk";
import { SampleDeduper } from "./inkSampleFilter";
import { LiveStrokePainter } from "./liveStrokePainter";
import { buildPageLayers, InkLayer, type InkRun } from "./InkLayers";
import { measureInkRasterFrame, useInkRaster } from "./inkRaster";
import {
  clearOverlay,
  overlayTransform,
  paintGuide,
  paintLiveInk,
  watchOverlay,
  type OverlayTransform,
} from "./liveInkOverlay";
import { CanvasPresenceLayer } from "./presence/CanvasPresenceLayer";
import type { CanvasPresencePort } from "./presence/types";
import { featureOverrideAllowed } from "../config/featureFlags";
import {
  fixedPaperDimensions,
  paperEdge,
  rulePatternStyle,
  rulePeriod,
  ruleSpacing,
  type PageBackground,
} from "./paper";
import {
  applyPageElementChanges,
  changesForIds,
  zOrderAnchors,
  type PageElementChanges,
} from "./pageChanges";
import {
  LiveCanvasToolbar,
} from "./LiveCanvasToolbar";
import { CanvasRibbon, type CanvasRibbonSlots } from "./CanvasRibbon";
import {
  createLocalHistory,
  createPalmRejectionState,
  eraseStrokePoints,
  eraseWholeStroke,
  normalizePointerSamples,
  pasteElementsFromClipboard,
  recordLocalCommandAfterCommit,
  redoLocalCommand,
  resizeSelectionFromCorner,
  selectionBounds,
  serializeElementsForClipboard,
  distanceToRulerEdge,
  snapPointToAngle,
  snapPointToGrid,
  snapPointToRulerEdge,
  transformSelection,
  undoLocalCommand,
  updatePalmRejection,
  type LocalCommand,
  type LocalHistoryState,
  type PalmRejectionState,
  type Point,
  type PointerSampleLike,
  type Rect,
  type RulerEdgeGeometry,
  type SelectionResizeHandle,
  type SelectionTransform,
} from "./operations";
import { freeSpotBelow } from "./operations/placement";
import { initialViewportFor } from "./initialViewport";
import {
  capVelocity,
  clampToBounds,
  doubleTapViewport,
  dragAxis,
  dragViewport,
  fitZoom,
  flingStep,
  interpolateViewport,
  openingViewport,
  pageSwipe,
  PAGE_SWIPE_DISTANCE,
  readingBounds,
  readingContentRect,
  releaseVelocity,
  viewportForRegion,
  type DragAxis,
  type ReadingInsets,
} from "./readingViewport";
import {
  createJsxGraphFactory,
  CalculatorHistoryView,
  CalculatorPalette,
  GraphBoard,
  type GraphBoardFactory,
  MathBlock,
  NumberScrubber,
  ProviderSettings,
  UnitConversionPanel,
  type GraphSeries,
  type JsxGraphNamespace,
  type MathBlockLabels,
  type RecognitionProviderView,
  type UnitConversionInsertPayload,
} from "./math";
import {
  CalculatorHistory,
} from "../math/history";
import {
  evaluateMathPage,
  prepareGraphExpression,
  sampleGraphExpression,
  splitExplicitGraphPoints,
} from "../math/engine";
import {
  applyMathCorrection,
  attestLocalMathGesture,
  convertSelectedStrokesToMath,
  MathPageController,
  MathRecognitionScheduler,
  listScrubbableNumbers,
  replaceScrubbableNumber,
} from "../math/page";
import {
  BrowserUnavailableRecognitionProvider,
  RecognitionError,
  TauriMathProviderConfiguration,
  TauriRecognitionProvider,
  type RecognitionProvider,
} from "../math/recognition";
import { mathRuntime } from "../math/runtime";
import {
  createMathUnitsPort,
} from "../math/units";
import "./math/jsxGraph.css";
import { penButtonAction, type PenGestureAction } from "./penButtons";
import { markPenSeen, readPenSeen, usePenButtonMapping } from "./penPreferences";
import { PenActionBar } from "./PenActionBar";
import { elementIdsInRegion, isUsableRegion, rectBetween, selectByRect } from "./regionSelection";

export type LiveCanvasTool =
  | "select"
  | "pen"
  | "highlighter"
  | "lasso"
  | "strokeEraser"
  | "pointEraser"
  | "pan"
  | "math"
  | "line"
  | "arrow"
  | "vector"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "axes";

export type PressureCurve = "linear" | "soft" | "firm";

export interface LivePenPreset {
  id: string;
  label: string;
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  opacity: number;
  pressureCurve: PressureCurve;
}

export interface LiveCanvasController {
  selectTool: (tool: LiveCanvasTool) => void;
  /** Shows a page region (page units): in the reading view at a size to read or type in. */
  revealRegion: (region: Rect) => void;
  clearSelection: () => void;
  undo: () => void;
  redo: () => void;
  copy: () => Promise<void>;
  paste: () => Promise<void>;
  createText: (at?: Point) => void;
  exportPerformanceEvidence: () => PenPerformanceAcceptanceEvidence;
}

export interface LiveCanvasEditorProps {
  /**
   * Where the drawing toolbar is rendered. The notebook shell places it above
   * the page title, like OneNote's ribbon, while the editor itself is keyed
   * per page and remounts on every page switch.
   */
  toolbarHost?: HTMLElement | null;
  /**
   * Tabs of the notebook's OneNote-style ribbon. When given, the canvas
   * renders its tools as ribbon groups there instead of its own toolbar.
   */
  ribbonSlots?: CanvasRibbonSlots;
  handle: ReadonlyDocHandle<LivePageDocV2>;
  page: LivePageDocV2;
  deviceId: string;
  onChange: (
    message: string,
    change: ChangeFn<LivePageDocV2>,
  ) => void | boolean | Promise<boolean>;
  writeRichText?: RichTextWriter<LivePageDocV2>;
  editable?: boolean;
  presets?: readonly LivePenPreset[];
  createId?: (scope: string) => string;
  now?: () => string;
  clipboard?: {
    readText: () => Promise<string>;
    writeText: (value: string) => Promise<void>;
  };
  onControllerReady?: (controller: LiveCanvasController) => void;
  performanceRecorder?: LocalPerformanceRecorder;
  recognitionProvider?: RecognitionProvider;
  initialMathSidebarOpen?: boolean;
  /** Enables future Math Canvas creation UI without hiding persisted Math data. */
  mathFeaturesEnabled?: boolean;
  renderAssetElement?: (
    element: Extract<
      LivePageElementV2,
      { kind: "image" | "pdf" | "attachment" }
    >,
  ) => ReactNode;
  /**
   * Renders the given elements of a page region to a PNG (the pen's
   * "Bildausschnitt" action and "Als Bild kopieren"). Without it those
   * actions are off.
   */
  renderRegionImage?: (
    elements: Readonly<Record<string, PageElementV2>>,
    elementIds: readonly string[],
    region: Rect,
  ) => Promise<Blob>;
  /** Puts a clip made by `renderRegionImage` on the page as an image. */
  insertRegionImage?: (png: Blob) => Promise<void> | void;
  /**
   * Whether a finger draws with the active tool. Unset, fingers draw until a
   * pen is seen and pan and pinch-zoom from then on, as in OneNote. With
   * `false` fingers always pan and zoom; with `true` one finger always draws
   * (two fingers still pan and zoom).
   */
  touchDraws?: boolean;
  /** Font size and color of new text boxes (the notebook's text style); the editor's own defaults when unset. */
  newTextStyle?: { fontSize: number; color: string };
  /** Live presence of other people on this page (shared notebooks only). */
  presence?: CanvasPresencePort;
  /**
   * The phone's reading view (src/mobile): no drawing toolbar, the page fitted
   * to the screen's width, bounded momentum panning, double tap to zoom and a
   * sideways swipe past the edge to turn the page. See readingViewport.ts.
   */
  reading?: LiveCanvasReading;
  /**
   * Whether new ink is held outside the document until a seal job moves it into an ink segment (the
   * default). Pages that are edited without the workspace runtime, which runs that job, write
   * strokes into the document instead, and so do pages of a shared notebook (those with `presence`):
   * their strokes must reach the other members as they are drawn.
   */
  holdNewInk?: boolean;
}

export interface LiveCanvasReading {
  /** Space the floating app bars cover; the page opens below the top one. */
  insets: ReadingInsets;
  /** Whether a page lies before and after this one in its section. */
  canSwipe: { previous: boolean; next: boolean };
  /** A tap on the page that was not a double tap (the shell shows or hides its bars). */
  onTap?: () => void;
  /** -1 to 1 while a sideways drag pulls past the edge; negative toward the next page, 0 when it ends. */
  onSwipeProgress?: (progress: number) => void;
  onSwipe?: (direction: "next" | "previous") => void;
  /** The reader moved down the page (the content up) or back up. */
  onScroll?: (direction: "down" | "up") => void;
  /** Where focused text docks its formatting controls (above the keyboard). */
  formatToolbarHost?: HTMLElement | null;
}

/** A drag in the reading view, from the finger's first contact. */
interface ReadingDrag {
  pointerId: number;
  start: Point;
  startedAt: number;
  viewportStart: CanvasViewport;
  samples: Array<{ x: number; y: number; time: number }>;
  axis: DragAxis | null;
  overshootX: number;
  /** Content travel since the last scroll report, for hiding the bars. */
  scrolled: number;
  lastPanY: number;
}

/** Two taps closer than this in time and space are a double tap. */
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SLOP = 40;
/** A press shorter and stiller than this is a tap. */
const TAP_MS = 320;
const TAP_SLOP = 10;
/** Content travel before the reading view reports a scroll direction. */
const SCROLL_REPORT_DISTANCE = 24;

// A stable default: an inline arrow would be a new function on every render
// and rebuild the math engine (memoised on `now`) on every pen move.
function currentTimestamp(): string {
  return new Date().toISOString();
}

const DEFAULT_PRESETS: readonly LivePenPreset[] = [
  {
    id: "school-pen",
    label: "Blauer Stift",
    tool: "pen",
    color: "#1d4ed8",
    size: 3,
    opacity: 1,
    pressureCurve: "linear",
  },
  {
    id: "school-highlighter",
    label: "Gelber Textmarker",
    tool: "highlighter",
    color: "#facc15",
    size: 14,
    opacity: 0.36,
    pressureCurve: "soft",
  },
];

interface ActiveGesture {
  pointerId: number;
  start: Point;
  points: StrokePointV2[];
  resize?: {
    handle: SelectionResizeHandle;
    bounds: Rect;
    transform: SelectionTransform;
  };
  elementId?: string;
  screenStart?: Point;
  viewportStart?: CanvasViewport;
  /** A plain click on empty paper places a text container there, as in OneNote. */
  clickToType?: boolean;
  /** Pressing on the selection picks it up; `translate` is set once it moves. */
  drag?: boolean;
  translate?: Point;
}

/**
 * A pen, highlighter, eraser, lasso or shape gesture. Its points live here,
 * outside React state, and are painted on the overlay from the pointer
 * handler itself.
 */
/**
 * What a live gesture does. Beyond the toolbar's tools, a pen button starts a
 * rectangle selection or a screen clip for the length of one gesture.
 */
type LiveGestureTool = LiveCanvasTool | "rectSelect" | "snip";

/** The temporary gesture each pen button action starts. */
const PEN_ACTION_GESTURES: Record<PenGestureAction, LiveGestureTool> = {
  eraser: "strokeEraser",
  lasso: "lasso",
  rectangleSelect: "rectSelect",
  screenshot: "snip",
};

interface LiveGesture {
  pointerId: number;
  tool: LiveGestureTool;
  /** Started by a pen button rather than the toolbar's tool; its selection stays movable with the pen. */
  viaPenButton?: boolean;
  start: Point;
  points: StrokePointV2[];
  /** Surface position when the gesture began; the page does not move meanwhile. */
  rect: { left: number; top: number };
  zoom: number;
  overlay: OverlayTransform | null;
  /** Ink appearance for pen, highlighter and handwritten Math. */
  style: InkStroke | null;
  /** Grid, angle or ruler snapping, applied to the preview as to the stroke. */
  snap?: (point: StrokePointV2) => StrokePointV2;
  /** Strokes a stroke-eraser swipe has touched so far. */
  erased: Set<string>;
  /**
   * Paints an opaque pen stroke a piece at a time. Other ink (highlighter,
   * snapped, mouse and touch strokes) repaints its whole outline instead.
   */
  painter?: LiveStrokePainter;
  /** Ink samples already taken, whether they came as raw updates or in a move's coalesced list. */
  seen: SampleDeduper;
  /** The browser's prediction from the last move; shown, never stored. */
  predicted: StrokePointV2[];
}

/** A stroke that is drawn and shown, and waits to be written to the page. */
interface PendingStroke {
  stroke: StrokeElementV2;
  command: LocalCommand;
  /** The write failed: the overlay stops showing the stroke. */
  forget: () => void;
}

/** How long the pen rests before waiting strokes are written; shorter while others watch. */
const INK_QUIET_MS = 180;
const PRESENCE_INK_QUIET_MS = 30;
/** Strokes written this recently are stashed when the page is left. */
const RECENT_INK_MS = 5_000;

interface PinchGesture {
  /** Distance between the two fingers when the pinch began. */
  distance: number;
  /** Their midpoint then, relative to the untransformed page origin. */
  center: Point;
  viewport: CanvasViewport;
}

interface InkDebugApi {
  /** Points of the stroke under the pen; each one is painted when it is added. */
  livePointCount: () => number;
  strokes: () => Array<{
    id: string;
    tool: "pen" | "highlighter";
    color: string;
    opacity: number;
    size: number;
    box: { x: number; y: number; width: number; height: number };
    /** A point on the ink (its middle sample), in screen coordinates. */
    samplePoint: { x: number; y: number };
    localPoints: string;
  }>;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** How long the Math blocks of a page stay unchanged before their results are recomputed. */
const MATH_RECOMPUTE_DELAY_MS = 200;
/** A pen's context menu (its barrel button) is swallowed for this long after the pen was last seen. */
const PEN_CONTEXT_MENU_SUPPRESS_MS = 800;
/** Screen pixels across the ring that follows an erasing pen. */
const PEN_ERASER_CURSOR_SIZE = 22;
/** Screen pixels an eraser reaches around its centre. */
const STROKE_ERASER_RADIUS = 6;
/** Screen pixels next to ink that still count as a click on it. */
const STROKE_HIT_TOLERANCE = 6;
const ZOOM_SETTLE_MS = 160;
/** A pan or zoom tick moves the page in the DOM at once; React follows at most this often. */
const VIEWPORT_COMMIT_MS = 90;
/** How often the pen-performance evidence export is attempted while it is not yet possible. */
const PERFORMANCE_EVIDENCE_RETRY_MS = 30_000;
/** A finger held this long without moving opens the context menu. */
const LONG_PRESS_MS = 550;
/** Screen pixels a finger may drift and still count as a long press. */
const LONG_PRESS_SLOP = 10;
const TAP_PAN_SLOP = 10;

type CanvasMenuCommand =
  | { type: "paste"; at: Point }
  | { type: "copy" | "cut" | "delete" | "deleteBackground" | "setBackground" | "releaseBackground"; ids: string[] }
  | { type: "order"; ids: string[]; action: OrderAction }
  | { type: "restyle"; ids: string[]; update: Partial<InkStyle> };

interface CanvasMenuState {
  x: number;
  y: number;
  /** The page point the menu was opened for; "Einfügen" pastes there. */
  point: Point;
  /** The selection the menu acts on. */
  ids: string[];
  /** A page background under the pointer when nothing else was hit. */
  backgroundId?: string;
}
const INK_DEBUG_ENABLED = featureOverrideAllowed(import.meta.env);

function clearedSelection(current: string[]): string[] {
  return current.length === 0 ? current : [];
}

function devicePixelRatioNow(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/**
 * The part of the page inside the viewport, grown by a margin and snapped to
 * a coarse grid so panning only changes it when tiles have to appear.
 */
export function visiblePageRect(
  viewport: CanvasViewport,
  size: { width: number; height: number },
  surfaceOffset: Point,
  margin = 256,
  grid = 128,
): Rect {
  const zoom = clampCanvasZoom(viewport.zoom);
  const left = (-surfaceOffset.x - viewport.panX) / zoom - margin;
  const top = (-surfaceOffset.y - viewport.panY) / zoom - margin;
  const right = left + size.width / zoom + margin * 2;
  const bottom = top + size.height / zoom + margin * 2;
  const x = Math.floor(left / grid) * grid;
  const y = Math.floor(top / grid) * grid;
  return {
    x,
    y,
    width: Math.ceil(right / grid) * grid - x,
    height: Math.ceil(bottom / grid) * grid - y,
  };
}

/** The part of the page the window shows, without the margin the ink tiles use. */
export function exactVisiblePageRect(
  viewport: CanvasViewport,
  size: { width: number; height: number },
  surfaceOffset: Point,
): Rect {
  const zoom = clampCanvasZoom(viewport.zoom);
  return {
    x: (-surfaceOffset.x - viewport.panX) / zoom,
    y: (-surfaceOffset.y - viewport.panY) / zoom,
    width: size.width / zoom,
    height: size.height / zoom,
  };
}

/** The pan and zoom that show `target` as large as fits the window, centred. */
export function viewportShowing(
  target: Rect,
  size: { width: number; height: number },
  surfaceOffset: Point,
): CanvasViewport {
  const zoom = clampCanvasZoom(Math.min(size.width / Math.max(1, target.width), size.height / Math.max(1, target.height)));
  return {
    zoom,
    panX: size.width / 2 - surfaceOffset.x - (target.x + target.width / 2) * zoom,
    panY: size.height / 2 - surfaceOffset.y - (target.y + target.height / 2) * zoom,
  };
}

/** Movement below this many page units still counts as a click rather than a drag. */
const CLICK_TO_TYPE_SLOP = 4;

function richTextHasContent(content: RichTextDocument): boolean {
  const spansHaveText = (spans: readonly { text: string }[]) =>
    spans.some((span) => span.text.trim().length > 0);
  return content.blocks.some((block) =>
    block.type === "table"
      ? block.rows.some((row) => row.some(spansHaveText))
      : spansHaveText(block.spans),
  );
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

export interface CanvasRulerState {
  visible: boolean;
  x: number;
  y: number;
  angleDegrees: number;
  length: number;
}

interface RulerGesture {
  pointerId: number;
  mode: "move" | "rotate";
  offset: Point;
}

export interface CanvasViewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface CanvasDimensions {
  width: number;
  height: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const RULER_HEIGHT = 72;
const RULER_EDGE_OFFSET = -RULER_HEIGHT / 2;
const RULER_SNAP_DISTANCE = 34;
const DEFAULT_RULER: CanvasRulerState = {
  visible: false,
  x: 410,
  y: 250,
  angleDegrees: 0,
  length: 520,
};
const SHAPE_TOOLS = new Set<LiveGestureTool>([
  "line",
  "arrow",
  "vector",
  "rectangle",
  "ellipse",
  "triangle",
  "axes",
]);
let jsxGraphFactory: GraphBoardFactory | undefined;
/** Created on first use: JSXGraph loads with the math libraries (see src/math/runtime.ts). */
function jsxGraphFactoryOnDemand(): GraphBoardFactory {
  jsxGraphFactory ??= createJsxGraphFactory(mathRuntime().JXG as unknown as JsxGraphNamespace);
  return jsxGraphFactory;
}

function defaultRecognitionProvider(kind: RecognitionProvider["kind"]): RecognitionProvider {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__ !== "undefined"
    ? kind === "mathpix" ? TauriRecognitionProvider.mathpix() : TauriRecognitionProvider.compatible()
    : new BrowserUnavailableRecognitionProvider(kind);
}

function recognitionSafeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe}${"0".repeat(16)}`.slice(0, 128);
}

export function createTypedMathElement(
  id: string,
  timestamp: string,
  frame = { x: 80, y: 80, width: 360, height: 180, rotation: 0 },
): MathElementV3 {
  return {
    id,
    kind: "math",
    frame,
    createdAt: timestamp,
    updatedAt: timestamp,
    locked: false,
    inputKind: "typed",
    autoRecognition: "inherit",
    typedLatex: "",
    recognition: { state: "idle", alternatives: [], warnings: [] },
    result: { state: "none", diagnostics: [] },
    dependencies: {
      defines: [],
      references: [],
      dependsOnElementIds: [],
      state: "valid",
    },
  };
}

export function createInkMathElement(options: {
  id: string;
  strokeId: string;
  timestamp: string;
  points: readonly StrokePointV2[];
  color: string;
  size: number;
}): MathElementV3 {
  if (options.points.length === 0) throw new Error("A handwritten Math block requires ink points");
  const captureFrame = frameForStroke(options.points);
  const rawStroke: StrokeElementV2 = {
    id: options.strokeId,
    kind: "stroke",
    frame: captureFrame,
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    locked: true,
    tool: "pen",
    points: options.points.map((point) => ({ ...point })),
    color: options.color,
    size: options.size,
    opacity: 1,
  };
  const { typedLatex: _typedLatex, ...base } = createTypedMathElement(options.id, options.timestamp, {
    x: captureFrame.x - 12,
    y: captureFrame.y - 12,
    width: Math.max(240, captureFrame.width + 120),
    height: Math.max(120, captureFrame.height + 48),
    rotation: 0,
  });
  void _typedLatex;
  return {
    ...base,
    inputKind: "ink",
    rawInk: { captureFrame, sourceStrokes: [rawStroke] },
    recognition: { state: "idle", alternatives: [], warnings: [] },
  };
}

export function appendInkStrokeToMathElement(options: {
  element: MathElementV3;
  strokeId: string;
  timestamp: string;
  points: readonly StrokePointV2[];
  color: string;
  size: number;
}): MathElementV3 {
  const { element } = options;
  if (element.inputKind === "typed" || !element.rawInk) {
    throw new Error("Ink can only be appended to a handwritten Math block");
  }
  if (options.points.length === 0) throw new Error("An appended Math stroke requires ink points");
  const strokeFrame = frameForStroke(options.points);
  const captureFrame = unionFrames(element.rawInk.captureFrame, strokeFrame);
  const rawStroke: StrokeElementV2 = {
    id: options.strokeId,
    kind: "stroke",
    frame: strokeFrame,
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    locked: true,
    tool: "pen",
    points: options.points.map((point) => ({ ...point })),
    color: options.color,
    size: options.size,
    opacity: 1,
  };
  const paddedCapture = {
    x: captureFrame.x - 12,
    y: captureFrame.y - 12,
    width: Math.max(240, captureFrame.width + 120),
    height: Math.max(120, captureFrame.height + 48),
    rotation: 0,
  };
  const next = {
    ...element,
    frame: unionFrames(element.frame, paddedCapture),
    updatedAt: options.timestamp,
    rawInk: {
      captureFrame,
      sourceStrokes: [...element.rawInk.sourceStrokes, rawStroke],
    },
    recognition: { state: "idle", alternatives: [], warnings: [] } as MathElementV3["recognition"],
    result: { state: "none", diagnostics: [] } as MathElementV3["result"],
    dependencies: {
      defines: [], references: [], dependsOnElementIds: [], state: "valid",
    } as MathElementV3["dependencies"],
  };
  delete next.recognizedLatex;
  return next;
}

export function shouldAppendInkToMathBlock(
  element: MathElementV3,
  points: readonly StrokePointV2[],
  margin = 48,
): boolean {
  if (element.inputKind === "typed" || !element.rawInk || points.length === 0) return false;
  const stroke = frameForStroke(points);
  const capture = element.rawInk.captureFrame;
  return stroke.x <= capture.x + capture.width + margin
    && stroke.x + stroke.width >= capture.x - margin
    && stroke.y <= capture.y + capture.height + margin
    && stroke.y + stroke.height >= capture.y - margin;
}

function unionFrames(
  left: { x: number; y: number; width: number; height: number; rotation?: number },
  right: { x: number; y: number; width: number; height: number; rotation?: number },
) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
    rotation: left.rotation ?? right.rotation ?? 0,
  };
}

export function mathElementLatex(element: MathElementV3): string {
  return element.correctedLatex
    ?? element.recognizedLatex
    ?? element.typedLatex
    ?? "";
}

export function recognitionFinalPatches(
  baseline: MathElementV3,
  recognized: MathElementV3,
  timestamp: string,
): { before: Partial<MathElementV3>; after: Partial<MathElementV3> } {
  if (baseline.id !== recognized.id) throw new Error("Recognition patches require one Math block revision");
  return {
    before: {
      recognition: structuredClone(baseline.recognition),
      result: structuredClone(baseline.result),
      dependencies: structuredClone(baseline.dependencies),
      updatedAt: baseline.updatedAt,
      ...(baseline.recognizedLatex === undefined ? {} : { recognizedLatex: baseline.recognizedLatex }),
    },
    after: {
      recognition: structuredClone(recognized.recognition),
      result: structuredClone(recognized.result),
      dependencies: structuredClone(recognized.dependencies),
      updatedAt: timestamp,
      ...(recognized.recognizedLatex === undefined ? {} : { recognizedLatex: recognized.recognizedLatex }),
    },
  };
}

/**
 * The fields an undo restores for an update of `update`. `updatedAt` is always
 * part of it: the forward patch writes a new one, and a backward patch without
 * it would delete the required timestamp instead of restoring the old one.
 */
export function elementUpdateBeforePatch<T extends MathElementV3 | GraphElementV3>(
  before: T,
  update: Partial<T>,
): Partial<T> {
  const patch: Record<string, unknown> = {};
  for (const key of [...Object.keys(update), "updatedAt"]) {
    if (!Object.hasOwn(before, key)) continue;
    patch[key] = structuredClone(before[key as keyof T]);
  }
  return patch as Partial<T>;
}

export function mathUpdateBeforePatch(
  before: MathElementV3,
  update: Partial<MathElementV3>,
): Partial<MathElementV3> {
  return elementUpdateBeforePatch(before, update);
}

export function mayDispatchMathRecognition(
  current: PageElementV2 | undefined,
  expected: MathElementV3,
  settings: ReturnType<typeof mathPageSettings>,
  force: boolean,
): boolean {
  if (!current || current.kind !== "math" || !current.rawInk || !expected.rawInk) return false;
  const enabled = force || current.autoRecognition === "enabled"
    || (current.autoRecognition === "inherit" && settings.autoRecognition);
  return enabled && JSON.stringify(current.rawInk) === JSON.stringify(expected.rawInk);
}

export function conversionPayloadLatex(payload: UnitConversionInsertPayload): string {
  const expression = payload.expression;
  if (expression.kind === "unit-conversion") {
    return `${expression.value}\\,\\mathrm{${expression.sourceUnitId}}\\;\\longrightarrow\\;\\mathrm{${expression.targetUnitId}}`;
  }
  return `${expression.value}\\,\\mathrm{${expression.sourceCurrencyId}}\\;\\longrightarrow\\;\\mathrm{${expression.targetCurrencyId}}`;
}

export function graphSeriesFromPage(
  graph: GraphElementV3,
  elements: Readonly<Record<string, LivePageElementV2>>,
  angleMode: "degrees" | "radians",
): GraphSeries[] {
  const mathElements = Object.values(elements).filter(
    (element): element is MathElementV3 => element.kind === "math",
  );
  const evaluations = evaluateMathPage(
    mathElements.map((element) => ({
      id: element.id,
      x: element.frame.x,
      y: element.frame.y,
      latex: mathElementLatex(element),
    })),
    { angleMode },
  );
  const variables: Record<string, number> = {};
  for (const evaluation of evaluations) {
    const value = evaluation.value?.decimalValue;
    if (evaluation.status === "ok" && evaluation.variable && value != null && Number.isFinite(value)) {
      variables[evaluation.variable] = value;
    }
  }
  return graph.series.flatMap((series) => {
    const source = elements[series.sourceMathElementId];
    if (!source || source.kind !== "math") {
      return [];
    }
    try {
      const prepared = prepareGraphExpression(mathElementLatex(source), { angleMode });
      const sampled = sampleGraphExpression(prepared, {
        minX: graph.viewport.xMin,
        maxX: graph.viewport.xMax,
        minY: graph.viewport.yMin,
        maxY: graph.viewport.yMax,
        variables,
        samples: 257,
        // The operation budget bounds the work; the wall clock only has to
        // stop a runaway. The default 100 ms is also spent while another
        // process has the core, and a graph that misses it is dropped from the
        // page without a message.
        maxEvaluationMs: 1_000,
      });
      if (sampled.kind === "implicit") {
        return sampled.paths
          .filter((path) => path.length >= 2)
          .map((points, index) => ({
            id: `${series.id}:path:${index}`,
            color: series.color,
            visible: series.visible,
            points: points.map((point) => ({ x: point.x, y: point.y })),
          }));
      }
      const segments = splitExplicitGraphPoints(sampled.points, {
        minY: graph.viewport.yMin,
        maxY: graph.viewport.yMax,
      });
      return segments.map((points, index) => ({
        id: `${series.id}:segment:${index}`,
        color: series.color,
        visible: series.visible,
        points,
      }));
    } catch {
      return [];
    }
  });
}

/**
 * Produces an in-memory Math page snapshot for an active number scrub.  This
 * deliberately does not update timestamps or fingerprints: preview frames
 * must never become CRDT/history writes.
 */
export function createScrubPreviewElements(
  elements: Readonly<Record<string, LivePageElementV2>>,
  preview: { readonly elementId: string; readonly latex: string },
  settings: Pick<ReturnType<typeof mathPageSettings>, "angleMode" | "resultMode">,
): Readonly<Record<string, LivePageElementV2>> {
  const source = elements[preview.elementId];
  if (!source || source.kind !== "math") return elements;

  const withPreview = {
    ...elements,
    [source.id]: {
      ...source,
      correctedLatex: preview.latex,
    },
  } as Record<string, LivePageElementV2>;
  const mathElements = Object.values(withPreview).filter(
    (element): element is MathElementV3 => element.kind === "math",
  );
  const evaluations = evaluateMathPage(
    mathElements.map((element) => ({
      id: element.id,
      x: element.frame.x,
      y: element.frame.y,
      latex: mathElementLatex(element),
    })),
    { angleMode: settings.angleMode },
  );
  const evaluationById = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));

  for (const element of mathElements) {
    const evaluation = evaluationById.get(element.id);
    if (!evaluation) continue;
    withPreview[element.id] = {
      ...element,
      result: scrubPreviewResult(evaluation, settings.resultMode),
      dependencies: {
        defines: evaluation.variable ? [evaluation.variable] : [],
        references: [...evaluation.dependencies],
        dependsOnElementIds: [...evaluation.dependencyElementIds],
        state: evaluation.status === "cycle"
          ? "cycle"
          : evaluation.status === "undefined"
            ? "undefined"
            : "valid",
      },
    };
  }
  return withPreview;
}

function scrubPreviewResult(
  evaluation: ReturnType<typeof evaluateMathPage>[number],
  resultMode: ReturnType<typeof mathPageSettings>["resultMode"],
): MathElementV3["result"] {
  if (evaluation.status !== "ok") {
    return {
      state: "error",
      diagnostics: [
        `${evaluation.error?.code ?? "evaluation-failed"}: ${evaluation.error?.message ?? "Formula evaluation failed."}`,
      ],
    };
  }
  if (resultMode === "off") return { state: "none", diagnostics: [] };
  if (evaluation.value) {
    return {
      state: "valid",
      exactLatex: evaluation.value.exactLatex,
      decimalText: evaluation.value.decimalLatex,
      diagnostics: [],
    };
  }
  const formatSolutions = (key: "exactLatex" | "decimalLatex") => evaluation.solutions
    .map((solution) => Object.entries(solution.variables)
      .map(([variable, value]) => `${variable}=${value[key]}`)
      .join(", "))
    .join("; ");
  return {
    state: "valid",
    exactLatex: formatSolutions("exactLatex"),
    decimalText: formatSolutions("decimalLatex"),
    diagnostics: [],
  };
}

export function clampCanvasZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.round(value * 1000) / 1000),
  );
}

/**
 * The paper of a free page. Like OneNote it always keeps empty paper below
 * the lowest content, at least `spaceBelow` page units (the editor passes one
 * viewport height), so writing can continue downward without a manual step.
 */
export function canvasDimensions(
  page: Pick<LivePageDocV2, "pageType" | "elementsById" | "paper">,
  spaceBelow = 320,
): CanvasDimensions {
  const fixed = fixedPaperDimensions(page);
  if (fixed) return fixed;
  let right = 0;
  let bottom = 0;
  for (const id in page.elementsById) {
    const { frame } = page.elementsById[id];
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }
  return {
    width: Math.max(1_600, right + 320),
    height: Math.max(1_200, bottom + Math.max(320, spaceBelow)),
  };
}

/** Keeps a free page's origin at or beyond the viewport's top-left corner. */
export function constrainViewport(viewport: CanvasViewport, freePage: boolean): CanvasViewport {
  if (!freePage || (viewport.panX <= 0 && viewport.panY <= 0)) return viewport;
  return { ...viewport, panX: Math.min(0, viewport.panX), panY: Math.min(0, viewport.panY) };
}

function surfaceTransform(view: CanvasViewport): string {
  return `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
}

/** The parts of the paper's style that a pan or zoom changes. */
function applyPaperGeometry(paper: HTMLElement, style: CSSProperties): void {
  for (const key of ["width", "height"] as const) {
    const value = style[key];
    if (typeof value === "number") paper.style[key] = `${value}px`;
  }
  if (typeof style.transform === "string") paper.style.transform = style.transform;
  if (typeof style.backgroundSize === "string") paper.style.backgroundSize = style.backgroundSize;
}

export function clientPointToCanvas(
  client: Point,
  transformedSurfaceRect: Pick<DOMRect, "left" | "top">,
  zoom: number,
): Point {
  const boundedZoom = clampCanvasZoom(zoom);
  return {
    x: (client.x - transformedSurfaceRect.left) / boundedZoom,
    y: (client.y - transformedSurfaceRect.top) / boundedZoom,
  };
}

export function zoomViewportAroundPoint(
  viewport: CanvasViewport,
  nextZoom: number,
  anchor: Point,
): CanvasViewport {
  const zoom = clampCanvasZoom(nextZoom);
  const worldX = (anchor.x - viewport.panX) / viewport.zoom;
  const worldY = (anchor.y - viewport.panY) / viewport.zoom;
  return {
    zoom,
    panX: anchor.x - worldX * zoom,
    panY: anchor.y - worldY * zoom,
  };
}

export function normalizeRulerAngle(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Math.round(normalized * 10) / 10;
}

export function rulerEdgeGeometry(ruler: CanvasRulerState): RulerEdgeGeometry {
  return {
    center: { x: ruler.x, y: ruler.y },
    angleDegrees: ruler.angleDegrees,
    length: ruler.length,
    edgeOffset: RULER_EDGE_OFFSET,
  };
}

function rulerPreferenceKey(documentId: string): string {
  return `canvink:canvas-ruler:v1:${documentId}`;
}

function loadRulerPreference(documentId: string): CanvasRulerState {
  const fallback = { ...DEFAULT_RULER };
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(rulerPreferenceKey(documentId)) ?? "null") as Partial<CanvasRulerState> | null;
    if (!parsed) return fallback;
    return {
      visible: parsed.visible === true,
      x: Number.isFinite(parsed.x) ? Math.max(0, Number(parsed.x)) : fallback.x,
      y: Number.isFinite(parsed.y) ? Math.max(0, Number(parsed.y)) : fallback.y,
      angleDegrees: normalizeRulerAngle(Number(parsed.angleDegrees)),
      length: Number.isFinite(parsed.length)
        ? Math.min(900, Math.max(240, Number(parsed.length)))
        : fallback.length,
    };
  } catch {
    return fallback;
  }
}

function saveRulerPreference(documentId: string, ruler: CanvasRulerState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(rulerPreferenceKey(documentId), JSON.stringify(ruler));
}

function shapeKindForTool(
  tool: LiveCanvasTool,
): ShapeElementV2["shape"] | undefined {
  if (!SHAPE_TOOLS.has(tool)) return undefined;
  return tool === "vector" ? "arrow" : (tool as ShapeElementV2["shape"]);
}

export function createShapeFromDrag(options: {
  tool: LiveCanvasTool;
  start: Point;
  end: Point;
  id: string;
  timestamp: string;
  /** The page background, or only its type for the default spacing. */
  background: PageBackground["type"] | Pick<PageBackground, "type" | "spacing">;
  gridSnap: boolean;
  angleSnap: boolean;
  ruler?: CanvasRulerState;
}): ShapeElementV2 | undefined {
  const shape = shapeKindForTool(options.tool);
  if (!shape) return undefined;
  let start = { ...options.start };
  let end = { ...options.end };
  const spacing = options.gridSnap
    ? ruleSpacing(typeof options.background === "string" ? { type: options.background } : options.background)
    : undefined;
  if (spacing) {
    start = snapPointToGrid(start, spacing);
    end = snapPointToGrid(end, spacing);
  }
  if (options.angleSnap && ["line", "arrow", "axes"].includes(shape)) {
    end = snapPointToAngle(start, end, 15);
  }
  if (
    options.ruler?.visible &&
    ["line", "arrow"].includes(shape) &&
    distanceToRulerEdge(start, rulerEdgeGeometry(options.ruler)) <= RULER_SNAP_DISTANCE
  ) {
    const geometry = rulerEdgeGeometry(options.ruler);
    start = snapPointToRulerEdge(start, geometry, RULER_SNAP_DISTANCE);
    end = snapPointToRulerEdge(end, geometry, Number.POSITIVE_INFINITY);
  }
  if (Math.hypot(end.x - start.x, end.y - start.y) < 2) return undefined;
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.max(1, Math.abs(end.x - start.x));
  const height = Math.max(1, Math.abs(end.y - start.y));
  return {
    id: options.id,
    kind: "shape",
    shape,
    frame: { x, y, width, height, rotation: 0 },
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    locked: false,
    strokeColor: options.tool === "vector" ? "#0f766e" : "#1f2937",
    strokeWidth: 2,
    ...(shape === "line" || shape === "arrow" ? { points: [start, end] } : {}),
  };
}

let sharedTool: LiveCanvasTool = "select";
let sharedPresetId: string | null = null;

export default function LiveCanvasEditor({
  handle,
  page,
  deviceId,
  onChange,
  writeRichText,
  editable = true,
  presets = DEFAULT_PRESETS,
  createId = defaultCreateId,
  now = currentTimestamp,
  clipboard = defaultClipboard(),
  onControllerReady,
  performanceRecorder,
  recognitionProvider,
  initialMathSidebarOpen = false,
  mathFeaturesEnabled = false,
  renderAssetElement,
  renderRegionImage,
  insertRegionImage,
  toolbarHost,
  ribbonSlots,
  touchDraws,
  newTextStyle,
  presence,
  holdNewInk = true,
  reading,
}: LiveCanvasEditorProps) {
  const { language, t } = useI18n();
  const richTextWriter = useMemo<RichTextWriter<LivePageDocV2>>(
    () => {
      const write: RichTextWriter<LivePageDocV2> = writeRichText ?? ((change, options) => {
        const committed = onChange(options.message, change as ChangeFn<LivePageDocV2>);
        if (committed instanceof Promise) {
          throw new Error("Rich-text persistence requires a prepared synchronous page writer.");
        }
        return committed;
      });
      // Typing moves the page's time of last change (see `stampTextEdit`).
      return (change, options) => write(
        options.message === RICH_TEXT_EDIT_MESSAGE
          ? (document) => {
            change(document);
            stampTextEdit(document);
          }
          : change,
        options,
      );
    },
    [onChange, writeRichText],
  );
  // The shell passes a new render function on every render; a stable wrapper
  // keeps memoised page elements from re-rendering on every stroke.
  const renderAssetRef = useRef(renderAssetElement);
  useLayoutEffect(() => {
    renderAssetRef.current = renderAssetElement;
  }, [renderAssetElement]);
  const renderAsset = useCallback<NonNullable<LiveCanvasEditorProps["renderAssetElement"]>>(
    (element) => renderAssetRef.current?.(element),
    [],
  );
  const desktopRecognitionAvailable = typeof window !== "undefined"
    && typeof window.__TAURI_INTERNALS__ !== "undefined";
  // The chosen tool is shared UI state like in OneNote: it survives an
  // editor remount and a page switch (the ink colour and width persist in
  // `inkStyles`).
  const [tool, setToolState] = useState<LiveCanvasTool>(() =>
    sharedTool === "math" && !mathFeaturesEnabled ? "select" : sharedTool,
  );
  const setTool = useCallback((next: LiveCanvasTool) => {
    // The phone viewer reads and edits text; it has no drawing tool to pick.
    if (VIEWER_APP && next !== "select" && next !== "pan") return;
    sharedTool = next;
    setToolState(next);
  }, []);
  const [presetId, setPresetIdState] = useState(() =>
    presets.some((preset) => preset.id === sharedPresetId) ? sharedPresetId! : presets[0]?.id ?? "",
  );
  const setPresetId = useCallback((next: string) => {
    sharedPresetId = next;
    setPresetIdState(next);
  }, []);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [gesture, setGesture] = useState<ActiveGesture | null>(null);
  const [gridSnap, setGridSnap] = useState(false);
  const [angleSnap, setAngleSnap] = useState(false);
  const [rulersByPage, setRulersByPage] = useState<Record<string, CanvasRulerState>>(() => ({
    [page.documentId]: loadRulerPreference(page.documentId),
  }));
  const [rulerGesture, setRulerGesture] = useState<RulerGesture | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState("");
  const [performanceEvidenceReady, setPerformanceEvidenceReady] = useState(false);
  const [mathSidebarOpen, setMathSidebarOpen] = useState(
    mathFeaturesEnabled && initialMathSidebarOpen,
  );
  const [scrubPreview, setScrubPreview] = useState<{
    elementId: string;
    latex: string;
  } | null>(null);
  const previewScrub = useCallback((elementId: string, latex: string | null) => {
    setScrubPreview(latex === null ? null : { elementId, latex });
  }, []);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [providerViews, setProviderViews] = useState<RecognitionProviderView[]>([
    { id: "compatible", label: "Compatible / TexTeller", status: "unconfigured" },
    { id: "mathpix", label: "Mathpix", status: "unconfigured" },
  ]);
  const [selectedRecognitionProvider, setSelectedRecognitionProvider] = useState<RecognitionProvider["kind"]>(
    recognitionProvider?.kind ?? "compatible",
  );
  const [storedViewport, setViewportState] = useState<CanvasViewport>({
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  // A free page starts at its top-left corner like a OneNote page: panning or
  // zooming never shows empty desk above or left of it. Fixed sheets move freely.
  const freePage = page.pageType !== "a4";
  const freePageRef = useRef(freePage);
  useLayoutEffect(() => {
    freePageRef.current = freePage;
  }, [freePage]);
  // The reading view (phone) keeps its own bounds (see readingViewport.ts):
  // a drag may stretch past them for a moment, so nothing clamps it here.
  const readingMode = Boolean(reading);
  const readingRef = useRef(reading);
  useLayoutEffect(() => {
    readingRef.current = reading;
  });
  // Also derived here, for a page that just switched from a sheet to free.
  const viewport = useMemo(
    () => (readingMode ? storedViewport : constrainViewport(storedViewport, freePage)),
    [readingMode, storedViewport, freePage],
  );
  // The viewport as the latest pan or zoom tick left it. Re-rendering the
  // whole editor for every wheel, drag or pinch event was what panning cost,
  // so a tick moves the surface and the paper in the DOM directly and React
  // state (`storedViewport`) follows at most every VIEWPORT_COMMIT_MS, and at
  // once when a pointer goes down, so handlers never act on a stale view.
  const liveViewportRef = useRef(storedViewport);
  const viewportCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncViewportDomRef = useRef<(viewport: CanvasViewport) => void>(() => undefined);
  const commitViewport = useCallback(() => {
    if (viewportCommitTimerRef.current !== null) clearTimeout(viewportCommitTimerRef.current);
    viewportCommitTimerRef.current = null;
    setViewportState(liveViewportRef.current);
  }, []);
  /** Keeps a view inside what the reading view shows; null outside the reading view. */
  const readingClampRef = useRef<((view: CanvasViewport) => CanvasViewport) | null>(null);
  /** Moves the view exactly as given (gestures and animations of the reading view). */
  const placeViewport = useCallback((next: CanvasViewport) => {
    liveViewportRef.current = next;
    syncViewportDomRef.current(next);
    if (viewportCommitTimerRef.current === null) {
      viewportCommitTimerRef.current = setTimeout(commitViewport, VIEWPORT_COMMIT_MS);
    }
  }, [commitViewport]);
  const setViewport = useCallback((update: CanvasViewport | ((current: CanvasViewport) => CanvasViewport)) => {
    const wanted = typeof update === "function" ? update(liveViewportRef.current) : update;
    const clampReading = readingClampRef.current;
    placeViewport(clampReading ? clampReading(wanted) : constrainViewport(wanted, freePageRef.current));
  }, [placeViewport]);
  useEffect(() => () => {
    if (viewportCommitTimerRef.current !== null) clearTimeout(viewportCommitTimerRef.current);
  }, []);
  const palmRef = useRef<PalmRejectionState>(createPalmRejectionState());
  const historyRef = useRef<LocalHistoryState>(createLocalHistory(deviceId));
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const historyOwner = `${deviceId}:${page.documentId}`;
  const [historyAvailability, setHistoryAvailability] = useState({
    owner: historyOwner,
    canUndo: false,
    canRedo: false,
  });
  const performanceRef = useRef(
    performanceRecorder ?? new LocalPerformanceRecorder(),
  );
  const mathController = useMemo(() => new MathPageController({ now }), [now]);
  const recognitionScheduler = useMemo(() => new MathRecognitionScheduler(), []);
  const activeRecognitionProvider = useMemo(
    () => recognitionProvider ?? defaultRecognitionProvider(selectedRecognitionProvider),
    [recognitionProvider, selectedRecognitionProvider],
  );
  const providerConfiguration = useMemo(() => new TauriMathProviderConfiguration(), []);
  const mathUnitsPort = useMemo(() => createMathUnitsPort(), []);
  const calculatorHistory = useMemo(
    () => new CalculatorHistory({ scopeId: `notebook:${page.notebookId}` }),
    [page.notebookId],
  );
  const recordedFingerprintsRef = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const presenceRef = useRef(presence);
  useLayoutEffect(() => {
    presenceRef.current = presence;
  }, [presence]);
  const paperRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  /** The drawing gesture under the pen; kept out of React state on purpose. */
  const liveRef = useRef<LiveGesture | null>(null);
  // True from a pointer-down the canvas handles (ink, shapes, selection
  // drags) until the pointer is released; text selection is off meanwhile.
  const canvasGestureRef = useRef(false);
  useEffect(() => {
    const blockSelection = (event: Event) => {
      if (canvasGestureRef.current) event.preventDefault();
    };
    const release = () => { canvasGestureRef.current = false; };
    document.addEventListener("selectstart", blockSelection);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      document.removeEventListener("selectstart", blockSelection);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (overlayRef.current) watchOverlay(overlayRef.current);
  }, []);
  /** Committed strokes still painted on the overlay until their tile shows them. */
  const settledInkRef = useRef<Array<{ id: string; stroke: InkStroke; transform: OverlayTransform }>>([]);
  /** Strokes the pen has lifted from but that are not written yet (see inkCommitQueue). */
  const [inkQueue] = useState(() => new InkCommitQueue<PendingStroke>({ commit: () => undefined, isBusy: () => false }));
  const [heldShape, setHeldShape] = useState<HeldInkShapeCandidate | null>(null);
  const heldShapeRef = useRef<HeldInkShapeCandidate | null>(null);
  const [erasingIds, setErasingIds] = useState<ReadonlySet<string>>(NO_IDS);
  const [contextMenu, setContextMenu] = useState<CanvasMenuState | null>(null);
  const longPressRef = useRef<{ pointerId: number; client: Point; timer: ReturnType<typeof setTimeout> } | null>(null);
  const performanceEvidenceReadyRef = useRef(false);
  const performanceEvidenceTriedAtRef = useRef(Number.NEGATIVE_INFINITY);
  // Remembered per device: once a pen has been used here, fingers pan and zoom.
  const [penSeen, setPenSeen] = useState(readPenSeen);
  const notePenSeen = () => {
    if (penSeen) return;
    markPenSeen();
    setPenSeen(true);
  };
  const buttonMapping = usePenButtonMapping();
  /** The clip a screen-clip gesture made, offered for insert until the next press on the canvas. */
  const [captured, setCaptured] = useState<{ png: Blob; copied: boolean; at: Point } | null>(null);
  /** The ids a pen button selected; the selection stays movable with the pen tip while they are unchanged. */
  const [penSelection, setPenSelection] = useState<{ key: string; tool: LiveCanvasTool } | null>(null);
  const penCursorRef = useRef<HTMLDivElement>(null);
  const lastPenAtRef = useRef(Number.NEGATIVE_INFINITY);
  // A finger never draws in the phone viewer: it pans, two fingers zoom.
  const touchDrawsNow = !VIEWER_APP && (touchDraws ?? !penSeen);
  /** A finger that landed on text: a tap places the caret, a drag beyond the slop pans the page. */
  const tapPanRef = useRef<{ pointerId: number; start: Point; viewport: CanvasViewport; focus?: HTMLElement } | null>(null);
  /** Fingers currently down, in client coordinates. */
  const touchesRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const [viewSize, setViewSize] = useState({ width: 1_440, height: 900 });
  const [surfaceOffset, setSurfaceOffset] = useState({ x: 24, y: 24 });
  const inkShapeHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [formatSlot, setFormatSlot] = useState<HTMLDivElement | null>(null);
  const [inkStyles, setInkStyles] = useState(() =>
    loadInkStyles(typeof window === "undefined" ? null : window.localStorage),
  );
  const updateInkStyle = useCallback((inkTool: InkTool, update: Partial<InkStyle>) => {
    setInkStyles((current) => {
      const next = { ...current, [inkTool]: { ...current[inkTool], ...update } };
      saveInkStyles(typeof window === "undefined" ? null : window.localStorage, next);
      return next;
    });
  }, []);
  const basePreset =
    presets.find((preset) => preset.id === presetId) ?? presets[0];
  // The toolbar's colour and width choice overrides the preset for new ink.
  const activePreset = basePreset
    ? { ...basePreset, ...inkStyles[basePreset.tool] }
    : basePreset;
  // Free pages keep a viewport of paper below the lowest content.
  const spaceBelow = Math.ceil(viewSize.height / clampCanvasZoom(viewport.zoom));
  const contentDimensions = useMemo(() => canvasDimensions(page, spaceBelow), [page, spaceBelow]);
  const fixedPaper = !freePage;
  // A free page is paper wherever the viewport shows it, so the surface also
  // reaches the visible right and bottom edge: writing works everywhere the
  // rule pattern is drawn, not only inside the content's extent.
  const visibleZoom = clampCanvasZoom(viewport.zoom);
  const dimensions = fixedPaper
    ? contentDimensions
    : {
        width: Math.max(contentDimensions.width, Math.ceil((viewSize.width - surfaceOffset.x - viewport.panX) / visibleZoom)),
        height: Math.max(contentDimensions.height, Math.ceil((viewSize.height - surfaceOffset.y - viewport.panY) / visibleZoom)),
      };
  // The reading view (phone): the page area it shows, how far it may move,
  // and its animations (see readingViewport.ts).
  const readingContent = useMemo(
    () => readingContentRect(Object.values(page.elementsById), fixedPaper ? contentDimensions : null),
    [contentDimensions, fixedPaper, page.elementsById],
  );
  const readingContentRef = useRef(readingContent);
  const readingViewSize = (): { width: number; height: number } => {
    const node = viewportRef.current;
    return node && node.clientWidth > 0 ? { width: node.clientWidth, height: node.clientHeight } : { width: 400, height: 800 };
  };
  const readingBoundsAt = (zoom: number) => readingBounds(
    readingContentRef.current,
    readingViewSize(),
    clampCanvasZoom(zoom),
    readingRef.current?.insets ?? { top: 0, bottom: 0 },
  );
  useLayoutEffect(() => {
    readingContentRef.current = readingContent;
    readingClampRef.current = readingMode ? (view) => clampToBounds(view, readingBoundsAt(view.zoom)) : null;
  });
  const readingAnimationRef = useRef<number | null>(null);
  const stopReadingAnimation = () => {
    if (readingAnimationRef.current !== null) cancelAnimationFrame(readingAnimationRef.current);
    readingAnimationRef.current = null;
  };
  useEffect(() => () => {
    if (readingAnimationRef.current !== null) cancelAnimationFrame(readingAnimationRef.current);
  }, []);
  /** Content travel since the last scroll direction the reading view reported. */
  const readingScrollRef = useRef(0);
  const noteReadingScroll = (deltaPanY: number) => {
    const onScroll = readingRef.current?.onScroll;
    if (!onScroll || deltaPanY === 0) return;
    const travelled = readingScrollRef.current;
    const next = Math.sign(travelled) === Math.sign(deltaPanY) ? travelled + deltaPanY : deltaPanY;
    if (Math.abs(next) >= SCROLL_REPORT_DISTANCE) {
      onScroll(next < 0 ? "down" : "up");
      readingScrollRef.current = 0;
    } else {
      readingScrollRef.current = next;
    }
  };
  const animateReadingTo = (target: CanvasViewport, duration = 260) => {
    stopReadingAnimation();
    const from = liveViewportRef.current;
    if (from.zoom === target.zoom && from.panX === target.panX && from.panY === target.panY) return;
    const startedAt = performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / duration);
      placeViewport(interpolateViewport(from, target, progress));
      if (progress < 1) {
        readingAnimationRef.current = requestAnimationFrame(step);
      } else {
        readingAnimationRef.current = null;
        commitViewport();
      }
    };
    readingAnimationRef.current = requestAnimationFrame(step);
  };
  const flingReading = (velocity: { x: number; y: number }) => {
    stopReadingAnimation();
    let state = { viewport: liveViewportRef.current, velocity: capVelocity(velocity) };
    let last = performance.now();
    const step = (time: number) => {
      const next = flingStep(state.viewport, state.velocity, readingBoundsAt(state.viewport.zoom), Math.min(32, Math.max(1, time - last)));
      last = time;
      if (!next) {
        readingAnimationRef.current = null;
        commitViewport();
        return;
      }
      noteReadingScroll(next.viewport.panY - state.viewport.panY);
      state = next;
      placeViewport(next.viewport);
      readingAnimationRef.current = requestAnimationFrame(step);
    };
    readingAnimationRef.current = requestAnimationFrame(step);
  };
  /** After a pinch or a stretch past an edge: back inside the bounds, never smaller than the fitted width. */
  const settleReading = () => {
    const current = liveViewportRef.current;
    const view = readingViewSize();
    const fit = fitZoom(readingContentRef.current, view.width);
    let target = current;
    if (current.zoom < fit) {
      const anchor = { x: view.width / 2, y: view.height / 2 };
      target = zoomViewportAroundPoint(current, fit, anchor);
    }
    animateReadingTo(clampToBounds(target, readingBoundsAt(target.zoom)), 240);
  };
  const readingDragRef = useRef<ReadingDrag | null>(null);
  const lastReadingTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const readingTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (readingTapTimerRef.current !== null) clearTimeout(readingTapTimerRef.current);
  }, []);
  const startReadingDrag = (pointerId: number, client: Point, viewportStart: CanvasViewport) => {
    stopReadingAnimation();
    readingDragRef.current = {
      pointerId,
      start: client,
      startedAt: performance.now(),
      viewportStart,
      samples: [{ x: client.x, y: client.y, time: performance.now() }],
      axis: null,
      overshootX: 0,
      scrolled: 0,
      lastPanY: viewportStart.panY,
    };
  };
  const moveReadingDrag = (drag: ReadingDrag, client: Point) => {
    const now = performance.now();
    drag.samples.push({ x: client.x, y: client.y, time: now });
    if (drag.samples.length > 12) drag.samples.shift();
    const delta = { x: client.x - drag.start.x, y: client.y - drag.start.y };
    const startBounds = readingBoundsAt(drag.viewportStart.zoom);
    drag.axis ??= dragAxis(delta, startBounds.maxPanX - startBounds.minPanX > 1);
    if (!drag.axis) return;
    const wanted = {
      zoom: drag.viewportStart.zoom,
      panX: drag.viewportStart.panX + (drag.axis === "y" ? 0 : delta.x),
      panY: drag.viewportStart.panY + (drag.axis === "x" ? 0 : delta.y),
    };
    const options = readingRef.current;
    const view = readingViewSize();
    const towardNext = wanted.panX < startBounds.minPanX;
    const swipeAllowed = towardNext ? options?.canSwipe.next : options?.canSwipe.previous;
    const result = dragViewport(wanted, startBounds, { x: swipeAllowed ? view.width * 0.6 : 48, y: view.height * 0.25 });
    drag.overshootX = result.overshoot.x;
    placeViewport(result.viewport);
    noteReadingScroll(result.viewport.panY - drag.lastPanY);
    drag.lastPanY = result.viewport.panY;
    if (swipeAllowed && drag.axis !== "y") {
      options?.onSwipeProgress?.(Math.max(-1, Math.min(1, result.overshoot.x / PAGE_SWIPE_DISTANCE)));
    }
  };
  const tapReading = (client: Point) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchor = { x: client.x - (rect?.left ?? 0), y: client.y - (rect?.top ?? 0) };
    const now = performance.now();
    const last = lastReadingTapRef.current;
    if (readingTapTimerRef.current !== null) clearTimeout(readingTapTimerRef.current);
    readingTapTimerRef.current = null;
    if (last && now - last.at < DOUBLE_TAP_MS && Math.hypot(anchor.x - last.x, anchor.y - last.y) < DOUBLE_TAP_SLOP) {
      lastReadingTapRef.current = null;
      animateReadingTo(doubleTapViewport(
        liveViewportRef.current,
        anchor,
        readingContentRef.current,
        readingViewSize(),
        readingRef.current?.insets ?? { top: 0, bottom: 0 },
      ), 280);
      return;
    }
    lastReadingTapRef.current = { at: now, ...anchor };
    readingTapTimerRef.current = setTimeout(() => {
      readingTapTimerRef.current = null;
      readingRef.current?.onTap?.();
    }, DOUBLE_TAP_MS);
  };
  const finishReadingDrag = (drag: ReadingDrag, client: Point) => {
    readingDragRef.current = null;
    const options = readingRef.current;
    const moved = Math.hypot(client.x - drag.start.x, client.y - drag.start.y);
    if (!drag.axis && moved < TAP_SLOP && performance.now() - drag.startedAt < TAP_MS) {
      tapReading(client);
      return;
    }
    const velocity = releaseVelocity(drag.samples);
    const swipe = pageSwipe(drag.overshootX, velocity.x, drag.axis);
    if (drag.overshootX !== 0 || drag.axis === "x") options?.onSwipeProgress?.(0);
    if (swipe && (swipe === "next" ? options?.canSwipe.next : options?.canSwipe.previous)) {
      options?.onSwipe?.(swipe);
      settleReading();
      return;
    }
    const current = liveViewportRef.current;
    const bounds = readingBoundsAt(current.zoom);
    const inside = clampToBounds(current, bounds);
    if (inside.panX !== current.panX || inside.panY !== current.panY) {
      animateReadingTo(inside, 260);
      return;
    }
    flingReading({
      x: drag.axis === "y" ? 0 : velocity.x,
      y: drag.axis === "x" ? 0 : velocity.y,
    });
  };
  const ruler = useMemo(
    () => rulersByPage[page.documentId] ?? loadRulerPreference(page.documentId),
    [page.documentId, rulersByPage],
  );
  const operationElements = useMemo(
    () => liveMapToOperationMap(page.elementsById, richTextProjector(handle)),
    [handle, page],
  );
  const operationElementsRef = useRef(operationElements);
  const zOrderRef = useRef(page.zOrder);
  // Event handlers can run after the DOM for this render is visible but before
  // passive effects. A layout effect publishes the exact visible snapshot.
  useLayoutEffect(() => {
    operationElementsRef.current = operationElements;
    zOrderRef.current = page.zOrder;
  }, [operationElements, page.zOrder]);
  useLayoutEffect(() => {
    gestureRef.current = gesture;
  }, [gesture]);
  const recognitionBaselinesRef = useRef(new Map<string, MathElementV3>());
  const pageMathSettingsSource = (page as Pick<PageDocV3, "mathSettings">).mathSettings;
  // Keyed on the settings object itself, which keeps its identity across page
  // changes that do not touch it, so memoised elements are not re-rendered.
  const pageMathSettings = useMemo(
    () => mathPageSettings({ mathSettings: pageMathSettingsSource }),
    [pageMathSettingsSource],
  );
  const scrubPreviewElements = useMemo(
    () => scrubPreview
      ? createScrubPreviewElements(page.elementsById, scrubPreview, pageMathSettings)
      : page.elementsById,
    [page.elementsById, pageMathSettings, scrubPreview],
  );
  const pageMathSettingsRef = useRef(pageMathSettings);
  useEffect(() => {
    pageMathSettingsRef.current = pageMathSettings;
  }, [pageMathSettings]);
  useEffect(() => {
    if (!desktopRecognitionAvailable || recognitionProvider) return;
    let current = true;
    void Promise.all((['compatible', 'mathpix'] as const).map(async (providerId) => {
      try {
        const status = await providerConfiguration.status(providerId);
        return [providerId, status.configured ? 'ready' : 'unconfigured'] as const;
      } catch {
        return [providerId, 'error'] as const;
      }
    })).then((statuses) => {
      if (!current) return;
      const statusById = new Map(statuses);
      setProviderViews((items) => items.map((item) => ({
        ...item,
        status: statusById.get(item.id) ?? item.status,
      })));
    });
    return () => { current = false; };
  }, [desktopRecognitionAvailable, providerConfiguration, recognitionProvider]);
  useEffect(() => {
    recordedFingerprintsRef.current.clear();
  }, [page.notebookId]);
  const activeSelectedIds = useMemo(
    () => selectedIds.filter((id) => Boolean(operationElements[id])),
    [operationElements, selectedIds],
  );
  const penSelectionActive = penSelection !== null
    && penSelection.tool === tool
    && activeSelectedIds.length > 0
    && penSelection.key === activeSelectedIds.join("|");
  // Text containers this session created are discarded again when they are
  // left without any text, so clicking around the page does not litter it
  // with empty boxes. Containers from other devices are never touched.
  const locallyCreatedTextIdsRef = useRef(new Set<string>());
  const previousSelectionRef = useRef<readonly string[]>([]);
  const activeSelectedMath = useMemo(
    () => activeSelectedIds
      .map((id) => operationElements[id])
      .find((element): element is MathElementV3 => element?.kind === "math"),
    [activeSelectedIds, operationElements],
  );

  // Recomputation only looks at Math blocks; the page's ink must not be copied
  // (or even walked twice) on every stroke.
  const mathSubset = useStableMathSubset(operationElements);
  const pageRef = useRef(page);
  useLayoutEffect(() => {
    pageRef.current = page;
  }, [page]);
  useEffect(() => {
    if (Object.keys(mathSubset).length === 0) return;
    let active = true;
    // Typing a formula changes the block at every input. The results follow
    // the last input: recomputing (and saving the results as a second change
    // of the page) after each one doubled the work of every keystroke.
    const timer = window.setTimeout(() => {
      const currentPage = pageRef.current;
      const snapshot = {
        ...structuredClone({ ...currentPage, elementsById: {}, zOrder: [] }),
        schemaVersion: 3 as const,
        elementsById: structuredClone(mathSubset),
        zOrder: currentPage.zOrder.filter((id) => Boolean(mathSubset[id])),
        version: { protocol: "uninitialized" as const, heads: [] },
      } as PageDocV3;
      void mathController.recompute(snapshot).then((result) => {
        if (!active || result.updatedElementIds.length === 0) return;
        for (const elementId of result.updatedElementIds) {
          const calculated = result.page.elementsById[elementId];
          const fingerprint = calculated?.kind === "math" ? calculated.result.sourceFingerprint : undefined;
          const visibleResult = calculated?.kind === "math"
            ? pageMathSettings.numberMode === "exact" ? calculated.result.exactLatex : calculated.result.decimalText
            : undefined;
          if (!fingerprint || !visibleResult || calculated?.kind !== "math"
            || recordedFingerprintsRef.current.has(fingerprint)) continue;
          recordedFingerprintsRef.current.add(fingerprint);
          void calculatorHistory.add({
            expression: mathElementLatex(calculated),
            visibleResult,
            numberMode: pageMathSettings.numberMode,
            angleMode: pageMathSettings.angleMode,
          }).then(() => setHistoryRevision((value) => value + 1)).catch(() => undefined);
        }
        void onChange("Recompute page mathematics", (draft) => {
          for (const elementId of result.updatedElementIds) {
            const calculated = result.page.elementsById[elementId];
            const current = draft.elementsById[elementId];
            const source = snapshot.elementsById[elementId];
            if (
              !calculated || calculated.kind !== "math"
              || !current || current.kind !== "math"
              || !source || source.kind !== "math"
              || mathElementLatex(current) !== mathElementLatex(source)
            ) continue;
            current.result = structuredClone(calculated.result);
            current.dependencies = structuredClone(calculated.dependencies);
            current.updatedAt = calculated.updatedAt;
          }
          draft.updatedAt = result.page.updatedAt;
        });
      }).catch(() => undefined);
    }, MATH_RECOMPUTE_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [calculatorHistory, mathController, mathSubset, onChange, pageMathSettings]);
  const selectTool = useCallback(
    (nextTool: LiveCanvasTool) => {
      if (nextTool === "math" && !mathFeaturesEnabled) return;
      setTool(nextTool);
      if (nextTool === "pen" || nextTool === "highlighter") {
        const matchingPreset = presets.find(
          (preset) => preset.tool === nextTool,
        );
        if (matchingPreset) setPresetId(matchingPreset.id);
      }
    },
    [mathFeaturesEnabled, presets, setPresetId, setTool],
  );

  useEffect(() => {
    historyRef.current = createLocalHistory(deviceId);
    historyQueueRef.current = Promise.resolve();
  }, [deviceId, page.documentId]);

  useEffect(() => () => recognitionScheduler.dispose(), [recognitionScheduler]);

  useEffect(() => () => {
    if (inkShapeHoldTimerRef.current !== null) {
      clearTimeout(inkShapeHoldTimerRef.current);
    }
    if (longPressRef.current) clearTimeout(longPressRef.current.timer);
  }, []);

  useEffect(() => {
    saveRulerPreference(page.documentId, ruler);
  }, [page.documentId, ruler]);

  /**
   * Writes one editor command. The change set names exactly the elements the
   * command touches, so the Automerge change and its cost stay proportional
   * to the command, not to the page.
   */
  const commitNow = useCallback(
    (
      message: string,
      changes: PageElementChanges,
      command?: LocalCommand | readonly LocalCommand[],
    ) => {
      const timestamp = now();
      const before = operationElementsRef.current;
      const orderHint = zOrderRef.current;
      const confirmation = onChange(message, (draft) => {
        applyPageElementChanges(draft, changes, before, timestamp, orderHint, undefined, { holdNewInk: holdNewInk && presence === undefined });
      });
      const committed = confirmation === undefined ? true : confirmation;
      // Several strokes written together stay one undo step each.
      const commands: readonly LocalCommand[] = !command ? [] : "commandId" in command ? [command] : command;
      if (commands.length === 0) return committed;
      if (typeof committed === "boolean") {
        let nextHistory = historyRef.current;
        for (const entry of commands) {
          nextHistory = recordLocalCommandAfterCommit(nextHistory, entry, () => committed);
        }
        historyRef.current = nextHistory;
        setHistoryAvailability({
          owner: historyOwner,
          canUndo: nextHistory.past.length > 0,
          canRedo: nextHistory.future.length > 0,
        });
        return committed;
      }
      historyQueueRef.current = historyQueueRef.current
        .then(async () => {
          const didCommit = await committed;
          let nextHistory = historyRef.current;
          for (const entry of commands) {
            nextHistory = recordLocalCommandAfterCommit(nextHistory, entry, () => didCommit);
          }
          historyRef.current = nextHistory;
          setHistoryAvailability({
            owner: historyOwner,
            canUndo: nextHistory.past.length > 0,
            canRedo: nextHistory.future.length > 0,
          });
        })
        .catch(() => undefined);
      return committed;
    },
    [historyOwner, holdNewInk, now, onChange, presence],
  );

  /**
   * Every write to the page goes through here and writes the strokes the pen
   * has lifted from first, so the page changes in the order it was drawn.
   */
  const commitChanges = useCallback(
    (
      message: string,
      changes: PageElementChanges,
      command?: LocalCommand | readonly LocalCommand[],
    ) => {
      inkQueue.flush();
      return commitNow(message, changes, command);
    },
    [commitNow, inkQueue],
  );

  /** Strokes written moments ago, which an interrupted save may not hold (see unsavedInk). */
  const recentWritesRef = useRef<Array<{ stroke: StrokeElementV2; at: number }>>([]);
  const writeStrokes = useCallback((items: readonly PendingStroke[]) => {
    const written = Date.now();
    recentWritesRef.current = [
      ...recentWritesRef.current.filter((entry) => written - entry.at < RECENT_INK_MS),
      ...items.map((item) => ({ stroke: item.stroke, at: written })),
    ];
    const confirmation = commitNow(
      items.length === 1 ? "Draw ink stroke" : "Draw ink strokes",
      { upserts: items.map((item) => item.stroke) },
      items.map((item) => item.command),
    );
    if (confirmation instanceof Promise) {
      void confirmation.then((committed) => {
        if (!committed) for (const item of items) item.forget();
      });
    } else if (confirmation === false) {
      for (const item of items) item.forget();
    }
  }, [commitNow]);
  useLayoutEffect(() => {
    inkQueue.bind({ commit: writeStrokes, isBusy: () => liveRef.current !== null });
  }, [inkQueue, writeStrokes]);
  // The strokes still waiting belong to this page: they are written before
  // another page's changes can reach this editor, and when it goes away.
  useLayoutEffect(() => () => inkQueue.flush(), [historyOwner, inkQueue]);
  // Leaving: the page's own write is asynchronous and a reload can cut it off,
  // so the recent strokes also go where a synchronous write puts them, and the
  // next start puts back what the page lacks.
  const documentId = page.documentId;
  useEffect(() => {
    const stash = () => {
      const now = Date.now();
      const strokes = [
        // Only what the page still shows: undone or erased ink must not come back.
        ...recentWritesRef.current
          .filter((entry) => now - entry.at < RECENT_INK_MS && operationElementsRef.current[entry.stroke.id]?.kind === "stroke")
          .map((entry) => entry.stroke),
        ...inkQueue.waiting().map((item) => item.stroke),
      ];
      if (strokes.length > 0) stashUnsavedInk(documentId, strokes);
    };
    const leave = () => {
      stash();
      inkQueue.flush();
    };
    // The page is back (a hidden tab, a page restored from the cache): what was
    // stashed is no longer needed, and must not bring back ink erased since.
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") leave();
      else stashUnsavedInk(documentId, []);
    };
    const stopHook = onInkLeave(stash);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      stopHook();
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [documentId, inkQueue]);
  const restoreUnsavedInkRef = useRef(() => undefined as void);
  useEffect(() => {
    restoreUnsavedInkRef.current = () => {
      if (!editable) return;
      const missing = takeUnsavedInk(documentId).filter((stroke) => !operationElementsRef.current[stroke.id]);
      if (missing.length > 0) commitChanges("Restore ink", { upserts: missing });
    };
  });
  useEffect(() => {
    restoreUnsavedInkRef.current();
  }, [documentId]);
  useEffect(() => {
    inkQueue.setQuietMs(presence ? PRESENCE_INK_QUIET_MS : INK_QUIET_MS);
  }, [inkQueue, presence]);

  useEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = selectedIds;
    if (!editable) return;
    const current = operationElementsRef.current;
    const left = previous.filter((id) => !selectedIds.includes(id) && current[id]?.kind === "richText");
    const abandoned = left.filter((id) => {
      const element = current[id];
      return locallyCreatedTextIdsRef.current.has(id)
        && element?.kind === "richText"
        && !richTextHasContent(element.content);
    });
    for (const id of abandoned) locallyCreatedTextIdsRef.current.delete(id);
    // Persist the height a container grew to while typing, so selection
    // bounds, export and other devices see the whole text.
    const upserts: PageElementV2[] = [];
    for (const id of left) {
      const element = current[id];
      if (!element || abandoned.includes(id)) continue;
      const node = rootRef.current?.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(id)}"]`,
      );
      const renderedHeight = node?.offsetHeight ?? 0;
      if (renderedHeight > element.frame.height + 1) {
        upserts.push({ ...element, frame: { ...element.frame, height: Math.ceil(renderedHeight) } });
      }
    }
    if (abandoned.length === 0 && upserts.length === 0) return;
    commitChanges(
      abandoned.length > 0 ? "Discard empty text" : "Fit text container",
      { upserts, removals: abandoned },
    );
  }, [commitChanges, editable, selectedIds]);

  const growTextContainer = useCallback((elementId: string, height: number) => {
    const current = operationElementsRef.current;
    const element = current[elementId];
    if (!element || element.kind !== "richText" || height <= element.frame.height + 1) return;
    // Layout bookkeeping, not an edit: no undo entry.
    commitChanges("Fit text container", {
      upserts: [{ ...element, frame: { ...element.frame, height } }],
    });
  }, [commitChanges]);

  const transformSelected = useCallback(
    (transform: SelectionTransform, message: string) => {
      if (activeSelectedIds.length === 0) return;
      const timestamp = now();
      const next = transformSelection(
        operationElements,
        activeSelectedIds,
        transform,
        timestamp,
      );
      const patches = activeSelectedIds.flatMap((id) => {
        const before = operationElements[id];
        const after = next[id];
        if (!before || !after || before === after) return [];
        return [
          {
            elementId: id,
            before: structuredClone(before),
            after: structuredClone(after),
          },
        ];
      });
      if (patches.length === 0) return;
      commitChanges(
        message,
        { upserts: patches.map((patch) => next[patch.elementId]) },
        { commandId: createId("command"), deviceId, patches },
      );
    },
    [
      activeSelectedIds,
      commitChanges,
      createId,
      deviceId,
      now,
      operationElements,
    ],
  );

  const undo = useCallback(() => {
    inkQueue.flush();
    historyQueueRef.current = historyQueueRef.current.then(async () => {
      const currentHistory = historyRef.current;
      const currentElements = operationElementsRef.current;
      const result = undoLocalCommand(currentHistory, currentElements);
      if (result.history === currentHistory) return;
      for (const [elementId, current] of Object.entries(currentElements)) {
        const next = result.elements[elementId];
        if (current.kind === "math" && (!next || next.kind !== "math"
          || JSON.stringify(current.rawInk) !== JSON.stringify(next.rawInk))) {
          recognitionScheduler.cancel(elementId);
          recognitionBaselinesRef.current.delete(elementId);
        }
      }
      const command = currentHistory.past.at(-1);
      const changes = changesForIds(
        currentElements,
        result.elements,
        command?.patches.map((patch) => patch.elementId) ?? [],
        command?.anchors,
      );
      const committed = await Promise.resolve(commitChanges(
        "Undo local canvas command",
        command?.zOrderBefore ? { ...changes, zOrder: command.zOrderBefore } : changes,
      ));
      if (committed) {
        historyRef.current = result.history;
        setHistoryAvailability({
          owner: historyOwner,
          canUndo: result.history.past.length > 0,
          canRedo: result.history.future.length > 0,
        });
      }
    }).catch(() => undefined);
  }, [commitChanges, historyOwner, inkQueue, recognitionScheduler]);

  const redo = useCallback(() => {
    inkQueue.flush();
    historyQueueRef.current = historyQueueRef.current.then(async () => {
      const currentHistory = historyRef.current;
      const currentElements = operationElementsRef.current;
      const result = redoLocalCommand(currentHistory, currentElements);
      if (result.history === currentHistory) return;
      const command = currentHistory.future[0];
      const changes = changesForIds(
        currentElements,
        result.elements,
        command?.patches.map((patch) => patch.elementId) ?? [],
        command?.anchors,
      );
      const committed = await Promise.resolve(commitChanges(
        "Redo local canvas command",
        command?.zOrderAfter ? { ...changes, zOrder: command.zOrderAfter } : changes,
      ));
      if (committed) {
        historyRef.current = result.history;
        setHistoryAvailability({
          owner: historyOwner,
          canUndo: result.history.past.length > 0,
          canRedo: result.history.future.length > 0,
        });
      }
    }).catch(() => undefined);
  }, [commitChanges, historyOwner, inkQueue]);

  const copy = useCallback(async () => {
    if (activeSelectedIds.length === 0) return;
    const serialized = serializeElementsForClipboard(
      operationElements,
      activeSelectedIds,
      page.zOrder,
    );
    await clipboard.writeText(serialized);
    setClipboardStatus(`${activeSelectedIds.length} Element(e) kopiert.`);
  }, [activeSelectedIds, clipboard, operationElements, page.zOrder]);

  /** Pastes canvas elements; from the context menu at the pointer, as in OneNote. */
  const paste = useCallback(async (at?: Point) => {
    if (!editable) return;
    const serialized = await clipboard.readText().catch(() => "");
    let pasted: ReturnType<typeof pasteElementsFromClipboard>;
    try {
      pasted = pasteElementsFromClipboard(serialized, (oldId) =>
        createId(`paste-${oldId}`),
      );
    } catch {
      // Empty or foreign clipboard content is not a canvas selection; plain
      // text is handled by the native paste event instead.
      return;
    }
    const bounds = at ? selectionBounds(pasted.elementsById, pasted.zOrder) : null;
    if (at && bounds) {
      pasted = {
        ...pasted,
        elementsById: transformSelection(
          pasted.elementsById,
          pasted.zOrder,
          { translateX: Math.max(0, at.x) - bounds.x, translateY: Math.max(0, at.y) - bounds.y },
          now(),
        ),
      };
    }
    const command: LocalCommand = {
      commandId: createId("command"),
      deviceId,
      patches: Object.values(pasted.elementsById).map((element) => ({
        elementId: element.id,
        before: null,
        after: element,
      })),
    };
    commitChanges(
      "Paste canvas elements",
      { upserts: pasted.zOrder.map((id) => pasted.elementsById[id]) },
      command,
    );
    setSelectedIds(pasted.zOrder);
    setClipboardStatus(t('canvas.paste.done', { count: pasted.zOrder.length }));
  }, [
    clipboard,
    commitChanges,
    createId,
    deviceId,
    editable,
    now,
    t,
  ]);

  const createText = useCallback((at?: Point, options: { recordHistory?: boolean; table?: boolean } = {}) => {
    if (!editable) return;
    const id = createId("rich-text");
    const timestamp = now();
    // A click places the caret where the pointer was, like OneNote. Without a
    // point the container opens near the top-left of what is currently visible
    // instead of at a fixed page position that may be scrolled out of view.
    const origin = at
      ? { x: Math.max(0, at.x - 6), y: Math.max(0, at.y - 14) }
      : freeSpotBelow(Object.values(operationElementsRef.current), {
          x: Math.max(0, -viewport.panX / viewport.zoom) + 80,
          y: Math.max(0, -viewport.panY / viewport.zoom) + 80,
          width: 360,
          height: 120,
        });
    const element: PageElementV2 = {
      id,
      kind: "richText",
      // Starts one line tall; the container grows while typing (see LiveElement).
      frame: { x: origin.x, y: origin.y, width: 360, height: at ? 40 : 120, rotation: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
      locked: false,
      content: {
        type: "doc",
        blocks: options.table
          ? [{
              id: createId("table-block"),
              type: "table",
              rows: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => [])),
            }]
          : [{ id: createId("text-block"), type: "paragraph", spans: [] }],
      },
      style: {
        color: newTextStyle?.color ?? "#111827",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: newTextStyle?.fontSize ?? 16,
        textAlign: "left",
      },
    };
    commitChanges(
      "Create collaborative text",
      { upserts: [element] },
      options.recordHistory === false
        ? undefined
        : {
            commandId: createId("command"),
            deviceId,
            patches: [{ elementId: id, before: null, after: element }],
          },
    );
    locallyCreatedTextIdsRef.current.add(id);
    setSelectedIds([id]);
    setTool("select");
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-element-id="${CSS.escape(id)}"] .ProseMirror`,
        )
        ?.focus();
    });
  }, [
    commitChanges,
    setTool,
    createId,
    deviceId,
    editable,
    newTextStyle,
    now,
    viewport,
  ]);

  const updateMathElement = useCallback((
    elementId: string,
    update: Partial<MathElementV3>,
    message: string,
  ) => {
    if (!editable) return;
    const before = operationElementsRef.current[elementId];
    if (!before || before.kind !== "math") return;
    if (update.autoRecognition === "disabled"
      || (update.autoRecognition === "inherit" && !pageMathSettingsRef.current.autoRecognition)) {
      recognitionScheduler.cancel(elementId);
      recognitionBaselinesRef.current.delete(elementId);
    }
    const after: MathElementV3 = { ...before, ...update, updatedAt: now() };
    const beforePatch = mathUpdateBeforePatch(before, update);
    commitChanges(
      message,
      { upserts: [after] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId, before: beforePatch, after: { ...update, updatedAt: after.updatedAt } }],
      },
    );
  }, [commitChanges, createId, deviceId, editable, now, recognitionScheduler]);

  const updateMathSettings = useCallback((update: Partial<typeof pageMathSettings>) => {
    if (!editable) return;
    if (update.autoRecognition === false) {
      recognitionScheduler.dispose();
      recognitionBaselinesRef.current.clear();
    }
    void onChange("Update math page settings", (draft) => {
      draft.mathSettings = { ...pageMathSettings, ...update };
      draft.updatedAt = now();
    });
  }, [editable, now, onChange, pageMathSettings, recognitionScheduler]);

  const updateGraphElement = useCallback((
    elementId: string,
    update: Partial<GraphElementV3>,
    message: string,
  ) => {
    if (!editable) return;
    const before = operationElementsRef.current[elementId];
    if (!before || before.kind !== "graph") return;
    const after: GraphElementV3 = { ...before, ...update, updatedAt: now() };
    const beforePatch = elementUpdateBeforePatch(before, update);
    commitChanges(
      message,
      { upserts: [after] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId, before: beforePatch, after: { ...update, updatedAt: after.updatedAt } }],
      },
    );
  }, [commitChanges, createId, deviceId, editable, now]);

  const publishRecognitionUpdate = useCallback((next: MathElementV3, reason: string) => {
    if (reason === "scheduled" || reason === "pending" || reason === "provider-error") {
      void onChange(`Math recognition ${reason}`, (draft) => {
        const current = draft.elementsById[next.id];
        if (!current || current.kind !== "math" || !current.rawInk || !next.rawInk) return;
        current.recognition = structuredClone(next.recognition);
        current.updatedAt = now();
      });
      return;
    }
    const baseline = recognitionBaselinesRef.current.get(next.id);
    recognitionBaselinesRef.current.delete(next.id);
    const current = operationElementsRef.current[next.id];
    if (!baseline || !current || current.kind !== "math" || !current.rawInk || !next.rawInk) return;
    const timestamp = now();
    const after: MathElementV3 = {
      ...current,
      recognition: structuredClone(next.recognition),
      result: structuredClone(next.result),
      dependencies: structuredClone(next.dependencies),
      updatedAt: timestamp,
    };
    if (next.recognizedLatex === undefined) delete after.recognizedLatex;
    else after.recognizedLatex = next.recognizedLatex;
    const patches = recognitionFinalPatches(baseline, after, timestamp);
    commitChanges(
      `Math recognition ${reason}`,
      { upserts: [after] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: next.id, before: patches.before, after: patches.after }],
      },
    );
  }, [commitChanges, createId, deviceId, now, onChange]);

  const startRecognition = useCallback((
    element: MathElementV3,
    trigger: "activeLocalMathBlock" | "explicitUserSelection",
    force = false,
  ) => {
    const attestation = attestLocalMathGesture({
      element,
      trigger,
      operationId: recognitionSafeId(createId("math-recognition-operation")),
      requestId: recognitionSafeId(createId("math-recognition-request")),
      provider: activeRecognitionProvider.kind,
      locale: language,
      decimalSeparator: language === "de" ? "comma" : "dot",
    });
    recognitionBaselinesRef.current.set(element.id, structuredClone(element));
    const scheduledElement = force ? { ...element, autoRecognition: "enabled" as const } : element;
    const guardedProvider: RecognitionProvider = {
      kind: activeRecognitionProvider.kind,
      status: () => activeRecognitionProvider.status(),
      recognize: (selection, options) => {
        const current = operationElementsRef.current[element.id];
        const settings = pageMathSettingsRef.current;
        if (!mayDispatchMathRecognition(current, element, settings, force)) {
          throw new RecognitionError("aborted", "Math recognition was cancelled before dispatch.");
        }
        return activeRecognitionProvider.recognize(selection, options);
      },
    };
    const scheduled = recognitionScheduler.schedule({
      element: scheduledElement,
      pageSettings: force ? { ...pageMathSettings, autoRecognition: true } : pageMathSettings,
      attestation,
      provider: guardedProvider,
      onUpdate: publishRecognitionUpdate,
    });
    if (scheduled === scheduledElement) recognitionBaselinesRef.current.delete(element.id);
  }, [activeRecognitionProvider, createId, language, pageMathSettings, publishRecognitionUpdate, recognitionScheduler]);
  const recognizeMathNow = useCallback((elementId: string) => {
    const current = operationElementsRef.current[elementId];
    if (!editable || !current || current.kind !== "math" || !current.rawInk) return;
    recognitionScheduler.cancel(elementId);
    recognitionBaselinesRef.current.delete(elementId);
    startRecognition(current, "explicitUserSelection", true);
  }, [editable, recognitionScheduler, startRecognition]);

  const revealRegionRef = useRef<(region: Rect) => void>(() => undefined);
  const controller = useMemo<LiveCanvasController>(
    () => ({
      selectTool,
      revealRegion: (region) => revealRegionRef.current(region),
      clearSelection: () => setSelectedIds([]),
      undo,
      redo,
      copy,
      paste,
      createText,
      exportPerformanceEvidence: () =>
        performanceRef.current.exportPenPerformanceAcceptanceEvidence(
          performanceEvidenceBinding(),
        ),
    }),
    [copy, createText, paste, redo, selectTool, undo],
  );
  useEffect(
    () => onControllerReady?.(controller),
    [controller, onControllerReady],
  );

  const updateRuler = useCallback(
    (update: Partial<CanvasRulerState>) => {
      if (!editable) return;
      setRulersByPage((current) => {
        const base = current[page.documentId] ?? loadRulerPreference(page.documentId);
        return { ...current, [page.documentId]: {
            ...base,
            ...update,
            x: Math.min(dimensions.width, Math.max(0, update.x ?? base.x)),
            y: Math.min(dimensions.height, Math.max(0, update.y ?? base.y)),
            angleDegrees: normalizeRulerAngle(update.angleDegrees ?? base.angleDegrees),
          } };
      });
    },
    [dimensions.height, dimensions.width, editable, page.documentId],
  );

  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) return;
    const mode = (event.target as Element)
      .closest<HTMLElement>("[data-ruler-action]")
      ?.dataset.rulerAction;
    if (mode !== "move" && mode !== "rotate") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = eventPoint(event, rootRef.current, viewport.zoom);
    setRulerGesture({
      pointerId: event.pointerId,
      mode,
      offset: { x: point.x - ruler.x, y: point.y - ruler.y },
    });
  };

  const onRulerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rulerGesture || rulerGesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = eventPoint(event, rootRef.current, viewport.zoom);
    if (rulerGesture.mode === "move") {
      updateRuler({
        x: point.x - rulerGesture.offset.x,
        y: point.y - rulerGesture.offset.y,
      });
      return;
    }
    updateRuler({
      angleDegrees: Math.atan2(point.y - ruler.y, point.x - ruler.x) * 180 / Math.PI,
    });
  };

  const finishRulerGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rulerGesture || rulerGesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setRulerGesture(null);
  };

  const clearInkShapeHoldTimer = () => {
    if (inkShapeHoldTimerRef.current === null) return;
    clearTimeout(inkShapeHoldTimerRef.current);
    inkShapeHoldTimerRef.current = null;
  };

  const showHeldShape = (candidate: HeldInkShapeCandidate | null) => {
    if (heldShapeRef.current === candidate) return;
    heldShapeRef.current = candidate;
    setHeldShape(candidate);
  };

  const armInkShapeHold = (live: LiveGesture) => {
    clearInkShapeHoldTimer();
    if (live.tool !== "pen" || live.points.length < 4) return;
    const lastPointTime = live.points[live.points.length - 1]?.time;
    inkShapeHoldTimerRef.current = setTimeout(() => {
      inkShapeHoldTimerRef.current = null;
      const current = liveRef.current;
      if (current !== live || live.points[live.points.length - 1]?.time !== lastPointTime) return;
      const candidate = recognizeHeldInkShape(live.points);
      if (!candidate) return;
      // The cleaned-up shape replaces the freehand preview until the pen moves on.
      clearOverlay(overlayRef.current);
      showHeldShape(candidate);
    }, INK_SHAPE_HOLD_MS);
  };

  const onRulerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!editable || !event.key.startsWith("Arrow")) return;
    const amount = event.shiftKey ? 10 : 1;
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      updateRuler({
        angleDegrees: ruler.angleDegrees + (event.key === "ArrowLeft" ? -amount : amount),
      });
      return;
    }
    const movement = {
      ArrowLeft: { x: -amount, y: 0 },
      ArrowRight: { x: amount, y: 0 },
      ArrowUp: { x: 0, y: -amount },
      ArrowDown: { x: 0, y: amount },
    }[event.key];
    if (!movement) return;
    event.preventDefault();
    updateRuler({ x: ruler.x + movement.x, y: ruler.y + movement.y });
  };

  /**
   * Repaints the overlay from the live gesture; runs inside pointer handlers.
   * `predicted` is where the browser expects the pen to be a frame from now:
   * it is drawn as part of the live stroke and never stored.
   */
  const paintLive = (live: LiveGesture, predicted: readonly StrokePointV2[] = []) => {
    const overlay = overlayRef.current;
    if (!overlay || !live.overlay) return;
    if (live.painter) {
      live.painter.update(live.points, predicted);
    } else if (live.style) {
      const drawn = predicted.length > 0 ? [...live.points, ...predicted] : live.points;
      const points = live.snap ? drawn.map((point) => live.snap!(point)) : drawn;
      paintLiveInk(overlay, live.overlay, settledInkRef.current.map((item) => item.stroke), {
        ...live.style,
        points,
      });
    } else if (live.tool === "lasso") {
      paintGuide(overlay, live.overlay, live.points, "lasso");
    } else if (live.tool === "rectSelect" || live.tool === "snip") {
      paintGuide(overlay, live.overlay, [live.start, live.points[live.points.length - 1] ?? live.start], "rect");
    } else if (live.tool === "pointEraser" || live.tool === "strokeEraser") {
      paintGuide(overlay, live.overlay, live.points, "eraser");
    } else if (SHAPE_TOOLS.has(live.tool)) {
      paintGuide(overlay, live.overlay, [live.start, live.points[live.points.length - 1] ?? live.start], "shape");
    }
  };

  /** Shows the strokes that wait for their tile, and nothing else, when no stroke is being drawn. */
  const repaintSettledInk = () => {
    const overlay = overlayRef.current;
    if (!overlay || liveRef.current) return;
    const settled = settledInkRef.current;
    if (settled.length === 0) clearOverlay(overlay);
    else paintLiveInk(overlay, settled[0].transform, settled.map((item) => item.stroke), null);
  };

  /** The stroke eraser removes every stroke the swipe touches, not only the first one hit. */
  const collectErased = (live: LiveGesture, from: Point, to: Point) => {
    const radius = STROKE_ERASER_RADIUS / Math.max(0.25, live.zoom);
    const before = live.erased.size;
    for (const id of strokesCrossedBy(operationElementsRef.current, from, to, radius)) live.erased.add(id);
    if (live.erased.size !== before) setErasingIds(new Set(live.erased));
  };

  const startLiveGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    point: Point,
    gestureTool: LiveGestureTool = tool,
    viaPenButton = false,
  ) => {
    const tool = gestureTool;
    const surface = rootRef.current;
    const overlay = overlayRef.current;
    const rect = surface?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const inkTool = tool === "pen" || tool === "highlighter" || tool === "math";
    const seen = new SampleDeduper();
    const firstPoints = inkTool
      ? seen.fresh(livePoints(event, { left: rect.left, top: rect.top }, viewport.zoom, activePreset))
      : [pointToStrokePoint(point, event.timeStamp)];
    const activeRuler = (tool === "pen" || tool === "highlighter")
      && ruler.visible
      && firstPoints[0]
      && distanceToRulerEdge(firstPoints[0], rulerEdgeGeometry(ruler)) <= RULER_SNAP_DISTANCE
      ? ruler
      : undefined;
    const start = firstPoints[0] ?? point;
    const live: LiveGesture = {
      pointerId: event.pointerId,
      tool,
      ...(viaPenButton ? { viaPenButton } : {}),
      start,
      points: firstPoints,
      rect: { left: rect.left, top: rect.top },
      zoom: viewport.zoom,
      overlay: overlay && surface ? overlayTransform(overlay, surface, viewport.zoom) : null,
      style: inkTool && activePreset
        ? {
            tool: tool === "highlighter" ? "highlighter" : "pen",
            color: activePreset.color,
            size: activePreset.size,
            opacity: tool === "math" ? 1 : activePreset.opacity,
            points: [],
          }
        : null,
      snap: (tool === "pen" || tool === "highlighter") && (gridSnap || angleSnap || activeRuler)
        ? (candidate) => snapDrawPoint(candidate, gridSnap, angleSnap, activeRuler, start)
        : undefined,
      erased: new Set(),
      seen,
      predicted: [],
    };
    liveRef.current = live;
    inkQueue.noteActivity();
    if (overlay) overlay.dataset.blend = tool === "highlighter" ? "multiply" : "";
    if (overlay && live.overlay && live.style && tool === "pen" && live.style.opacity >= 1 && !live.snap && firstPoints[0]?.pointerType === "pen") {
      live.painter = new LiveStrokePainter(
        overlay,
        live.overlay,
        { color: live.style.color, shape: { size: live.style.size, thinning: PEN_THINNING } },
        () => settledInkRef.current.map((item) => item.stroke),
      );
    }
    if (tool === "strokeEraser") collectErased(live, point, point);
    paintLive(live);
    if (live.style && tool !== "math") presence?.inkProgress(live.style, live.points);
  };

  /** Viewport position relative to the page origin before pan and zoom. */
  const viewportAnchor = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      x: clientX - (rect?.left ?? 0) - (rootRef.current?.offsetLeft ?? 0),
      y: clientY - (rect?.top ?? 0) - (rootRef.current?.offsetTop ?? 0),
    };
  };

  const startPinch = () => {
    cancelLongPress();
    const [first, second] = [...touchesRef.current.values()];
    if (!first || !second) return;
    // A second finger turns whatever the first one started into a pinch.
    if (readingDragRef.current) readingRef.current?.onSwipeProgress?.(0);
    readingDragRef.current = null;
    cancelLiveGesture();
    gestureRef.current = null;
    setGesture(null);
    pinchRef.current = {
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      center: viewportAnchor((first.x + second.x) / 2, (first.y + second.y) / 2),
      viewport: readingMode ? liveViewportRef.current : viewport,
    };
  };

  const movePinch = (pinch: PinchGesture) => {
    const [first, second] = [...touchesRef.current.values()];
    if (!first || !second) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const center = viewportAnchor((first.x + second.x) / 2, (first.y + second.y) / 2);
    const zoomed = zoomViewportAroundPoint(
      pinch.viewport,
      pinch.viewport.zoom * (distance / pinch.distance),
      pinch.center,
    );
    // The reading view lets a pinch go past its bounds and settles afterwards.
    (readingMode ? placeViewport : setViewport)({
      ...zoomed,
      panX: zoomed.panX + center.x - pinch.center.x,
      panY: zoomed.panY + center.y - pinch.center.y,
    });
  };

  /** Forgets one finger and whatever it started: a pinch, a pan, a stroke or a long press. */
  const releaseTouchPointer = (pointerId: number) => {
    touchesRef.current.delete(pointerId);
    if (longPressRef.current?.pointerId === pointerId) cancelLongPress();
    if (pinchRef.current && touchesRef.current.size < 2) pinchRef.current = null;
    if (liveRef.current?.pointerId === pointerId) cancelLiveGesture();
    if (gestureRef.current?.pointerId === pointerId) {
      gestureRef.current = null;
      setGesture(null);
    }
  };

  /** A pen in range turns every finger on the glass into a resting palm. */
  const dropTouchGestures = () => {
    for (const pointerId of [...touchesRef.current.keys()]) releaseTouchPointer(pointerId);
  };

  const notePenEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    notePenSeen();
    lastPenAtRef.current = event.timeStamp;
    dropTouchGestures();
  };

  /**
   * The dot (or the eraser ring) that follows a hovering pen. It is moved
   * straight on the DOM node: a hover move must not re-render the page.
   */
  const updatePenCursor = (event: ReactPointerEvent<HTMLDivElement>) => {
    const cursor = penCursorRef.current;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!cursor || !viewportRect) return;
    const action = penButtonAction(event, buttonMapping);
    const erasing = action === "eraser" || tool === "strokeEraser" || tool === "pointEraser";
    const touching = (event.buttons & 1) !== 0;
    // Drawn ink is its own feedback; only erasing keeps a ring while touching.
    if (touching && !erasing) {
      cursor.hidden = true;
      return;
    }
    const size = erasing
      ? PEN_ERASER_CURSOR_SIZE
      : Math.min(40, Math.max(6, (activePreset?.size ?? 3) * viewport.zoom));
    cursor.dataset.kind = action && !erasing ? "lasso" : erasing ? "eraser" : "pen";
    cursor.style.width = `${size}px`;
    cursor.style.height = `${size}px`;
    cursor.style.transform = `translate(${event.clientX - viewportRect.left - size / 2}px, ${event.clientY - viewportRect.top - size / 2}px)`;
    cursor.hidden = false;
  };

  const hidePenCursor = () => {
    if (penCursorRef.current) penCursorRef.current.hidden = true;
  };

  /** The canvas owns this gesture, so the browser must not start a text selection or drag. */
  const claimCanvasGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    canvasGestureRef.current = true;
    const domSelection = window.getSelection();
    if (domSelection && domSelection.type === "Range") domSelection.removeAllRanges();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is no longer active cannot be captured; the gesture still runs.
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The phone viewer never draws: a stylus is ignored, so it cannot write ink.
    if (VIEWER_APP && event.pointerType === "pen") return;
    // A finger on the glass stops a flick, as in any native list.
    if (readingMode) stopReadingAnimation();
    const mappedAction = penButtonAction(event, buttonMapping);
    // A screen clip needs the page renderer; without it the button leaves the pen writing.
    const penAction = mappedAction === "screenshot" && !renderRegionImage ? null : mappedAction;
    if (captured) setCaptured(null);
    // The right mouse button opens the context menu through the contextmenu
    // event; it never draws or selects. A pen's barrel button acts as chosen
    // in the pen menu instead.
    if (event.pointerType === "pen") {
      notePenEvent(event);
      updatePenCursor(event);
    } else if (event.button === 2) return;
    cancelLongPress();
    if (!acceptPointer(event, "down", rootRef.current, palmRef, viewport.zoom)) return;
    // Writing ink leaves the strokes waiting for a quiet moment; anything else
    // reads or changes the page, which must hold every stroke drawn so far.
    // The render is forced too: the gesture hit-tests the page when the pen
    // lifts, and must find the strokes that were only waiting.
    if (!((tool === "pen" || tool === "highlighter") && !penAction) && inkQueue.size > 0) flushSync(() => inkQueue.flush());
    const onPage = event.target instanceof Node && Boolean(rootRef.current?.contains(event.target));
    const touch = event.pointerType === "touch";
    if (touch) {
      touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchesRef.current.size >= 2) {
        startPinch();
        return;
      }
      // A finger held still opens the context menu, as a long press does in
      // OneNote; iPadOS sends no contextmenu event for it. The reading view
      // leaves a long press to the system (selecting text to copy).
      const client = { x: event.clientX, y: event.clientY };
      const target = event.target;
      if (!readingMode) {
        longPressRef.current = {
          pointerId: event.pointerId,
          client,
          timer: setTimeout(() => {
            longPressRef.current = null;
            openContextMenu(client, target);
          }, LONG_PRESS_MS),
        };
      }
    }
    // Fingers pan once a pen is in use (or when touch drawing is off), and
    // anything that lands beside the page pans it rather than drawing. In the
    // reading view every press outside text moves the page.
    const wantsPan = tool === "pan"
      || readingMode
      || event.button === 1
      || (touch && (!touchDrawsNow || !editable))
      || (!onPage && event.pointerType !== "pen");
    if (!editable && !wantsPan) return;
    if (!onPage && !wantsPan) return;
    const point = eventPoint(event, rootRef.current, viewport.zoom);
    clearInkShapeHoldTimer();
    // Inside text the pointer places the caret and selects words, as in
    // OneNote; the container moves only by its grip (see LiveElement).
    if (penAction && editable && onPage) {
      claimCanvasGesture(event);
      startLiveGesture(event, point, PEN_ACTION_GESTURES[penAction], true);
      return;
    }
    const textElementId = tool === "select" && isTextEntryTarget(event.target)
      ? findElementId(event.target)
      : undefined;
    if (textElementId) {
      if (!activeSelectedIds.includes(textElementId)) setSelectedIds([textElementId]);
      if ((VIEWER_APP || readingMode) && touch) {
        tapPanRef.current = {
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          viewport: readingMode ? liveViewportRef.current : viewport,
        };
      }
      return;
    }
    // The reading view: a text block is taller than its text (a minimum height, space the person
    // left below the lines). A tap there belongs to the block as much as a tap on a line: it starts
    // editing, and only a drag pans. Without this the tap fell through to the page and merely hid
    // the app bars.
    const textBlock = readingMode && touch && tool === "select" ? textBlockUnder(event.target, operationElementsRef.current) : undefined;
    if (textBlock) {
      setSelectedIds([textBlock.id]);
      tapPanRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        viewport: liveViewportRef.current,
        focus: textBlock.editor,
      };
      return;
    }
    // The canvas owns this gesture: a text selection left by an earlier
    // stroke would otherwise turn the next mouse stroke into a native text
    // drag, which cancels the pointer and loses the stroke.
    claimCanvasGesture(event);
    if (readingMode) {
      startReadingDrag(event.pointerId, { x: event.clientX, y: event.clientY }, liveViewportRef.current);
      return;
    }
    if (wantsPan) {
      if (!onPage && tool === "select") setSelectedIds(clearedSelection);
      setGesture({
        pointerId: event.pointerId,
        start: point,
        points: [],
        screenStart: { x: event.clientX, y: event.clientY },
        viewportStart: viewport,
      });
      return;
    }
    const resizeHandle = findSelectionResizeHandle(event.target);
    const selectionFrame = selectionBounds(operationElements, activeSelectedIds);
    const insideSelection = selectionFrame !== null
      && point.x >= selectionFrame.x && point.x <= selectionFrame.x + selectionFrame.width
      && point.y >= selectionFrame.y && point.y <= selectionFrame.y + selectionFrame.height;
    if (penSelectionActive && !insideSelection && !resizeHandle) setSelectedIds(clearedSelection);
    if ((tool === "lasso" || penSelectionActive) && activeSelectedIds.length > 0 && (insideSelection || resizeHandle)) {
      // After a lasso, the selection is picked up and moved like in OneNote,
      // also with the pen tip after a pen button made the selection.
      const nextGesture: ActiveGesture = resizeHandle && selectionFrame
        ? {
            pointerId: event.pointerId,
            start: point,
            points: [],
            resize: {
              handle: resizeHandle,
              bounds: selectionFrame,
              transform: resizeSelectionFromCorner(selectionFrame, resizeHandle, point),
            },
          }
        : { pointerId: event.pointerId, start: point, points: [], drag: true };
      event.preventDefault();
      gestureRef.current = nextGesture;
      setGesture(nextGesture);
      return;
    }
    if (tool === "select") {
      if (resizeHandle && selectionFrame) {
        event.preventDefault();
        const nextGesture: ActiveGesture = {
          pointerId: event.pointerId,
          start: point,
          points: [],
          resize: {
            handle: resizeHandle,
            bounds: selectionFrame,
            transform: resizeSelectionFromCorner(selectionFrame, resizeHandle, point),
          },
        };
        gestureRef.current = nextGesture;
        setGesture(nextGesture);
        return;
      }
      const elementId = elementAtPoint(event.target, point);
      const keepsSelection = !event.shiftKey
        && activeSelectedIds.length > 0
        && (elementId ? activeSelectedIds.includes(elementId) : insideSelection && activeSelectedIds.length > 1);
      if (keepsSelection) {
        const nextGesture: ActiveGesture = {
          pointerId: event.pointerId,
          start: point,
          points: [],
          elementId,
          drag: true,
        };
        gestureRef.current = nextGesture;
        setGesture(nextGesture);
        return;
      }
      if (elementId)
        setSelectedIds(
          event.shiftKey ? toggleId(selectedIds, elementId) : [elementId],
        );
      else setSelectedIds([]);
      // The first click next to a selected drawing only clears the selection;
      // from a text container (or nothing) a click starts a new note at once.
      const clickToType =
        !elementId &&
        editable &&
        event.button === 0 &&
        !event.shiftKey &&
        activeSelectedIds.every((id) => operationElements[id]?.kind === "richText");
      const nextGesture: ActiveGesture = {
        pointerId: event.pointerId,
        start: point,
        points: [],
        elementId,
        drag: Boolean(elementId) && !event.shiftKey,
        clickToType,
      };
      gestureRef.current = nextGesture;
      setGesture(nextGesture);
      return;
    }
    if (tool === "math" && event.pointerType !== "pen") {
      createTypedMathAt(point);
      return;
    }
    startLiveGesture(event, point);
  };

  /**
   * The element under the pointer for selection: a DOM element (text, image,
   * shape, Math) or the ink selection frame it hit, unless a stroke painted
   * above that element is under the pointer, which then wins.
   */
  const elementAtPoint = (target: EventTarget, point: Point): string | undefined => {
    const domId = findElementId(target);
    const order = zOrderRef.current;
    const floor = domId ? order.indexOf(domId) : -1;
    const strokeId = topmostStrokeAt(
      operationElementsRef.current,
      order,
      point,
      STROKE_HIT_TOLERANCE / Math.max(0.25, viewport.zoom),
      operationElementsRef.current[domId ?? ""]?.kind === "stroke" ? -1 : floor,
    );
    return strokeId ?? domId;
  };

  const moveLiveGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    live: LiveGesture,
  ) => {
    if (!acceptPointer(event, "move", rootRef.current, palmRef, viewport.zoom)) return;
    const startedAt = performanceClockNow();
    const inkTool = live.style !== null;
    const samples = inkTool
      ? live.seen.fresh(livePoints(event, live.rect, live.zoom, activePreset))
      : [pointToStrokePoint(
          clientPointToCanvas({ x: event.clientX, y: event.clientY }, live.rect, live.zoom),
          event.timeStamp,
        )];
    // Samples that already arrived as raw updates are not new, but the
    // prediction still moves with every frame.
    if (samples.length === 0 && !live.painter) return;
    const previous = live.points[live.points.length - 1] ?? live.start;
    if (SHAPE_TOOLS.has(live.tool)) live.points = [samples[samples.length - 1]];
    else live.points.push(...samples);
    if (live.tool === "strokeEraser") {
      let from: Point = previous;
      for (const sample of samples) {
        collectErased(live, from, sample);
        from = sample;
      }
    }
    if (heldShapeRef.current) showHeldShape(null);
    live.predicted = inkTool ? predictedPoints(event, live.rect, live.zoom, activePreset) : [];
    paintLive(live, live.predicted);
    if (live.style && live.tool !== "math") presence?.inkProgress(live.style, live.points);
    armInkShapeHold(live);
    if (live.tool === "pen" || live.tool === "highlighter") {
      recordPenPreviewOnNextFrame(
        performanceRef.current,
        startedAt,
        (callback) => {
          const recordAndRefresh = () => {
            callback();
            if (performanceEvidenceReadyRef.current) return;
            // Past the 45-minute session an export that misses the gate sorts
            // every sample; trying on every frame made a long lesson lag.
            const triedAt = performanceClockNow();
            if (triedAt - performanceEvidenceTriedAtRef.current < PERFORMANCE_EVIDENCE_RETRY_MS) return;
            performanceEvidenceTriedAtRef.current = triedAt;
            try {
              performanceRef.current.exportPenPerformanceAcceptanceEvidence(
                performanceEvidenceBinding(),
              );
              performanceEvidenceReadyRef.current = true;
              setPerformanceEvidenceReady(true);
            } catch {
              // Not enough samples yet.
            }
          };
          if (typeof requestAnimationFrame === "function")
            requestAnimationFrame(recordAndRefresh);
          else setTimeout(recordAndRefresh, 0);
        },
        performanceClockNow,
      );
    }
  };

  /**
   * `pointerrawupdate` hands over each digitizer sample as it arrives, up to a
   * frame before the `pointermove` that carries it in its coalesced list. The
   * pen's line is extended at once; the move then finds those samples taken
   * (see SampleDeduper) and only refreshes the prediction.
   */
  const takeRawPenUpdate = (event: PointerEvent) => {
    const live = liveRef.current;
    if (!live?.painter || event.pointerId !== live.pointerId || event.pointerType !== "pen" || event.buttons === 0) return;
    const samples = live.seen.fresh(
      inkSamples(event, event.getCoalescedEvents?.() ?? [], live.rect, live.zoom, activePreset),
    );
    if (samples.length === 0) return;
    live.points.push(...samples);
    // The last prediction stays only while it is still ahead of the pen.
    const tip = live.points[live.points.length - 1];
    const before = live.points[live.points.length - 2];
    const heading = before ? { x: tip.x - before.x, y: tip.y - before.y } : null;
    const ahead = heading
      ? live.predicted.filter((point) => (point.x - tip.x) * heading.x + (point.y - tip.y) * heading.y > 0)
      : [];
    live.painter.update(live.points, ahead);
  };
  const rawPenUpdateRef = useRef(takeRawPenUpdate);
  useLayoutEffect(() => {
    rawPenUpdateRef.current = takeRawPenUpdate;
  });
  useEffect(() => {
    if (!("onpointerrawupdate" in window)) return;
    const listener = (event: Event) => rawPenUpdateRef.current(event as PointerEvent);
    window.addEventListener("pointerrawupdate", listener);
    return () => window.removeEventListener("pointerrawupdate", listener);
  }, []);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (VIEWER_APP && event.pointerType === "pen") return;
    // Every move counts for palm rejection, hovering pens included: a pen in
    // range keeps the window open that ignores fingers and palms.
    const accepted = acceptPointer(event, "move", rootRef.current, palmRef, viewport.zoom);
    if (event.pointerType === "pen") {
      notePenEvent(event);
      updatePenCursor(event);
    } else if (event.pointerType === "touch" && !accepted) {
      releaseTouchPointer(event.pointerId);
      return;
    }
    const press = longPressRef.current;
    if (press && press.pointerId === event.pointerId
      && Math.hypot(event.clientX - press.client.x, event.clientY - press.client.y) > LONG_PRESS_SLOP) {
      cancelLongPress();
    }
    const tap = tapPanRef.current;
    if (tap && tap.pointerId === event.pointerId && !pinchRef.current) {
      if (Math.hypot(event.clientX - tap.start.x, event.clientY - tap.start.y) <= TAP_PAN_SLOP) return;
      // The finger moved: it is a pan, not a tap into the text.
      tapPanRef.current = null;
      cancelLongPress();
      claimCanvasGesture(event);
      if (readingMode) {
        startReadingDrag(event.pointerId, tap.start, tap.viewport);
      } else {
        const panning: ActiveGesture = { pointerId: event.pointerId, start: tap.start, points: [], screenStart: tap.start, viewportStart: tap.viewport };
        gestureRef.current = panning;
        setGesture(panning);
      }
    }
    const readingDrag = readingDragRef.current;
    if (readingDrag && readingDrag.pointerId === event.pointerId && !pinchRef.current) {
      if (event.pointerType === "touch") touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moveReadingDrag(readingDrag, { x: event.clientX, y: event.clientY });
      return;
    }
    if (presence && !liveRef.current) presence.pointer(eventPoint(event, rootRef.current, viewport.zoom));
    if (event.pointerType === "touch" && touchesRef.current.has(event.pointerId)) {
      touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinch = pinchRef.current;
      if (pinch) {
        movePinch(pinch);
        return;
      }
    }
    const live = liveRef.current;
    if (live) {
      if (live.pointerId !== event.pointerId) return;
      // A pen or mouse moving with no button down has lost its release (it
      // left the window or the digitizer); hovering must never draw.
      if (event.pointerType !== "touch" && event.buttons === 0) finishLiveGesture(event, live);
      else moveLiveGesture(event, live);
      return;
    }
    const current = gestureRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.screenStart && current.viewportStart) {
      setViewport({
        ...current.viewportStart,
        panX:
          current.viewportStart.panX + event.clientX - current.screenStart.x,
        panY:
          current.viewportStart.panY + event.clientY - current.screenStart.y,
      });
      return;
    }
    const point = eventPoint(event, rootRef.current, viewport.zoom);
    if (current.resize) {
      const nextGesture: ActiveGesture = {
        ...current,
        resize: {
          ...current.resize,
          transform: resizeSelectionFromCorner(
            current.resize.bounds,
            current.resize.handle,
            point,
          ),
        },
      };
      gestureRef.current = nextGesture;
      setGesture(nextGesture);
      return;
    }
    if (current.drag) {
      const translate = { x: point.x - current.start.x, y: point.y - current.start.y };
      // Below the click slop a press is still a click, not a move.
      if (!current.translate && Math.hypot(translate.x, translate.y) < CLICK_TO_TYPE_SLOP) return;
      const nextGesture: ActiveGesture = { ...current, translate };
      gestureRef.current = nextGesture;
      setGesture(nextGesture);
    }
  };

  /** Selects `ids`; a selection a pen button made stays movable with the pen tip. */
  const selectWithPen = (ids: string[], viaPenButton = false) => {
    setSelectedIds(ids);
    setPenSelection(viaPenButton && ids.length > 0 ? { key: ids.join("|"), tool } : null);
  };

  /**
   * Renders the clip, copies it to the clipboard (started inside the pen-up
   * gesture so the browser still allows it) and offers to insert it as an image.
   */
  const captureRegion = (region: Rect) => {
    if (!renderRegionImage || !isUsableRegion(region)) return;
    const ids = elementIdsInRegion(operationElementsRef.current, zOrderRef.current, region);
    const picture = renderRegionImage(operationElementsRef.current, ids, region);
    const copying = typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
      ? navigator.clipboard.write([new ClipboardItem({ "image/png": picture })]).then(() => true, () => false)
      : Promise.resolve(false);
    void Promise.all([picture, copying]).then(([png, copied]) => {
      setCaptured({ png, copied, at: { x: region.x, y: region.y + region.height } });
      setClipboardStatus(t(copied ? "canvas.capture.copied" : "canvas.capture.notCopied"));
    }, () => setClipboardStatus(t("canvas.capture.failed")));
  };

  /**
   * Ends the gesture on the pen's release. `cancelled` is the browser taking
   * the pointer away (pointercancel): the position of such an event means
   * nothing, so the stroke ends at the last sample it had, and is kept.
   */
  const finishLiveGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    live: LiveGesture,
    cancelled = false,
  ) => {
    liveRef.current = null;
    clearInkShapeHoldTimer();
    presence?.inkEnd();
    const candidate = heldShapeRef.current;
    showHeldShape(null);
    acceptPointer(event, "up", rootRef.current, palmRef, viewport.zoom);
    const end = clientPointToCanvas({ x: event.clientX, y: event.clientY }, live.rect, live.zoom);
    let keepOverlay = false;
    if ((live.tool === "pen" || live.tool === "highlighter") && activePreset) {
      const lastMovementTime = live.points[live.points.length - 1]?.time ?? event.timeStamp;
      if (!cancelled) live.points.push(...live.seen.fresh(livePoints(event, live.rect, live.zoom, activePreset)));
      const releasePoints = live.points;
      const heldCandidate = live.tool === "pen"
        ? candidate ?? (
            event.timeStamp - lastMovementTime >= INK_SHAPE_HOLD_MS - 40
              ? recognizeHeldInkShape(releasePoints)
              : undefined
          )
        : undefined;
      if (heldCandidate) createHeldShape(heldCandidate);
      else {
        keepOverlay = createStroke(releasePoints);
        // The painter has drawn the stroke as it grew; it only takes back the
        // predicted tail. No outline has to be built for the overlay here.
        if (keepOverlay && live.painter) {
          live.painter.update(live.points, []);
          return;
        }
      }
    } else if (live.tool === "math" && activePreset) {
      createInkMath([...live.points, ...live.seen.fresh(livePoints(event, live.rect, live.zoom, activePreset))]);
    } else if (SHAPE_TOOLS.has(live.tool)) {
      createShape(live.start, end);
    } else if (live.tool === "lasso") {
      selectWithPen(selectByLasso(operationElementsRef.current, [...live.points, end]), live.viaPenButton);
    } else if (live.tool === "rectSelect") {
      selectWithPen(selectByRect(operationElementsRef.current, rectBetween(live.start, end)), live.viaPenButton);
    } else if (live.tool === "snip") {
      captureRegion(rectBetween(live.start, end));
    } else if (live.tool === "pointEraser") {
      erasePoints([...live.points, pointToStrokePoint(end, event.timeStamp)]);
    } else if (live.tool === "strokeEraser") {
      collectErased(live, live.points[live.points.length - 1] ?? end, end);
      eraseStrokes([...live.erased]);
      setErasingIds(NO_IDS);
    }
    // The overlay carries the pen's predicted tail. Once the pen is up it
    // shows the finished strokes exactly as their tile will, until that tile
    // has them (see the settled-ink effect).
    if (settledInkRef.current.length > 0 && live.overlay && overlayRef.current) {
      paintLiveInk(overlayRef.current, live.overlay, settledInkRef.current.map((item) => item.stroke), null);
    } else if (!keepOverlay) {
      clearOverlay(overlayRef.current);
    }
  };

  const cancelLiveGesture = () => {
    if (!liveRef.current) return;
    liveRef.current = null;
    clearInkShapeHoldTimer();
    presence?.inkEnd();
    showHeldShape(null);
    setErasingIds(NO_IDS);
    // Strokes that wait to be written stay on screen.
    repaintSettledInk();
  };

  /** Forgets a lifted finger; a pinch ends once fewer than two remain. */
  const releaseTouch = (event: ReactPointerEvent<HTMLDivElement>): boolean => {
    if (event.pointerType !== "touch" || !touchesRef.current.delete(event.pointerId)) return false;
    if (!pinchRef.current) return false;
    if (touchesRef.current.size < 2) {
      pinchRef.current = null;
      if (readingMode) settleReading();
    }
    // Fingers of a pinch never draw or select when they lift.
    return true;
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A pen that lifts must leave the palm-rejection state even when nothing
    // was drawn (a tap on text or in an empty selection).
    if (event.pointerType === "pen") acceptPointer(event, "up", rootRef.current, palmRef, viewport.zoom);
    if (longPressRef.current?.pointerId === event.pointerId) cancelLongPress();
    const tapped = tapPanRef.current;
    if (tapped?.pointerId === event.pointerId) {
      tapPanRef.current = null;
      if (tapped.focus?.isConnected && !pinchRef.current) focusAfterTap(tapped.focus);
    }
    if (releaseTouch(event)) return;
    const readingDrag = readingDragRef.current;
    if (readingDrag && readingDrag.pointerId === event.pointerId) {
      finishReadingDrag(readingDrag, { x: event.clientX, y: event.clientY });
      return;
    }
    const live = liveRef.current;
    if (live) {
      if (live.pointerId === event.pointerId) finishLiveGesture(event, live);
      return;
    }
    const current = gestureRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    clearInkShapeHoldTimer();
    acceptPointer(event, "up", rootRef.current, palmRef, viewport.zoom);
    const end = eventPoint(event, rootRef.current, viewport.zoom);
    if (current.screenStart) {
      // Viewport-only gesture. It never mutates Automerge state.
    } else if (current.resize) {
      transformSelected(current.resize.transform, "Resize canvas selection");
    } else if (current.drag && current.translate) {
      transformSelected(
        {
          translateX: end.x - current.start.x,
          translateY: end.y - current.start.y,
        },
        "Move canvas selection",
      );
    } else if (
      tool === "select" &&
      current.clickToType &&
      Math.hypot(end.x - current.start.x, end.y - current.start.y) < CLICK_TO_TYPE_SLOP
    ) {
      createText(end, { recordHistory: false });
    }
    gestureRef.current = null;
    setGesture(null);
  };

  const createShape = (start: Point, end: Point) => {
    const id = createId(tool === "vector" ? "vector" : "shape");
    const element = createShapeFromDrag({
      tool,
      start,
      end,
      id,
      timestamp: now(),
      background: page.background,
      gridSnap,
      angleSnap,
      ruler,
    });
    if (!element) return;
    commitChanges(
      tool === "vector" ? "Create vector" : `Create ${element.shape}`,
      { upserts: [element] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: id, before: null, after: element }],
      },
    );
    setSelectedIds([]);
  };

  const createHeldShape = (candidate: HeldInkShapeCandidate) => {
    if (!activePreset) return;
    const id = createId("held-shape");
    const timestamp = now();
    const element = createHeldInkShapeElement({
      candidate,
      id,
      timestamp,
      color: activePreset.color,
      strokeWidth: activePreset.size,
    });
    commitChanges(
      `Create held ${candidate.shape}`,
      { upserts: [element] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: id, before: null, after: element }],
      },
    );
    setSelectedIds([]);
  };

  /** Returns whether the stroke was committed and now waits on the overlay for its tile. */
  const createStroke = (rawPoints: readonly StrokePointV2[]): boolean => {
    if (!activePreset || rawPoints.length === 0) return false;
    const activeRuler =
      ruler.visible &&
      distanceToRulerEdge(rawPoints[0], rulerEdgeGeometry(ruler)) <= RULER_SNAP_DISTANCE
        ? ruler
        : undefined;
    const points = rawPoints.map((point) =>
      snapDrawPoint(point, gridSnap, angleSnap, activeRuler, rawPoints[0]),
    );
    const id = createId("stroke");
    const timestamp = now();
    const stroke: StrokeElementV2 = {
      id,
      kind: "stroke",
      frame: frameForStroke(points),
      createdAt: timestamp,
      updatedAt: timestamp,
      locked: false,
      tool: activePreset.tool,
      points,
      color: activePreset.color,
      size: activePreset.size,
      opacity: activePreset.opacity,
    };
    const transform = liveOverlayTransform(overlayRef.current, rootRef.current, viewport.zoom);
    if (transform) settledInkRef.current = [...settledInkRef.current, { id, stroke, transform }];
    // The stroke is on screen already; the write to the page waits for the pen
    // to rest, so it cannot hold up the next stroke (see inkCommitQueue).
    inkQueue.enqueue({
      stroke,
      command: {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: id, before: null, after: stroke }],
      },
      forget: () => {
        settledInkRef.current = settledInkRef.current.filter((item) => item.id !== id);
        repaintSettledInk();
      },
    });
    setSelectedIds(clearedSelection);
    return true;
  };

  const createTypedMathAt = (
    point: Point = { x: 80, y: 80 },
    initialLatex = "",
    initialResult?: MathElementV3["result"],
  ) => {
    if (!editable) return;
    const id = createId("math");
    const timestamp = now();
    const element = { ...createTypedMathElement(id, timestamp, {
      x: point.x,
      y: point.y,
      width: 360,
      height: 180,
      rotation: 0,
    }), typedLatex: initialLatex, ...(initialResult ? { result: structuredClone(initialResult) } : {}) };
    commitChanges(
      "Create typed math block",
      { upserts: [element] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: id, before: null, after: element }],
      },
    );
    setSelectedIds([id]);
    setTool("select");
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"] math-field`)
        ?.focus();
    });
  };

  const createInkMath = (points: readonly StrokePointV2[]) => {
    if (!editable || !activePreset || points.length === 0) return;
    const timestamp = now();
    const activeInk = activeSelectedIds.length === 1
      ? operationElements[activeSelectedIds[0]]
      : undefined;
    if (activeInk?.kind === "math" && shouldAppendInkToMathBlock(activeInk, points)) {
      recognitionScheduler.cancel(activeInk.id);
      recognitionBaselinesRef.current.delete(activeInk.id);
      const element = appendInkStrokeToMathElement({
        element: activeInk,
        strokeId: createId("math-raw-stroke"),
        timestamp,
        points,
        color: activePreset.color,
        size: activePreset.size,
      });
      const beforePatch: Partial<MathElementV3> = {
        frame: structuredClone(activeInk.frame),
        rawInk: structuredClone(activeInk.rawInk),
        recognition: structuredClone(activeInk.recognition),
        result: structuredClone(activeInk.result),
        dependencies: structuredClone(activeInk.dependencies),
        updatedAt: activeInk.updatedAt,
        ...(activeInk.recognizedLatex === undefined ? {} : { recognizedLatex: activeInk.recognizedLatex }),
      };
      const afterPatch: Partial<MathElementV3> = {
        frame: structuredClone(element.frame),
        rawInk: structuredClone(element.rawInk),
        recognition: structuredClone(element.recognition),
        result: structuredClone(element.result),
        dependencies: structuredClone(element.dependencies),
        updatedAt: element.updatedAt,
      };
      const confirmation = commitChanges(
        "Append handwritten math stroke",
        { upserts: [element] },
        {
          commandId: createId("command"),
          deviceId,
          patches: [{ elementId: element.id, before: beforePatch, after: afterPatch }],
        },
      );
      if (typeof confirmation === "boolean") {
        if (confirmation) startRecognition(element, "activeLocalMathBlock");
      } else {
        void confirmation.then((committed) => {
          if (committed) startRecognition(element, "activeLocalMathBlock");
        });
      }
      setSelectedIds([element.id]);
      return;
    }
    const id = createId("math");
    const strokeId = createId("math-raw-stroke");
    const element = createInkMathElement({
      id,
      strokeId,
      timestamp,
      points,
      color: activePreset.color,
      size: activePreset.size,
    });
    const confirmation = commitChanges(
      "Create handwritten math block",
      { upserts: [element] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: id, before: null, after: element }],
      },
    );
    if (typeof confirmation === "boolean") {
      if (confirmation) startRecognition(element, "activeLocalMathBlock");
    } else {
      void confirmation.then((committed) => {
        if (committed) startRecognition(element, "activeLocalMathBlock");
      });
    }
    setSelectedIds([id]);
  };

  const createGraph = () => {
    if (!editable) return;
    const sources = activeSelectedIds
      .map((id) => operationElements[id])
      .filter((element): element is MathElementV3 => element?.kind === "math");
    if (sources.length === 0) return;
    const id = createId("graph");
    const timestamp = now();
    const anchor = sources[0];
    const colors = ["#2463eb", "#dc2626", "#059669", "#7c3aed"] as const;
    const graph: GraphElementV3 = {
      id,
      kind: "graph",
      frame: {
        x: anchor.frame.x,
        y: anchor.frame.y + anchor.frame.height + 20,
        width: 520,
        height: 360,
        rotation: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      locked: false,
      series: sources.map((source, index) => ({
        id: createId("graph-series"),
        sourceMathElementId: source.id,
        color: colors[index % colors.length],
        visible: true,
      })),
      viewport: {
        xMin: -10,
        xMax: 10,
        yMin: -10,
        yMax: 10,
        equalScale: true,
        axesVisible: true,
        gridVisible: true,
      },
    };
    commitChanges(
      "Create graph from selected math",
      { upserts: [graph] },
      {
        commandId: createId("command"),
        deviceId,
        patches: [{ elementId: id, before: null, after: graph }],
      },
    );
    setSelectedIds([id]);
    setTool("select");
  };

  const convertSelectionToMath = () => {
    if (!editable) return;
    const strokeIds = activeSelectedIds.filter((id) => operationElements[id]?.kind === "stroke");
    if (strokeIds.length === 0 || strokeIds.length !== activeSelectedIds.length) return;
    const timestamp = now();
    const portablePage = {
      ...structuredClone(page),
      schemaVersion: 3 as const,
      elementsById: structuredClone(operationElements),
      version: { protocol: "uninitialized" as const, heads: [] },
    } as PageDocV3;
    const converted = convertSelectedStrokesToMath(portablePage, {
      selectedStrokeIds: strokeIds,
      mathElementId: createId("math"),
      operationId: recognitionSafeId(createId("convert-strokes-to-math")),
      timestamp,
    });
    const command: LocalCommand = {
      commandId: createId("command"),
      deviceId,
      patches: [
        ...converted.operation.sourceStrokes.map((stroke) => ({
          elementId: stroke.id,
          before: stroke,
          after: null,
        })),
        {
          elementId: converted.operation.mathElement.id,
          before: null,
          after: converted.operation.mathElement,
        },
      ],
      zOrderBefore: converted.operation.zOrderBefore,
      zOrderAfter: converted.operation.zOrderAfter,
    };
    const confirmation = commitChanges(
      "Convert selected strokes to math",
      {
        upserts: [converted.operation.mathElement],
        removals: converted.operation.sourceStrokes.map((stroke) => stroke.id),
        zOrder: converted.page.zOrder,
      },
      command,
    );
    setSelectedIds([converted.operation.mathElement.id]);
    setTool("select");
    if (typeof confirmation === "boolean") {
      if (confirmation) startRecognition(converted.operation.mathElement, "explicitUserSelection");
    } else {
      void confirmation.then((committed) => {
        if (committed) startRecognition(converted.operation.mathElement, "explicitUserSelection");
      });
    }
  };

  /** One undo step for everything a stroke-eraser swipe removed. */
  const eraseStrokes = (ids: readonly string[]) => {
    const timestamp = now();
    const upserts: PageElementV2[] = [];
    const patches: LocalCommand["patches"][number][] = [];
    for (const id of ids) {
      const element = operationElementsRef.current[id];
      if (!element || element.kind !== "stroke" || element.locked) continue;
      const result = eraseWholeStroke(element, timestamp);
      if (!result.changed) continue;
      upserts.push(result.source);
      patches.push(strokeTombstonePatch(element, result.source));
    }
    if (patches.length === 0) return;
    commitChanges(
      patches.length === 1 ? "Erase whole stroke" : "Erase strokes",
      { upserts },
      { commandId: createId("command"), deviceId, patches },
    );
  };

  const erasePoints = (path: readonly Point[]) => {
    const upserts: PageElementV2[] = [];
    const anchors: Record<string, string> = {};
    const patches: LocalCommand["patches"][number][] = [];
    const timestamp = now();
    const reach = pathBounds(path, 10);
    for (const element of Object.values(operationElements)) {
      if (element.kind !== "stroke" || element.tombstonedAt) continue;
      if (!framesOverlap(strokeBounds(element), reach, element.size / 2)) continue;
      const result = eraseStrokePoints(
        element,
        path,
        10,
        timestamp,
        (_root, erased, index) => createId(`erase-${erased}-${index}`),
      );
      if (!result.changed) continue;
      upserts.push(result.source);
      patches.push(strokeTombstonePatch(element, result.source));
      // Remaining pieces keep the erased stroke's depth in the z-order.
      let anchor = element.id;
      for (const segment of result.segments) {
        upserts.push(segment);
        anchors[segment.id] = anchor;
        anchor = segment.id;
        patches.push({ elementId: segment.id, before: null, after: segment });
      }
    }
    if (patches.length === 0) return;
    commitChanges(
      "Point erase strokes",
      { upserts, anchors },
      {
        commandId: createId("command"),
        deviceId,
        patches,
        anchors,
      },
    );
  };

  /**
   * Deletes elements. Locked ones stay, except page backgrounds when the
   * context menu names them explicitly (`includeBackgrounds`).
   */
  const deleteElements = (ids: readonly string[], includeBackgrounds = false) => {
    if (!editable || ids.length === 0) return;
    const current = operationElementsRef.current;
    const removed = ids
      .map((id) => current[id])
      .filter((element): element is PageElementV2 => Boolean(element)
        && (!element.locked || (includeBackgrounds && isBackgroundElement(element))));
    if (removed.length === 0) return;
    const removedIds = removed.map((element) => element.id);
    commitChanges(
      "Delete canvas selection",
      { removals: removedIds },
      {
        commandId: createId("command"),
        deviceId,
        patches: removed.map((element) => ({ elementId: element.id, before: element, after: null })),
        // Undo puts the elements back at their old depth, not on top.
        anchors: zOrderAnchors(zOrderRef.current, removedIds),
      },
    );
    setSelectedIds([]);
    // Focus sat on the removed element; keep it on the page so Ctrl+Z works.
    rootRef.current?.focus();
  };

  const deleteSelected = () => deleteElements(activeSelectedIds);

  const copyElements = async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    await clipboard.writeText(serializeElementsForClipboard(operationElementsRef.current, ids, zOrderRef.current));
    setClipboardStatus(`${ids.length} Element(e) kopiert.`);
  };

  /** OneNote's "Reihenfolge": one undo step that only changes the page order. */
  const reorderSelection = (ids: readonly string[], action: OrderAction) => {
    if (!editable || ids.length === 0) return;
    const elements = operationElementsRef.current;
    const before = zOrderRef.current;
    const after = reorderElements(before, elements, ids, action);
    if (sameOrder(before, after)) return;
    const timestamp = now();
    const touched = ids.flatMap((id) => elements[id] ? [elements[id]] : []);
    commitChanges(
      "Reorder canvas selection",
      { upserts: touched.map((element) => ({ ...element, updatedAt: timestamp })), zOrder: after },
      {
        commandId: createId("command"),
        deviceId,
        patches: touched.map((element) => ({
          elementId: element.id,
          before: { updatedAt: element.updatedAt },
          after: { updatedAt: timestamp },
        })),
        zOrderBefore: [...before],
        zOrderAfter: after,
      },
    );
  };

  /**
   * "Als Hintergrund festlegen" / "Hintergrund lösen": a background is a
   * locked image or PDF page below everything else (see canvasOrder).
   */
  const setBackground = (ids: readonly string[], background: boolean) => {
    if (!editable) return;
    const elements = operationElementsRef.current;
    const targets = ids.flatMap((id) => {
      const element = elements[id];
      if (!element) return [];
      return (background ? canBecomeBackground(element) : isBackgroundElement(element)) ? [element] : [];
    });
    if (targets.length === 0) return;
    const timestamp = now();
    const before = zOrderRef.current;
    const after = background ? orderWithBackgrounds(before, elements, targets.map((element) => element.id)) : before;
    const reordered = !sameOrder(before, after);
    commitChanges(
      background ? "Set as page background" : "Release page background",
      {
        upserts: targets.map((element) => ({ ...element, locked: background, updatedAt: timestamp })),
        ...(reordered ? { zOrder: after } : {}),
      },
      {
        commandId: createId("command"),
        deviceId,
        patches: targets.map((element) => ({
          elementId: element.id,
          before: { locked: element.locked, updatedAt: element.updatedAt },
          after: { locked: background, updatedAt: timestamp },
        })),
        ...(reordered ? { zOrderBefore: [...before], zOrderAfter: after } : {}),
      },
    );
    const changed = new Set(targets.map((element) => element.id));
    // A new background leaves the selection; a released one becomes it.
    setSelectedIds((current) => background ? current.filter((id) => !changed.has(id)) : [...changed]);
    setClipboardStatus(t(background ? "canvas.background.set" : "canvas.background.released"));
  };

  /** "Auswahl anpassen": gives the selected ink another colour or thickness. */
  const restyleInk = useCallback((ids: readonly string[], update: Partial<InkStyle>) => {
    if (!editable) return;
    const elements = operationElementsRef.current;
    const timestamp = now();
    const upserts: PageElementV2[] = [];
    const patches: LocalCommand["patches"][number][] = [];
    for (const id of ids) {
      const element = elements[id];
      if (!element || element.kind !== "stroke" || element.tombstonedAt || element.locked) continue;
      const color = update.color ?? element.color;
      const size = update.size === undefined ? element.size : clampInkSize(element.tool, update.size);
      if (color === element.color && size === element.size) continue;
      upserts.push({ ...element, color, size, updatedAt: timestamp });
      patches.push({
        elementId: id,
        before: { color: element.color, size: element.size, updatedAt: element.updatedAt },
        after: { color, size, updatedAt: timestamp },
      });
    }
    if (patches.length === 0) return;
    commitChanges(
      patches.length === 1 ? "Restyle ink stroke" : "Restyle ink selection",
      { upserts },
      { commandId: createId("command"), deviceId, patches },
    );
  }, [commitChanges, createId, deviceId, editable, now]);

  const cancelLongPress = () => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  /**
   * Opens the context menu for what is under a screen point: the element
   * there (or the selection it belongs to), else a page background, else the
   * page itself. Backgrounds ignore clicks, but a right-click still finds them.
   */
  const openContextMenu = (client: Point, target: EventTarget | null) => {
    const surface = rootRef.current;
    if (!surface) return;
    cancelLongPress();
    cancelLiveGesture();
    clearInkShapeHoldTimer();
    gestureRef.current = null;
    setGesture(null);
    const point = clientPointToCanvas(client, surface.getBoundingClientRect(), viewport.zoom);
    const elements = operationElementsRef.current;
    const onSurface = target instanceof Node && surface.contains(target);
    const hit = onSurface && target ? elementAtPoint(target, point) : undefined;
    const bounds = selectionBounds(elements, activeSelectedIds);
    const insideSelection = bounds !== null
      && point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
    let ids: string[] = [];
    let backgroundId: string | undefined;
    if (hit && !isBackgroundElement(elements[hit])) {
      ids = activeSelectedIds.includes(hit) ? activeSelectedIds : [hit];
    } else if (insideSelection && activeSelectedIds.length > 0) {
      ids = activeSelectedIds;
    } else {
      backgroundId = hit ?? backgroundAt(elements, zOrderRef.current, point);
    }
    if (ids !== activeSelectedIds) setSelectedIds(ids.length > 0 ? ids : clearedSelection);
    setContextMenu({ x: client.x, y: client.y, point, ids, ...(backgroundId ? { backgroundId } : {}) });
  };

  /** Shift+F10 or the context-menu key: the menu for the focus or the selection. */
  const openContextMenuFromKeyboard = (target: EventTarget | null) => {
    const surface = rootRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const zoom = clampCanvasZoom(viewport.zoom);
    const elements = operationElementsRef.current;
    const focusedId = target ? findElementId(target) : undefined;
    const at = (frame: { x: number; y: number; height: number }) => ({
      x: rect.left + frame.x * zoom + 12,
      y: rect.top + (frame.y + Math.min(frame.height, 40)) * zoom,
      point: { x: frame.x + 12, y: frame.y + Math.min(frame.height, 40) },
    });
    if (focusedId && isBackgroundElement(elements[focusedId])) {
      setContextMenu({ ...at(elements[focusedId].frame), ids: [], backgroundId: focusedId });
      return;
    }
    const ids = activeSelectedIds.length > 0
      ? activeSelectedIds
      : focusedId && elements[focusedId] ? [focusedId] : [];
    const bounds = selectionBounds(elements, ids);
    if (ids !== activeSelectedIds) setSelectedIds(ids);
    const viewportRect = viewportRef.current?.getBoundingClientRect() ?? rect;
    const fallback = { x: viewportRect.left + 40, y: viewportRect.top + 40 };
    setContextMenu({
      ...(bounds ? at(bounds) : { ...fallback, point: clientPointToCanvas(fallback, rect, zoom) }),
      ids,
    });
  };

  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    setContextMenu(null);
    if (restoreFocus) rootRef.current?.focus({ preventScroll: true });
  }, []);

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A pen's barrel button (or a press-and-hold) raises contextmenu; the
    // barrel button has its own action, so no menu opens for the pen.
    const fromPen = "pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "pen";
    if (fromPen || event.timeStamp - lastPenAtRef.current < PEN_CONTEXT_MENU_SUPPRESS_MS) {
      event.preventDefault();
      return;
    }
    // Inside text the browser's own menu (spelling, text clipboard) stays.
    if (isTextEntryTarget(event.target)) return;
    event.preventDefault();
    openContextMenu({ x: event.clientX, y: event.clientY }, event.target);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    inkQueue.flush();
    // A key the text editor already handled (for example Escape closing the
    // "/" menu) must not also act on the canvas.
    if (event.defaultPrevented) return;
    // Keys typed inside a text container belong to that editor, including its
    // own undo history; only Escape leaves the container.
    if (event.key !== "Escape" && isTextEntryTarget(event.target)) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openContextMenuFromKeyboard(event.target);
    } else if (event.key === "Escape") {
      // Escape first clears what the canvas holds; only an Escape with
      // nothing to clear reaches the app (which leaves the full page view).
      if (activeSelectedIds.length > 0 || liveRef.current || gestureRef.current) event.preventDefault();
      setSelectedIds([]);
      cancelLiveGesture();
      gestureRef.current = null;
      setGesture(null);
      rootRef.current?.focus();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (activeSelectedIds.length === 0) return;
      event.preventDefault();
      deleteSelected();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
      if (activeSelectedIds.length === 0) return;
      event.preventDefault();
      const ids = activeSelectedIds;
      void copyElements(ids).then(() => deleteElements(ids));
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c"
    ) {
      event.preventDefault();
      void copy();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "v"
    ) {
      event.preventDefault();
      void paste();
    }
  };

  const onCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (activeSelectedIds.length === 0) return;
    event.preventDefault();
    event.clipboardData.setData(
      "text/plain",
      serializeElementsForClipboard(
        operationElements,
        activeSelectedIds,
        page.zOrder,
      ),
    );
  };

  /** Zooms about the view's centre by `step` from the zoom on screen now, so quick clicks add up. */
  const changeZoom = (step: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const center = viewportAnchor(
      (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
      (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
    );
    setViewport((current) =>
      zoomViewportAroundPoint(current, current.zoom + step, center),
    );
  };



  const exportPerformanceEvidence = () => {
    let evidence: PenPerformanceAcceptanceEvidence;
    try {
      evidence = performanceRef.current.exportPenPerformanceAcceptanceEvidence(
        performanceEvidenceBinding(),
      );
    } catch {
      setClipboardStatus(t("canvas.performance.notReady"));
      return;
    }
    const blob = new Blob([JSON.stringify(evidence, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `canvink-pen-performance-${evidence.recordedAt.slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setClipboardStatus(
      t("canvas.performance.summary", {
        p95: evidence.results.p95Ms.toFixed(1),
        result: t("canvas.performance.pass"),
      }),
    );
  };

  // Wheel and trackpad gestures zoom and scroll the canvas only. React
  // attaches wheel listeners as passive, so preventDefault (which keeps the
  // browser from zooming the whole app) needs a native listener.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const anchorOf = (event: { clientX: number; clientY: number }): Point => {
      const rect = node.getBoundingClientRect();
      return {
        x: event.clientX - rect.left - (rootRef.current?.offsetLeft ?? 0),
        y: event.clientY - rect.top - (rootRef.current?.offsetTop ?? 0),
      };
    };
    const onWheel = (event: WheelEvent) => {
      // An element on the page (a graph) may have used the wheel itself.
      if (event.defaultPrevented) return;
      event.preventDefault();
      presenceRef.current?.interacted();
      if (event.ctrlKey || event.metaKey) {
        // Ctrl+wheel and trackpad pinch (which Chromium reports as Ctrl+wheel).
        const factor = Math.min(1.33, Math.max(0.75, Math.exp(-event.deltaY / 100)));
        const anchor = anchorOf(event);
        setViewport((current) => zoomViewportAroundPoint(current, current.zoom * factor, anchor));
        return;
      }
      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? node.clientHeight : 1;
      let deltaX = event.deltaX * unit;
      let deltaY = event.deltaY * unit;
      if (event.shiftKey && deltaX === 0) {
        deltaX = deltaY;
        deltaY = 0;
      }
      setViewport((current) => ({ ...current, panX: current.panX - deltaX, panY: current.panY - deltaY }));
    };
    // Safari reports trackpad pinches as gesture events instead.
    let gestureScale = 1;
    const onGesture = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (event.type === "gesturestart") {
        gestureScale = 1;
        return;
      }
      if (event.type !== "gesturechange" || !gesture.scale) return;
      const ratio = gesture.scale / gestureScale;
      gestureScale = gesture.scale;
      const anchor = anchorOf({ clientX: gesture.clientX ?? 0, clientY: gesture.clientY ?? 0 });
      setViewport((current) => zoomViewportAroundPoint(current, current.zoom * ratio, anchor));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      node.addEventListener(type, onGesture, { passive: false });
    }
    return () => {
      node.removeEventListener("wheel", onWheel);
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
        node.removeEventListener(type, onGesture);
      }
    };
  }, [setViewport]);

  // Shows a region: in the reading view at a size to read or type in, below the app bar.
  const animateReadingToRef = useRef<(target: CanvasViewport) => void>(() => undefined);
  useLayoutEffect(() => {
    revealRegionRef.current = (region) => {
      const node = viewportRef.current;
      if (!node) return;
      const size = { width: node.clientWidth, height: node.clientHeight };
      const options = readingRef.current;
      if (options) {
        animateReadingTo(viewportForRegion(region, readingContentRef.current, size, options.insets), 300);
        return;
      }
      const surface = rootRef.current;
      setViewport(viewportShowing(region, size, surface ? { x: surface.offsetLeft, y: surface.offsetTop } : surfaceOffset));
    };
    animateReadingToRef.current = (target) => animateReadingTo(clampToBounds(target, readingBoundsAt(target.zoom)), 280);
  });

  // The reading view shows a page small enough to read whole; typing into a
  // text box at that size is fiddly, so focusing one brings it to a size to
  // type in (as OneNote's phone app does) and leaving it returns the page to
  // where it was.
  const editZoomRestoreRef = useRef<CanvasViewport | null>(null);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !readingMode) return;
    const onFocusIn = (event: FocusEvent) => {
      const elementId = event.target instanceof Element ? findElementId(event.target) : undefined;
      const element = elementId ? operationElementsRef.current[elementId] : undefined;
      if (!element || element.kind !== "richText" || !isTextEntryTarget(event.target)) return;
      const current = liveViewportRef.current;
      if (current.zoom >= 0.8) return;
      editZoomRestoreRef.current ??= current;
      revealRegionRef.current(element.frame);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && node.contains(next)) return;
      const restore = editZoomRestoreRef.current;
      editZoomRestoreRef.current = null;
      // The keyboard closes with the focus; the restored view settles into the bounds of the full view.
      if (restore) window.setTimeout(() => animateReadingToRef.current(restore), 120);
    };
    node.addEventListener("focusin", onFocusIn);
    node.addEventListener("focusout", onFocusOut);
    return () => {
      node.removeEventListener("focusin", onFocusIn);
      node.removeEventListener("focusout", onFocusOut);
    };
  }, [readingMode]);

  // With the on-screen keyboard open, a focused text box below the visible
  // part pans the page up instead of scrolling the clipped viewport.
  useEffect(() => subscribeCaretReveal((target, overflow) => {
    if (!viewportRef.current?.contains(target)) return false;
    setViewport((current) => ({ ...current, panY: current.panY - overflow }));
    return true;
  }), [setViewport]);

  // The visible part of the page decides which ink tiles exist.
  useLayoutEffect(() => {
    const viewportNode = viewportRef.current;
    const surface = rootRef.current;
    if (!viewportNode || !surface) return;
    const measure = () => {
      setViewSize((current) =>
        current.width === viewportNode.clientWidth && current.height === viewportNode.clientHeight
          ? current
          : { width: viewportNode.clientWidth, height: viewportNode.clientHeight });
      setSurfaceOffset((current) =>
        current.x === surface.offsetLeft && current.y === surface.offsetTop
          ? current
          : { x: surface.offsetLeft, y: surface.offsetTop });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewportNode);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  // Live presence: tell the others which part of the page this window shows,
  // and show them a part when someone jumps to or follows a person.
  const viewSizeRef = useRef(viewSize);
  const surfaceOffsetRef = useRef(surfaceOffset);
  useLayoutEffect(() => {
    viewSizeRef.current = viewSize;
    surfaceOffsetRef.current = surfaceOffset;
  }, [viewSize, surfaceOffset]);
  useEffect(() => {
    presence?.viewport(exactVisiblePageRect(viewport, viewSize, surfaceOffset));
  }, [presence, viewport, viewSize, surfaceOffset]);
  const presenceViewAttribute = useMemo(() => {
    const view = exactVisiblePageRect(viewport, viewSize, surfaceOffset);
    return [view.x, view.y, view.width, view.height].map((value) => Math.round(value)).join(",");
  }, [viewport, viewSize, surfaceOffset]);
  useEffect(() => presence?.subscribeReveal((view) => {
    // A request that was waiting for this page arrives right after the first
    // render, before the measured size reached state: measure it now.
    const viewportNode = viewportRef.current;
    const surface = rootRef.current;
    setViewport(viewportShowing(
      view,
      viewportNode ? { width: viewportNode.clientWidth, height: viewportNode.clientHeight } : viewSizeRef.current,
      surface ? { x: surface.offsetLeft, y: surface.offsetTop } : surfaceOffsetRef.current,
    ));
  }), [presence, setViewport]);

  // Strokes waiting to be written are shown at the pan and zoom they were
  // drawn at: write them before the page moves.
  useEffect(() => {
    inkQueue.flush();
  }, [inkQueue, viewport.zoom, viewport.panX, viewport.panY]);

  // Tiles are re-rasterised for a new zoom only once zooming pauses; until
  // then the existing tiles are scaled, as OneNote does while pinching.
  const [settledZoom, setSettledZoom] = useState(viewport.zoom);
  useEffect(() => {
    if (settledZoom === viewport.zoom) return;
    const timer = setTimeout(() => setSettledZoom(viewport.zoom), ZOOM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settledZoom, viewport.zoom]);

  // A committed stroke stays on the overlay until the re-rendered page paints
  // it on its tile, so pen-up never flickers.
  useLayoutEffect(() => {
    const settled = settledInkRef.current;
    if (settled.length === 0) return;
    const remaining = settled.filter((item) => !operationElements[item.id]);
    if (remaining.length === settled.length) return;
    settledInkRef.current = remaining;
    // A stroke is being drawn: its painter takes the written strokes off the
    // overlay (their tile shows them now) without disturbing the live line.
    const drawing = liveRef.current;
    if (drawing) {
      drawing.painter?.erase(settled.filter((item) => operationElements[item.id]).map((item) => item.stroke));
      return;
    }
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (remaining.length === 0) clearOverlay(overlay);
    else paintLiveInk(overlay, remaining[0].transform, remaining.map((item) => item.stroke), null);
  }, [operationElements]);

  const inkDebugStateRef = useRef({ zoom: viewport.zoom, elements: operationElements });
  useEffect(() => {
    if (!INK_DEBUG_ENABLED || typeof window === "undefined") return;
    // Test builds only: ink has no DOM nodes, so end-to-end tests read the
    // strokes' screen geometry here instead.
    const api: InkDebugApi = {
      livePointCount: () => liveRef.current?.points.length ?? 0,
      strokes: () => {
        const surface = rootRef.current;
        if (!surface) return [];
        const rect = surface.getBoundingClientRect();
        const { elements } = inkDebugStateRef.current;
        const { zoom } = liveViewportRef.current;
        return zOrderRef.current.flatMap((id) => {
          const element = elements[id];
          if (element?.kind !== "stroke" || element.tombstonedAt) return [];
          const bounds = strokeBounds(element);
          const middle = element.points[Math.floor(element.points.length / 2)] ?? { x: 0, y: 0 };
          return [{
            id,
            tool: element.tool,
            color: element.color,
            opacity: element.opacity,
            size: element.size,
            box: {
              x: rect.left + bounds.x * zoom,
              y: rect.top + bounds.y * zoom,
              width: bounds.width * zoom,
              height: bounds.height * zoom,
            },
            samplePoint: { x: rect.left + middle.x * zoom, y: rect.top + middle.y * zoom },
            localPoints: element.points
              .map((point) => `${point.x - element.frame.x},${point.y - element.frame.y}`)
              .join(" "),
          }];
        });
      },
    };
    const target = window as Window & { __canvinkInk?: InkDebugApi };
    target.__canvinkInk = api;
    return () => {
      if (target.__canvinkInk === api) delete target.__canvinkInk;
    };
  }, []);

  const heldShapePreview = heldShape && activePreset
    ? createHeldInkShapeElement({
        candidate: heldShape,
        id: "held-shape-preview",
        timestamp: "",
        color: activePreset.color,
        strokeWidth: activePreset.size,
      })
    : undefined;
  const resizeTransform = gesture?.resize?.transform;
  const renderedElements = useMemo(
    () => resizeTransform
      ? transformSelection(operationElements, activeSelectedIds, resizeTransform, page.updatedAt)
      : operationElements,
    [activeSelectedIds, operationElements, page.updatedAt, resizeTransform],
  );
  // Test builds read what is on screen, including a resize in progress.
  useLayoutEffect(() => {
    inkDebugStateRef.current = { zoom: viewport.zoom, elements: renderedElements };
  }, [renderedElements, viewport.zoom]);
  const dragTranslate = gesture?.drag ? gesture.translate : undefined;
  const dragging = dragTranslate !== undefined;
  const selectedStrokeIds = useMemo(
    () => activeSelectedIds.filter((id) => renderedElements[id]?.kind === "stroke"),
    [activeSelectedIds, renderedElements],
  );
  // Ink being erased or dragged is hidden from its tiles; dragged ink is shown
  // on its own layer that follows the pointer with a CSS transform.
  const hiddenInk = useMemo<ReadonlySet<string>>(() => {
    if (!dragging && erasingIds.size === 0) return NO_IDS;
    const hidden = new Set(erasingIds);
    if (dragging) for (const id of selectedStrokeIds) hidden.add(id);
    return hidden;
  }, [dragging, erasingIds, selectedStrokeIds]);
  const pageLayers = useMemo(
    () => buildPageLayers(page.zOrder, renderedElements),
    [page.zOrder, renderedElements],
  );
  const dragRun = useMemo<InkRun | null>(() => {
    if (!dragging || selectedStrokeIds.length === 0) return null;
    const selected = new Set(selectedStrokeIds);
    const strokes = page.zOrder
      .map((id) => renderedElements[id])
      .filter((element): element is StrokeElementV2 =>
        element?.kind === "stroke" && selected.has(element.id) && !element.tombstonedAt);
    return {
      kind: "ink",
      key: "ink:drag",
      zIndex: 1,
      strokes,
      highlighter: strokes.some((stroke) => stroke.tool === "highlighter"),
    };
  }, [dragging, page.zOrder, renderedElements, selectedStrokeIds]);
  const restyleSelectedInk = useCallback(
    (update: Partial<InkStyle>) => restyleInk(selectedStrokeIds, update),
    [restyleInk, selectedStrokeIds],
  );
  const liveStrokeCount = useMemo(() => {
    let count = 0;
    for (const id in operationElements) {
      const element = operationElements[id];
      if (element.kind === "stroke" && !element.tombstonedAt) count += 1;
    }
    return count;
  }, [operationElements]);
  // A picture of the ink, shown the next time this page opens until its
  // document has loaded (see inkRaster.ts).
  const inkRuns = useMemo(
    () => pageLayers.filter((layer): layer is InkRun => layer.kind === "ink"),
    [pageLayers],
  );
  useInkRaster({
    pageId: page.pageId,
    updatedAt: page.updatedAt,
    strokeCount: liveStrokeCount,
    runs: inkRuns,
    measure: () => measureInkRasterFrame({
      viewport: viewportRef.current,
      surface: rootRef.current,
      current: constrainViewport(liveViewportRef.current, freePageRef.current),
      opening: constrainViewport({ zoom: 1, panX: 0, panY: 0 }, freePageRef.current),
      sheet: fixedPaper ? dimensions : null,
      paperColor: page.background.color,
    }),
  });
  const inkView = useMemo(
    () => visiblePageRect(viewport, viewSize, surfaceOffset),
    [surfaceOffset, viewSize, viewport],
  );
  const inkScale = Math.max(0.5, Math.min(8, Math.round(settledZoom * devicePixelRatioNow() * 4) / 4));
  const selectionInteractive = tool === "select" || tool === "lasso" || penSelectionActive;
  const rawSelectionBounds = selectionInteractive
    ? selectionBounds(renderedElements, activeSelectedIds)
    : null;
  const renderedSelectionBounds = rawSelectionBounds && dragTranslate
    ? { ...rawSelectionBounds, x: rawSelectionBounds.x + dragTranslate.x, y: rawSelectionBounds.y + dragTranslate.y }
    : rawSelectionBounds;
  // Tells the others which region is selected here (or which text box is
  // being edited). Keyed by value: the bounds object is new on every render.
  const presenceSelectionKey = renderedSelectionBounds
    ? `${Math.round(renderedSelectionBounds.x)},${Math.round(renderedSelectionBounds.y)},${Math.round(renderedSelectionBounds.width)},${Math.round(renderedSelectionBounds.height)}`
    : "";
  useEffect(() => {
    if (!presence) return;
    const [x, y, width, height] = presenceSelectionKey ? presenceSelectionKey.split(",").map(Number) : [];
    presence.selection(presenceSelectionKey ? { x, y, width, height } : null);
  }, [presence, presenceSelectionKey]);

  const menuEntries = ((): CanvasMenuEntry<CanvasMenuCommand>[] => {
    if (!contextMenu) return [];
    const entries: CanvasMenuEntry<CanvasMenuCommand>[] = [];
    const separator = (id: string): CanvasMenuEntry<CanvasMenuCommand> => ({ kind: "separator", id });
    const pasteEntry: CanvasMenuEntry<CanvasMenuCommand> = {
      kind: "action", id: "paste", label: t("canvas.menu.paste"), icon: <ClipboardPaste />, shortcut: "Ctrl+V",
      disabled: !editable, command: { type: "paste", at: contextMenu.point },
    };
    const background = contextMenu.backgroundId ? renderedElements[contextMenu.backgroundId] : undefined;
    if (contextMenu.ids.length === 0) {
      if (background) {
        const ids = [background.id];
        entries.push(
          { kind: "action", id: "release-background", label: t("canvas.menu.releaseBackground"), icon: <ImageOff />,
            disabled: !editable, command: { type: "releaseBackground", ids } },
          separator("background-clipboard"),
          { kind: "action", id: "copy", label: t("canvas.menu.copy"), icon: <Copy />, command: { type: "copy", ids } },
          pasteEntry,
          { kind: "action", id: "delete", label: t("canvas.menu.delete"), icon: <Trash2 />,
            disabled: !editable, command: { type: "deleteBackground", ids } },
        );
      } else {
        entries.push(pasteEntry);
      }
      return entries;
    }
    const ids = contextMenu.ids;
    const elements = ids.flatMap((id) => renderedElements[id] ? [renderedElements[id]] : []);
    const unlocked = elements.some((element) => !element.locked);
    entries.push(
      { kind: "action", id: "cut", label: t("canvas.menu.cut"), icon: <Scissors />, shortcut: "Ctrl+X",
        disabled: !editable || !unlocked, command: { type: "cut", ids } },
      { kind: "action", id: "copy", label: t("canvas.menu.copy"), icon: <Copy />, shortcut: "Ctrl+C",
        command: { type: "copy", ids } },
      pasteEntry,
      { kind: "action", id: "delete", label: t("canvas.menu.delete"), icon: <Trash2 />, shortcut: "Entf",
        disabled: !editable || !unlocked, command: { type: "delete", ids } },
      separator("order"),
      { kind: "heading", id: "order-heading", label: t("canvas.menu.order") },
      { kind: "action", id: "front", label: t("canvas.menu.bringToFront"), icon: <BringToFront />,
        disabled: !editable, command: { type: "order", ids, action: "front" } },
      { kind: "action", id: "forward", label: t("canvas.menu.bringForward"), icon: <ArrowUp />,
        disabled: !editable, command: { type: "order", ids, action: "forward" } },
      { kind: "action", id: "backward", label: t("canvas.menu.sendBackward"), icon: <ArrowDown />,
        disabled: !editable, command: { type: "order", ids, action: "backward" } },
      { kind: "action", id: "back", label: t("canvas.menu.sendToBack"), icon: <SendToBack />,
        disabled: !editable, command: { type: "order", ids, action: "back" } },
    );
    if (elements.some((element) => canBecomeBackground(element))) {
      entries.push(
        separator("background"),
        { kind: "action", id: "set-background", label: t("canvas.menu.setBackground"), icon: <Wallpaper />,
          disabled: !editable, command: { type: "setBackground", ids } },
      );
    }
    const strokes = elements.filter((element): element is StrokeElementV2 =>
      element.kind === "stroke" && !element.tombstonedAt);
    if (editable && strokes.length > 0 && strokes.length === elements.length) {
      // Ink only: OneNote offers the pen colours and widths for the selection.
      const inkTool: InkTool = strokes.every((stroke) => stroke.tool === "highlighter") ? "highlighter" : "pen";
      const colors = new Set(strokes.map((stroke) => stroke.color));
      const sizes = new Set(strokes.map((stroke) => stroke.size));
      entries.push(
        separator("ink"),
        { kind: "heading", id: "ink-color-heading", label: t("canvas.menu.inkColor") },
        {
          kind: "swatches", id: "ink-colors", label: t("canvas.menu.inkColor"),
          options: INK_PALETTE[inkTool].map((swatch) => ({
            id: swatch.color,
            label: t(swatch.labelKey),
            checked: colors.size === 1 && colors.has(swatch.color),
            swatch: <span className="canvas-context-menu__color" style={{ background: swatch.color }} />,
            command: { type: "restyle", ids, update: { color: swatch.color } },
          })),
        },
        { kind: "heading", id: "ink-width-heading", label: t("canvas.menu.inkWidth") },
        {
          kind: "swatches", id: "ink-widths", label: t("canvas.menu.inkWidth"),
          options: INK_WIDTHS[inkTool].map((size, index) => ({
            id: String(size),
            label: t(INK_WIDTH_LABELS[index]),
            checked: sizes.size === 1 && sizes.has(size),
            swatch: <span className="canvas-context-menu__width" style={{ width: 4 + index * 5, height: 4 + index * 5 }} />,
            command: { type: "restyle", ids, update: { size } },
          })),
        },
      );
    }
    return entries;
  })();

  const runMenuCommand = (command: CanvasMenuCommand) => {
    if (command.type === "paste") void paste(command.at);
    else if (command.type === "copy") void copyElements(command.ids);
    else if (command.type === "cut") void copyElements(command.ids).then(() => deleteElements(command.ids));
    else if (command.type === "delete") deleteElements(command.ids);
    else if (command.type === "deleteBackground") deleteElements(command.ids, true);
    else if (command.type === "order") reorderSelection(command.ids, command.action);
    else if (command.type === "setBackground") setBackground(command.ids, true);
    else if (command.type === "releaseBackground") setBackground(command.ids, false);
    else if (command.type === "restyle") restyleInk(command.ids, command.update);
  };

  // The paper (colour and rule lines) is drawn in screen space below the
  // zoomed surface: on a fixed sheet only on the sheet, on a free page on all
  // paper right of and below the page origin.
  // The paper is one layer that only moves when the page is panned: its
  // pattern is painted at the layer's own origin and the layer is shifted
  // (see `paperEdge`), so panning costs the compositor a move and no repaint.
  // Repainting a viewport-sized rule pattern for every pan tick was most of
  // the rendering work of a pan. Positions are whole device pixels, which
  // keeps the one-pixel lines crisp.
  const paperStyleFor = (view: CanvasViewport): CSSProperties => {
    const zoom = clampCanvasZoom(view.zoom);
    const origin = { x: surfaceOffset.x + view.panX, y: surfaceOffset.y + view.panY };
    const period = fixedPaper ? 0 : rulePeriod(page.background, zoom);
    const box = fixedPaper
      ? { ...origin, width: dimensions.width * zoom, height: dimensions.height * zoom }
      : {
          x: paperEdge(origin.x, period),
          y: paperEdge(origin.y, period),
          width: viewSize.width + period,
          height: viewSize.height + period,
        };
    const pixelRatio = devicePixelRatioNow();
    const snap = (value: number) => Math.round(value * pixelRatio) / pixelRatio;
    return {
      left: 0,
      top: 0,
      width: box.width,
      height: box.height,
      transform: `translate(${snap(box.x)}px, ${snap(box.y)}px)`,
      backgroundColor: page.background.color,
      ...rulePatternStyle(page.background, zoom, { x: 0, y: 0 }),
    };
  };
  const paperStyle = paperStyleFor(viewport);
  // After every commit, and on every pan or zoom tick, the DOM shows the
  // latest viewport: a render from the trailing state must not pull the page
  // back for a frame.
  useLayoutEffect(() => {
    syncViewportDomRef.current = (latest) => {
      const view = readingRef.current ? latest : constrainViewport(latest, freePageRef.current);
      const surface = rootRef.current;
      if (surface) surface.style.transform = surfaceTransform(view);
      if (paperRef.current) applyPaperGeometry(paperRef.current, paperStyleFor(view));
    };
    syncViewportDomRef.current(liveViewportRef.current);
  });
  // A free page opens at its content when the first screen would show only
  // bare paper (see initialViewportFor). Once per mounted page: later changes
  // to the page, from this device or another, never move the view.
  const openedViewportRef = useRef(false);
  useLayoutEffect(() => {
    if (openedViewportRef.current) return;
    const node = viewportRef.current;
    const surface = rootRef.current;
    if (!node || !surface || node.clientWidth === 0 || node.clientHeight === 0) return;
    openedViewportRef.current = true;
    const readingView = readingRef.current;
    if (readingView) {
      placeViewport(openingViewport(
        readingContentRef.current,
        { width: node.clientWidth, height: node.clientHeight },
        readingView.insets,
      ));
      commitViewport();
      return;
    }
    const target = initialViewportFor(
      page,
      { width: node.clientWidth, height: node.clientHeight },
      { x: surface.offsetLeft, y: surface.offsetTop },
    );
    if (!target) return;
    setViewport(target);
    commitViewport();
  }, [commitViewport, page, placeViewport, setViewport, viewSize]);
  // A pointer that goes down acts on the viewport as it is on screen now.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const flush = () => {
      if (viewportCommitTimerRef.current === null) return;
      flushSync(commitViewport);
    };
    node.addEventListener("pointerdown", flush, { capture: true });
    return () => node.removeEventListener("pointerdown", flush, { capture: true });
  }, [commitViewport]);

  const canvasToolbar = (
    <LiveCanvasToolbar
      onFormatSlotMount={setFormatSlot}
      tool={tool}
      setTool={selectTool}
      presets={presets}
      presetId={presetId}
      inkStyles={inkStyles}
      setInkStyle={updateInkStyle}
      setPresetId={(id) => {
        setPresetId(id);
        const preset = presets.find((candidate) => candidate.id === id);
        if (preset) setTool(preset.tool);
      }}
      gridSnap={gridSnap}
      setGridSnap={setGridSnap}
      angleSnap={angleSnap}
      setAngleSnap={setAngleSnap}
      ruler={ruler}
      setRulerVisible={(visible) => updateRuler({ visible })}
      setRulerAngle={(angleDegrees) => updateRuler({ angleDegrees })}
      selectedCount={activeSelectedIds.length}
      canUndo={historyAvailability.owner === historyOwner && historyAvailability.canUndo}
      canRedo={historyAvailability.owner === historyOwner && historyAvailability.canRedo}
      undo={undo}
      redo={redo}
      copy={copy}
      paste={() => paste()}
      createText={createText}
      createTable={() => createText(undefined, { table: true })}
      createGraph={createGraph}
      canCreateGraph={activeSelectedIds.some((id) => operationElements[id]?.kind === "math")}
      convertSelectionToMath={convertSelectionToMath}
      canConvertSelectionToMath={activeSelectedIds.length > 0 && activeSelectedIds.every(
        (id) => operationElements[id]?.kind === "stroke",
      )}
      resize={() =>
        transformSelected(
          { scaleX: 1.1, scaleY: 1.1 },
          "Resize canvas selection",
        )
      }
      rotate={() =>
        transformSelected({ rotationDegrees: 15 }, "Rotate canvas selection")
      }
      viewport={viewport}
      zoomOut={() => changeZoom(-0.1)}
      zoomIn={() => changeZoom(0.1)}
      resetViewport={() => setViewport({ zoom: 1, panX: 0, panY: 0 })}
      exportPerformanceEvidence={exportPerformanceEvidence}
      performanceEvidenceReady={performanceEvidenceReady}
      editable={editable}
      mathSidebarOpen={mathSidebarOpen}
      mathFeaturesEnabled={mathFeaturesEnabled}
      toggleMathSidebar={() => {
        if (mathFeaturesEnabled) setMathSidebarOpen((open) => !open);
      }}
    />
  );
  const canvasRibbon = ribbonSlots ? (
    <CanvasRibbon
      slots={ribbonSlots}
      selectedInkCount={selectedStrokeIds.length}
      restyleSelection={restyleSelectedInk}
      onFormatSlotMount={setFormatSlot}
      tool={tool}
      setTool={selectTool}
      presets={presets}
      presetId={presetId}
      inkStyles={inkStyles}
      setInkStyle={updateInkStyle}
      setPresetId={(id) => {
        setPresetId(id);
        const preset = presets.find((candidate) => candidate.id === id);
        if (preset) setTool(preset.tool);
      }}
      gridSnap={gridSnap}
      setGridSnap={setGridSnap}
      angleSnap={angleSnap}
      setAngleSnap={setAngleSnap}
      ruler={ruler}
      setRulerVisible={(visible) => updateRuler({ visible })}
      setRulerAngle={(angleDegrees) => updateRuler({ angleDegrees })}
      selectedCount={activeSelectedIds.length}
      canUndo={historyAvailability.owner === historyOwner && historyAvailability.canUndo}
      canRedo={historyAvailability.owner === historyOwner && historyAvailability.canRedo}
      undo={undo}
      redo={redo}
      copy={copy}
      paste={() => paste()}
      createText={createText}
      createTable={() => createText(undefined, { table: true })}
      createGraph={createGraph}
      canCreateGraph={activeSelectedIds.some((id) => operationElements[id]?.kind === "math")}
      convertSelectionToMath={convertSelectionToMath}
      canConvertSelectionToMath={activeSelectedIds.length > 0 && activeSelectedIds.every(
        (id) => operationElements[id]?.kind === "stroke",
      )}
      resize={() =>
        transformSelected(
          { scaleX: 1.1, scaleY: 1.1 },
          "Resize canvas selection",
        )
      }
      rotate={() =>
        transformSelected({ rotationDegrees: 15 }, "Rotate canvas selection")
      }
      viewport={viewport}
      zoomOut={() => changeZoom(-0.1)}
      zoomIn={() => changeZoom(0.1)}
      resetViewport={() => setViewport({ zoom: 1, panX: 0, panY: 0 })}
      exportPerformanceEvidence={exportPerformanceEvidence}
      performanceEvidenceReady={performanceEvidenceReady}
      editable={editable}
      mathSidebarOpen={mathSidebarOpen}
      mathFeaturesEnabled={mathFeaturesEnabled}
      toggleMathSidebar={() => {
        if (mathFeaturesEnabled) setMathSidebarOpen((open) => !open);
      }}
    />
  ) : null;

  return (
    <section
      className="live-canvas-editor"
      data-math-sidebar-open={mathFeaturesEnabled && mathSidebarOpen ? "true" : "false"}
      data-toolbar-external={toolbarHost || ribbonSlots ? "true" : undefined}
      data-reading={reading ? "true" : undefined}
      aria-label={t("canvas.label", { title: page.title })}
    >
      <RichTextToolbarSlotContext.Provider value={reading ? reading.formatToolbarHost ?? null : formatSlot}>
      {/* The reading view has no drawing tools; text formatting docks above the keyboard. */}
      {reading ? null : canvasRibbon ?? (toolbarHost ? createPortal(canvasToolbar, toolbarHost) : canvasToolbar)}
      {mathFeaturesEnabled && mathSidebarOpen ? (
        <aside className="math-canvas-sidebar" aria-label={t("canvas.math.sidebar")}>
          <CalculatorPalette
            labels={{ palette: t("canvas.math.palette"), basic: t("canvas.math.palette.basic"),
              scientific: t("canvas.math.palette.scientific"), conversion: t("canvas.math.palette.conversion"),
              result: t("canvas.math.result"), insertResult: t("canvas.math.result.accept") }}
            viewer={!editable}
            result={activeSelectedMath && (pageMathSettings.numberMode === "exact"
              ? activeSelectedMath.result.exactLatex
              : activeSelectedMath.result.decimalText)
              ? {
                  insertText: pageMathSettings.numberMode === "exact"
                    ? activeSelectedMath.result.exactLatex!
                    : activeSelectedMath.result.decimalText!,
                }
              : undefined}
            onInsert={(insertText) => {
              if (!activeSelectedMath) { createTypedMathAt({ x: 80, y: 80 }, insertText); return; }
              updateMathElement(activeSelectedMath.id, {
                ...(activeSelectedMath.inputKind === "typed"
                  ? { typedLatex: `${mathElementLatex(activeSelectedMath)}${insertText}` }
                  : { correctedLatex: `${mathElementLatex(activeSelectedMath)}${insertText}` }),
                result: { state: "none", diagnostics: [] },
                dependencies: { defines: [], references: [], dependsOnElementIds: [], state: "valid" },
              }, "Insert calculator palette command");
            }}
            onInsertResult={(result) => createTypedMathAt({ x: 80, y: 80 }, result)}
          />
          <CalculatorHistoryView
            key={`${page.notebookId}:${historyRevision}`}
            history={calculatorHistory}
            labels={{ title: t("canvas.math.history"), empty: t("canvas.math.history.empty"),
              loading: t("canvas.math.history.loading"), copy: t("canvas.copy"), restore: t("canvas.math.history.restore"),
              delete: t("canvas.math.history.delete"), clear: t("canvas.math.history.clear"), exact: t("canvas.math.numberMode.exact"),
              decimal: t("canvas.math.numberMode.decimal"), degrees: t("canvas.math.degrees"), radians: t("canvas.math.radians"),
              copied: t("canvas.math.history.copied"), restored: t("canvas.math.history.restored"), deleted: t("canvas.math.history.deleted"),
              cleared: t("canvas.math.history.cleared"), error: t("canvas.math.history.error") }}
            onCopy={(plainText) => clipboard.writeText(plainText)}
            onRestore={(input) => createTypedMathAt({ x: 80, y: 80 }, input.expression)}
          />
          <UnitConversionPanel
            port={mathUnitsPort}
            numberMode={pageMathSettings.numberMode}
            angleMode={pageMathSettings.angleMode}
            viewer={!editable}
            labels={{
              panel: t("canvas.math.units.panel"), unitTab: t("canvas.math.units.unitTab"),
              currencyTab: t("canvas.math.units.currencyTab"), value: t("canvas.math.units.value"),
              sourceUnit: t("canvas.math.units.sourceUnit"), targetUnit: t("canvas.math.units.targetUnit"),
              sourceCurrency: t("canvas.math.units.sourceCurrency"), targetCurrency: t("canvas.math.units.targetCurrency"),
              convert: t("canvas.math.units.convert"), converting: t("canvas.math.units.converting"),
              insert: t("canvas.math.units.insert"), result: t("canvas.math.units.result"),
              unavailable: t("canvas.math.units.unavailable"), invalidInput: t("canvas.math.units.invalidInput"),
              dimensionMismatch: t("canvas.math.units.dimensionMismatch"), error: t("canvas.math.units.error"),
              rateSource: t("canvas.math.units.rateSource"), rateAsOf: t("canvas.math.units.rateAsOf"),
              rateStatus: t("canvas.math.units.rateStatus"), current: t("canvas.math.units.current"),
              stale: t("canvas.math.units.stale"), unitName: (unitId) => unitId.replaceAll("-", " "),
              currencyName: (currencyId) => currencyId,
              formatNumber: (value) => new Intl.NumberFormat(language, { maximumFractionDigits: 10 }).format(value),
            }}
            onInsert={(payload) => {
              const latex = conversionPayloadLatex(payload);
              const currencyRate = payload.expression.kind === "currency-conversion" && payload.currencyMetadata
                ? {
                    base: payload.expression.sourceCurrencyId,
                    quote: payload.expression.targetCurrencyId,
                    asOf: payload.currencyMetadata.asOf,
                    source: payload.currencyMetadata.source,
                    status: payload.currencyMetadata.status,
                    snapshotVersion: payload.currencyMetadata.snapshotVersion,
                  }
                : undefined;
              const result: MathElementV3["result"] = {
                state: "valid",
                exactLatex: payload.visibleResult,
                decimalText: payload.visibleResult,
                ...(currencyRate ? { currencyRate } : {}),
                diagnostics: [],
              };
              createTypedMathAt({ x: 80, y: 80 }, latex, result);
              void calculatorHistory.add({
                expression: latex,
                visibleResult: payload.visibleResult,
                numberMode: payload.numberMode,
                angleMode: payload.angleMode,
              }).then(() => setHistoryRevision((value) => value + 1)).catch(() => undefined);
            }}
          />
          {desktopRecognitionAvailable ? <>
          <label className="math-canvas-sidebar__setting">
            {t("canvas.math.providers.active")}
            <select
              value={selectedRecognitionProvider}
              disabled={!editable || Boolean(recognitionProvider)}
              onChange={(event) => {
                recognitionScheduler.dispose();
                recognitionBaselinesRef.current.clear();
                setSelectedRecognitionProvider(event.target.value as RecognitionProvider["kind"]);
              }}
            >
              <option value="compatible">Compatible / TexTeller</option>
              <option value="mathpix">Mathpix</option>
            </select>
          </label>
          <ProviderSettings
            providers={providerViews}
            labels={{ settings: t("canvas.math.providers"), endpoint: t("canvas.math.providers.endpoint"),
              credential: t("canvas.math.providers.token"), appId: t("canvas.math.providers.appId"), appKey: t("canvas.math.providers.appKey"),
              networkScope: t("canvas.math.providers.scope"), privateNetwork: t("canvas.math.providers.private"),
              publicNetwork: t("canvas.math.providers.public"), allowInsecurePrivateHttp: t("canvas.math.providers.insecure"),
              configure: t("canvas.math.providers.configure"), deleteCredential: t("canvas.math.providers.delete"),
              refresh: t("canvas.math.providers.refresh"), unconfigured: t("canvas.math.providers.unconfigured"),
              ready: t("canvas.math.providers.ready"), pending: t("canvas.math.providers.pending"),
              error: t("canvas.math.providers.error"), credentialTooLarge: t("canvas.math.providers.credentialError") }}
            viewer={!editable}
            onConfigureCompatible={async (configuration) => {
              try {
                await providerConfiguration.configureCompatible({ ...configuration, bearerToken: configuration.bearerToken.bytes });
                setProviderViews((items) => items.map((item) => item.id === "compatible" ? { ...item, status: "ready", endpoint: configuration.endpoint } : item));
              } catch {
                setProviderViews((items) => items.map((item) => item.id === "compatible" ? { ...item, status: "error" } : item));
              }
            }}
            onConfigureMathpix={async (configuration) => {
              try {
                await providerConfiguration.configureMathpix({ appId: configuration.appId.bytes, appKey: configuration.appKey.bytes });
                setProviderViews((items) => items.map((item) => item.id === "mathpix" ? { ...item, status: "ready" } : item));
              } catch {
                setProviderViews((items) => items.map((item) => item.id === "mathpix" ? { ...item, status: "error" } : item));
              }
            }}
            onRefreshStatus={async (providerId) => {
              try {
                const status = await providerConfiguration.status(providerId);
                setProviderViews((items) => items.map((item) => item.id === providerId
                  ? { ...item, status: status.configured ? "ready" : "unconfigured" } : item));
              } catch {
                setProviderViews((items) => items.map((item) => item.id === providerId ? { ...item, status: "error" } : item));
              }
            }}
            onDeleteCredential={async (providerId) => {
              try {
                await providerConfiguration.delete(providerId);
                setProviderViews((items) => items.map((item) => item.id === providerId ? { ...item, status: "unconfigured" } : item));
              } catch {
                setProviderViews((items) => items.map((item) => item.id === providerId ? { ...item, status: "error" } : item));
              }
            }}
          />
          </> : (
            <section className="provider-settings" aria-label={t("canvas.math.providers")}>
              <p role="status">{t("canvas.math.providers.webUnavailable")}</p>
            </section>
          )}
          <label className="math-canvas-sidebar__setting">
            {t("canvas.math.angleMode")}
            <select
              value={pageMathSettings.angleMode}
              disabled={!editable}
              onChange={(event) => updateMathSettings({
                angleMode: event.target.value as typeof pageMathSettings.angleMode,
              })}
            >
              <option value="degrees">{t("canvas.math.degrees")}</option>
              <option value="radians">{t("canvas.math.radians")}</option>
            </select>
          </label>
          <label className="math-canvas-sidebar__setting">
            <input
              type="checkbox"
              checked={pageMathSettings.autoRecognition}
              disabled={!editable}
              onChange={(event) => updateMathSettings({ autoRecognition: event.target.checked })}
            />
            {t("canvas.math.autoRecognition.page")}
          </label>
        </aside>
      ) : null}
      <div
        ref={viewportRef}
        className="live-canvas-viewport"
        aria-label={t("canvas.viewport")}
        onPointerDownCapture={(event) => {
          presence?.interacted();
          // A palm or a resting hand never reaches the page: not the ink, not
          // a text box under it, not a drag grip.
          if (event.pointerType !== "touch") return;
          if (acceptPointer(event, "down", rootRef.current, palmRef, viewport.zoom)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishGesture}
        onContextMenu={onContextMenu}
        // A canvas gesture never selects or drags page text.
        onDragStart={(event) => {
          if (!isTextEntryTarget(event.target)) event.preventDefault();
        }}
        onPointerEnter={(event) => {
          acceptPointer(
            event,
            "enter",
            rootRef.current,
            palmRef,
            viewport.zoom,
          );
        }}
        onPointerLeave={(event) => {
          presence?.pointer(null);
          if (event.pointerType === "pen") hidePenCursor();
          acceptPointer(
            event,
            "leave",
            rootRef.current,
            palmRef,
            viewport.zoom,
          );
        }}
        onPointerCancel={(event) => {
          hidePenCursor();
          cancelLongPress();
          releaseTouch(event);
          if (readingDragRef.current?.pointerId === event.pointerId) {
            readingDragRef.current = null;
            readingRef.current?.onSwipeProgress?.(0);
            settleReading();
          }
          clearInkShapeHoldTimer();
          acceptPointer(
            event,
            "cancel",
            rootRef.current,
            palmRef,
            viewport.zoom,
          );
          // A pen or mouse stroke the browser takes away mid-way (a gesture, a
          // driver hiccup) still holds everything drawn so far: keep it.
          const live = liveRef.current;
          if (
            live?.style
            && live.pointerId === event.pointerId
            && event.pointerType !== "touch"
            && (live.tool === "pen" || live.tool === "highlighter")
          ) finishLiveGesture(event, live, true);
          else cancelLiveGesture();
          gestureRef.current = null;
          setGesture(null);
        }}
      >
        <div ref={penCursorRef} className="live-canvas-pen-cursor" hidden aria-hidden="true" />
        <div
          ref={paperRef}
          className={`live-canvas-paper live-canvas-paper--${fixedPaper ? "sheet" : "free"}`}
          data-paper-rule={page.background.type}
          style={paperStyle}
          aria-hidden="true"
        />
        <div
          ref={rootRef}
          className={`live-canvas-surface live-canvas-surface--${page.pageType} live-canvas-surface--${page.background.type}`}
          role="application"
          aria-label={t("canvas.sharedSurface")}
          aria-readonly={!editable}
          data-ink-stroke-count={liveStrokeCount}
          data-page-view={presence ? presenceViewAttribute : undefined}
          data-tool={tool}
          data-touch-draws={touchDrawsNow ? "true" : "false"}
          tabIndex={0}
          style={{
            width: dimensions.width,
            height: dimensions.height,
            transform: surfaceTransform(viewport),
          }}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
        >
          {pageLayers.map((layer) => {
            if (layer.kind === "ink") {
              return <InkLayer key={layer.key} run={layer} hidden={hiddenInk} view={inkView} scale={inkScale} />;
            }
            const element = renderedElements[layer.id] as LivePageElementV2 | undefined;
            if (!element) return null;
            const selected = activeSelectedIds.includes(layer.id);
            const usesPageElements = element.kind === "math" || element.kind === "graph";
            return (
              <LiveElement
                key={layer.id}
                element={element}
                zIndex={layer.zIndex}
                background={layer.background === true}
                selected={selected}
                offset={selected ? dragTranslate : undefined}
                handle={handle}
                writeRichText={richTextWriter}
                editable={editable}
                renderAssetElement={renderAsset}
                pageElements={usesPageElements ? scrubPreviewElements : undefined}
                mathSettings={pageMathSettings}
                onMathUpdate={updateMathElement}
                onMathRecognize={recognizeMathNow}
                onMathSettingsUpdate={updateMathSettings}
                onGraphUpdate={updateGraphElement}
                onScrubPreview={previewScrub}
                onTextGrow={growTextContainer}
              />
            );
          })}
          {dragRun && dragTranslate ? (
            <div
              className="live-canvas-ink-drag"
              style={{ transform: `translate(${dragTranslate.x}px, ${dragTranslate.y}px)` }}
              aria-hidden="true"
            >
              <InkLayer
                run={dragRun}
                hidden={NO_IDS}
                view={{ ...inkView, x: inkView.x - dragTranslate.x, y: inkView.y - dragTranslate.y }}
                scale={inkScale}
              />
            </div>
          ) : null}
          {selectedStrokeIds.map((id) => {
            const element = renderedElements[id];
            if (element?.kind !== "stroke") return null;
            const bounds = strokeBounds(element);
            const pad = element.size / 2 + 3;
            return (
              <div
                key={`ink-selection:${id}`}
                className="live-canvas-element live-canvas-ink-selection is-selected"
                data-element-id={id}
                data-element-kind="stroke"
                aria-label={t("canvas.element.selected", {
                  kind: t(element.tool === "highlighter"
                    ? "canvas.element.highlighterStroke"
                    : "canvas.element.penStroke"),
                })}
                style={{
                  left: bounds.x - pad + (dragTranslate?.x ?? 0),
                  top: bounds.y - pad + (dragTranslate?.y ?? 0),
                  width: bounds.width + pad * 2,
                  height: bounds.height + pad * 2,
                }}
              />
            );
          })}
          {renderedSelectionBounds ? (
            <SelectionResizeOverlay bounds={renderedSelectionBounds} />
          ) : null}
          {penSelectionActive && editable && renderedSelectionBounds && !dragging ? (
            <PenActionBar
              at={{ x: renderedSelectionBounds.x, y: renderedSelectionBounds.y + renderedSelectionBounds.height }}
              zoom={viewport.zoom}
              label={t("canvas.selection.actions")}
              actions={[
                { id: "copy", label: t("canvas.menu.copy"), onClick: () => void copy().catch(() => setClipboardStatus(t("canvas.selection.copyFailed"))) },
                { id: "delete", label: t("canvas.menu.delete"), onClick: deleteSelected },
                ...(renderRegionImage
                  ? [{
                      id: "copyImage",
                      label: t("canvas.selection.copyImage"),
                      onClick: () => captureRegion(renderedSelectionBounds),
                    }]
                  : []),
              ]}
            />
          ) : null}
          {captured ? (
            <PenActionBar
              at={captured.at}
              zoom={viewport.zoom}
              label={t("canvas.capture.actions")}
              status={t(captured.copied ? "canvas.capture.copied" : "canvas.capture.notCopied")}
              actions={insertRegionImage
                ? [{
                    id: "insert",
                    label: t("canvas.capture.insert"),
                    onClick: () => {
                      setCaptured(null);
                      void Promise.resolve(insertRegionImage(captured.png));
                    },
                  }]
                : []}
            />
          ) : null}
          {ruler.visible ? (
            <CanvasRuler
              ruler={ruler}
              editable={editable}
              onPointerDown={onRulerPointerDown}
              onPointerMove={onRulerPointerMove}
              onPointerUp={finishRulerGesture}
              onPointerCancel={finishRulerGesture}
              onKeyDown={onRulerKeyDown}
            />
          ) : null}
          {heldShapePreview ? (
            <div
              className="live-canvas-held-shape-preview"
              data-ink-hold-shape={heldShapePreview.shape}
              style={{
                left: heldShapePreview.frame.x,
                top: heldShapePreview.frame.y,
                width: Math.max(1, heldShapePreview.frame.width),
                height: Math.max(1, heldShapePreview.frame.height),
                transform: `rotate(${heldShapePreview.frame.rotation}deg)`,
              }}
              aria-hidden="true"
            >
              <ShapeSvg element={heldShapePreview} />
            </div>
          ) : null}
          {presence ? (
            <CanvasPresenceLayer
              port={presence}
              zoom={viewport.zoom}
              width={dimensions.width}
              height={dimensions.height}
            />
          ) : null}
        </div>
        <canvas ref={overlayRef} className="live-canvas-ink-overlay" aria-hidden="true" />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {clipboardStatus}
      </p>
      {contextMenu ? (
        <CanvasContextMenu
          label={t("canvas.menu.label")}
          position={contextMenu}
          entries={menuEntries}
          onClose={closeContextMenu}
          onCommand={runMenuCommand}
        />
      ) : null}
      </RichTextToolbarSlotContext.Provider>
    </section>
  );
}

interface CanvasRulerProps {
  ruler: CanvasRulerState;
  editable: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

function CanvasRuler({ ruler, editable, ...handlers }: CanvasRulerProps) {
  const { t } = useI18n();
  const tickCount = Math.floor(ruler.length / 10);
  return (
    <div
      className="live-canvas-ruler"
      role="group"
      aria-label={t("canvas.ruler.accessibleLabel", { angle: ruler.angleDegrees })}
      aria-describedby="canvas-ruler-keyboard-help"
      aria-readonly={!editable}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      tabIndex={0}
      data-ruler-x={ruler.x}
      data-ruler-y={ruler.y}
      data-ruler-angle={ruler.angleDegrees}
      style={{
        left: ruler.x,
        top: ruler.y,
        width: ruler.length,
        height: RULER_HEIGHT,
        transform: `translate(-50%, -50%) rotate(${ruler.angleDegrees}deg)`,
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onKeyDown={handlers.onKeyDown}
    >
      <div
        className="live-canvas-ruler__body"
        data-ruler-action="move"
        aria-hidden="true"
      >
        <span className="live-canvas-ruler__edge" />
        {Array.from({ length: tickCount + 1 }, (_, index) => (
          <i
            key={index}
            className={index % 10 === 0
              ? "is-centimetre"
              : index % 5 === 0
                ? "is-half-centimetre"
                : undefined}
            style={{ left: index * 10 }}
          />
        ))}
      </div>
      <button
        type="button"
        className="live-canvas-ruler__rotate"
        data-ruler-action="rotate"
        aria-label={t("canvas.ruler.rotateHandle")}
        disabled={!editable}
      />
      <span id="canvas-ruler-keyboard-help" className="sr-only">
        {t("canvas.ruler.keyboardHelp")}
      </span>
    </div>
  );
}

type Translate = (
  key: TranslationKey,
  parameters?: TranslationParameters,
) => string;

function shapeLabel(element: ShapeElementV2, t: Translate): string {
  if (element.shape === "arrow" && element.strokeColor === "#0f766e")
    return t("canvas.shape.vector");
  const labels: Record<ShapeElementV2["shape"], TranslationKey> = {
    line: "canvas.shape.line",
    arrow: "canvas.shape.arrow",
    rectangle: "canvas.shape.rectangle",
    ellipse: "canvas.shape.ellipse",
    triangle: "canvas.shape.triangle",
    axes: "canvas.shape.axes",
  };
  return t(labels[element.shape]);
}

function elementKindLabel(element: LivePageElementV2, t: Translate): string {
  if (element.kind === "richText") return t("canvas.element.richText");
  if (element.kind === "stroke")
    return t(
      element.tool === "highlighter"
        ? "canvas.element.highlighterStroke"
        : "canvas.element.penStroke",
    );
  if (element.kind === "shape") return shapeLabel(element, t);
  if (element.kind === "image") return t("canvas.element.image");
  if (element.kind === "pdf") return t("canvas.element.pdf");
  if (element.kind === "math") return t("canvas.element.math");
  if (element.kind === "graph") return t("canvas.element.graph");
  return t("canvas.element.attachment");
}

function SelectionResizeOverlay({ bounds }: { bounds: Rect }) {
  const { t } = useI18n();
  const handles: ReadonlyArray<{
    handle: SelectionResizeHandle;
    label: TranslationKey;
  }> = [
    { handle: "north-west", label: "canvas.selection.resize.northWest" },
    { handle: "north-east", label: "canvas.selection.resize.northEast" },
    { handle: "south-east", label: "canvas.selection.resize.southEast" },
    { handle: "south-west", label: "canvas.selection.resize.southWest" },
  ];
  return (
    <div
      className="live-canvas-selection-resize"
      role="group"
      aria-label={t("canvas.selection.resize")}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      }}
    >
      {handles.map(({ handle, label }) => (
        <button
          key={handle}
          type="button"
          className={`live-canvas-selection-resize__handle live-canvas-selection-resize__handle--${handle}`}
          data-selection-resize={handle}
          aria-label={t(label)}
          title={t(label)}
        />
      ))}
    </div>
  );
}

function localLinePoints(element: ShapeElementV2): [Point, Point] {
  if (element.points?.length === 2) {
    return [
      {
        x: element.points[0].x - element.frame.x,
        y: element.points[0].y - element.frame.y,
      },
      {
        x: element.points[1].x - element.frame.x,
        y: element.points[1].y - element.frame.y,
      },
    ];
  }
  return [
    { x: 0, y: 0 },
    { x: element.frame.width, y: element.frame.height },
  ];
}

export function arrowHeadPoints(
  start: Point,
  end: Point,
  size: number,
): [Point, Point] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const spread = Math.PI / 7;
  return [
    {
      x: end.x - Math.cos(angle - spread) * size,
      y: end.y - Math.sin(angle - spread) * size,
    },
    {
      x: end.x - Math.cos(angle + spread) * size,
      y: end.y - Math.sin(angle + spread) * size,
    },
  ];
}

function ArrowHead({
  start,
  end,
  size,
}: {
  start: Point;
  end: Point;
  size: number;
}) {
  const [left, right] = arrowHeadPoints(start, end, size);
  return (
    <polyline
      points={`${left.x},${left.y} ${end.x},${end.y} ${right.x},${right.y}`}
      fill="none"
    />
  );
}

function ShapeSvg({ element }: { element: ShapeElementV2 }) {
  const { t } = useI18n();
  const width = Math.max(1, element.frame.width);
  const height = Math.max(1, element.frame.height);
  const halfStroke = element.strokeWidth / 2;
  const shared = {
    fill: element.fillColor ?? "transparent",
    stroke: element.strokeColor,
    strokeWidth: element.strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };
  let geometry: ReactNode;
  if (element.shape === "rectangle") {
    geometry = (
      <rect
        x={halfStroke}
        y={halfStroke}
        width={Math.max(0, width - element.strokeWidth)}
        height={Math.max(0, height - element.strokeWidth)}
        {...shared}
      />
    );
  } else if (element.shape === "ellipse") {
    geometry = (
      <ellipse
        cx={width / 2}
        cy={height / 2}
        rx={Math.max(0, (width - element.strokeWidth) / 2)}
        ry={Math.max(0, (height - element.strokeWidth) / 2)}
        {...shared}
      />
    );
  } else if (element.shape === "triangle") {
    geometry = (
      <polygon
        points={`${width / 2},${halfStroke} ${width - halfStroke},${height - halfStroke} ${halfStroke},${height - halfStroke}`}
        {...shared}
      />
    );
  } else if (element.shape === "axes") {
    const center = { x: width / 2, y: height / 2 };
    const right = { x: width - halfStroke, y: center.y };
    const top = { x: center.x, y: halfStroke };
    const arrowSize = Math.min(12, Math.max(5, Math.min(width, height) / 5));
    geometry = (
      <g {...shared} fill="none">
        <line x1={halfStroke} y1={center.y} x2={right.x} y2={right.y} />
        <line x1={center.x} y1={height - halfStroke} x2={top.x} y2={top.y} />
        <ArrowHead start={center} end={right} size={arrowSize} />
        <ArrowHead start={center} end={top} size={arrowSize} />
      </g>
    );
  } else {
    const [start, end] = localLinePoints(element);
    const arrowSize = Math.min(
      14,
      Math.max(6, Math.hypot(end.x - start.x, end.y - start.y) / 4),
    );
    geometry = (
      <g {...shared} fill="none">
        <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
        {element.shape === "arrow" ? (
          <ArrowHead start={start} end={end} size={arrowSize} />
        ) : null}
      </g>
    );
  }
  return (
    <svg
      className="live-canvas-shape"
      data-shape-kind={
        element.shape === "arrow" && element.strokeColor === "#0f766e"
          ? "vektor"
          : element.shape
      }
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={shapeLabel(element, t)}
    >
      {geometry}
    </svg>
  );
}

/**
 * One DOM element on the page (text, image, PDF, shape, Math, graph). Ink is
 * not rendered here but on canvas layers. Memoised: page snapshots share
 * unchanged elements, so a new stroke does not re-render the others.
 */
const LiveElement = memo(function LiveElement({
  element,
  zIndex,
  background = false,
  selected,
  offset,
  handle,
  writeRichText,
  editable,
  renderAssetElement,
  pageElements,
  mathSettings,
  onMathUpdate,
  onMathRecognize,
  onMathSettingsUpdate,
  onGraphUpdate,
  onScrubPreview,
  onTextGrow,
}: {
  element: LivePageElementV2;
  zIndex: number;
  /** A page background: drawn below everything and ignored by the pointer. */
  background?: boolean;
  selected: boolean;
  /** Live translation while the selection is dragged. */
  offset?: Point;
  handle: ReadonlyDocHandle<LivePageDocV2>;
  writeRichText: RichTextWriter<LivePageDocV2>;
  editable: boolean;
  renderAssetElement?: LiveCanvasEditorProps["renderAssetElement"];
  /** Only Math blocks and graphs read the rest of the page. */
  pageElements?: Readonly<Record<string, LivePageElementV2>>;
  mathSettings: ReturnType<typeof mathPageSettings>;
  onMathUpdate: (elementId: string, update: Partial<MathElementV3>, message: string) => void;
  onMathRecognize: (elementId: string) => void;
  onMathSettingsUpdate: (update: Partial<ReturnType<typeof mathPageSettings>>) => void;
  onGraphUpdate: (elementId: string, update: Partial<GraphElementV3>, message: string) => void;
  onScrubPreview: (elementId: string, latex: string | null) => void;
  onTextGrow?: (elementId: string, height: number) => void;
}) {
  const { t } = useI18n();
  // Text containers grow with their content, like OneNote note containers.
  // The stored height is a minimum that follows the text while it is edited,
  // so the selection frame and exports cover every line.
  const height = Math.max(1, element.frame.height);
  const nodeRef = useRef<HTMLDivElement>(null);
  const growsWithText = element.kind === "richText" && selected && editable && Boolean(onTextGrow);
  useEffect(() => {
    const node = nodeRef.current;
    if (!growsWithText || !node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (node.offsetHeight > height + 1) onTextGrow?.(element.id, Math.ceil(node.offsetHeight));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element.id, growsWithText, height, onTextGrow]);
  const style = {
    left: element.frame.x,
    top: element.frame.y,
    width: Math.max(1, element.frame.width),
    ...(element.kind === "richText" ? { minHeight: height, ...richTextAppearance(element.style) } : { height }),
    transform: offset
      ? `translate(${offset.x}px, ${offset.y}px) rotate(${element.frame.rotation}deg)`
      : `rotate(${element.frame.rotation}deg)`,
    zIndex,
  };
  const previewCandidate = pageElements?.[element.id];
  const previewMathElement = previewCandidate?.kind === "math" ? previewCandidate : undefined;
  let content;
  if (element.kind === "richText") {
    content = (
      <>
      {/* OneNote's dotted bar above a note container: drag it to move. */}
      {editable && !element.locked ? <span className="live-canvas-element__grip" aria-hidden="true" /> : null}
      <RichTextEditor
        handle={handle as unknown as RichTextDocHandle<LivePageDocV2>}
        write={writeRichText}
        path={liveRichTextPath(element.id)}
        ariaLabel={t("canvas.richText.shared")}
        editable={editable && !element.locked}
      />
      </>
    );
  } else if (element.kind === "shape") {
    content = <ShapeSvg element={element} />;
  } else if (element.kind === "math") {
    content = (
      <MathElementView
        element={element}
        previewElement={previewMathElement}
        editable={editable && !element.locked}
        settings={mathSettings}
        onUpdate={onMathUpdate}
        onRecognize={() => onMathRecognize(element.id)}
        onSettingsUpdate={onMathSettingsUpdate}
        onScrubPreview={onScrubPreview}
      />
    );
  } else if (element.kind === "graph") {
    content = (
      <GraphElementView
        element={element}
        pageElements={pageElements ?? {}}
        angleMode={mathSettings.angleMode}
        editable={editable && !element.locked}
        onUpdate={onGraphUpdate}
      />
    );
  } else if (
    element.kind === "image" ||
    element.kind === "pdf" ||
    element.kind === "attachment"
  ) {
    content = renderAssetElement?.(element) ?? (
      <span>
        {element.kind === "image"
          ? element.alt || t("canvas.element.image")
          : element.kind === "pdf"
            ? t("canvas.pdf.pages", { count: element.pageCount })
            : t("canvas.attachment.name", { name: element.displayName })}
      </span>
    );
  } else {
    content = null;
  }
  return (
    <div
      ref={nodeRef}
      className={`live-canvas-element${selected ? " is-selected" : ""}${background ? " is-background" : ""}`}
      data-element-id={element.id}
      data-element-kind={element.kind}
      data-background={background ? "true" : undefined}
      style={style}
      tabIndex={0}
      aria-label={
        background
          ? t("canvas.element.background", { kind: elementKindLabel(element, t) })
          : selected
            ? t("canvas.element.selected", { kind: elementKindLabel(element, t) })
            : elementKindLabel(element, t)
      }
    >
      {content}
    </div>
  );
});

function MathElementView({
  element,
  previewElement,
  editable,
  settings,
  onUpdate,
  onRecognize,
  onSettingsUpdate,
  onScrubPreview,
}: {
  element: MathElementV3;
  previewElement?: MathElementV3;
  editable: boolean;
  settings: ReturnType<typeof mathPageSettings>;
  onUpdate: (elementId: string, update: Partial<MathElementV3>, message: string) => void;
  onRecognize: () => void;
  onSettingsUpdate: (update: Partial<ReturnType<typeof mathPageSettings>>) => void;
  onScrubPreview: (elementId: string, latex: string | null) => void;
}) {
  const { t } = useI18n();
  const baseLatex = mathElementLatex(element);
  const displayedElement = previewElement ?? element;
  const displayedLatex = mathElementLatex(displayedElement);
  const scrubbable = useMemo(() => {
    try {
      return listScrubbableNumbers(baseLatex);
    } catch {
      return null;
    }
  }, [baseLatex]);
  const labels: MathBlockLabels = {
    idle: t("canvas.math.status.idle"),
    typed: t("canvas.math.typed"),
    ink: t("canvas.math.ink"),
    pending: t("canvas.math.status.pending"),
    recognized: t("canvas.math.status.recognized"),
    ambiguous: t("canvas.math.status.ambiguous"),
    error: t("canvas.math.status.error"),
    undefinedVariable: t("canvas.math.status.undefinedVariable"),
    dependencyCycle: t("canvas.math.status.dependencyCycle"),
    openCorrection: t("canvas.math.openCorrection"),
    correction: t("canvas.math.correction"),
    resultMode: t("canvas.math.resultMode"),
    suggest: t("canvas.math.resultMode.suggest"),
    insert: t("canvas.math.resultMode.insert"),
    off: t("canvas.math.resultMode.off"),
    numberMode: t("canvas.math.numberMode"),
    exact: t("canvas.math.numberMode.exact"),
    decimal: t("canvas.math.numberMode.decimal"),
    result: t("canvas.math.result"),
    acceptSuggestion: t("canvas.math.result.accept"),
    autoRecognition: t("canvas.math.autoRecognition.block"),
    autoRecognitionInherit: t("canvas.math.autoRecognition.inherit"),
    autoRecognitionEnabled: t("canvas.math.autoRecognition.enabled"),
    autoRecognitionDisabled: t("canvas.math.autoRecognition.disabled"),
    recognizeNow: t("canvas.math.recognizeNow"),
  };
  const recognitionStatus = displayedElement.recognition.state === "scheduled" || displayedElement.recognition.state === "pending"
    ? "pending"
    : displayedElement.result.state === "error" || displayedElement.recognition.state === "unrecognized"
      ? "error"
      : displayedElement.recognition.state;
  const inkPreview = element.rawInk ? (
    <svg
      viewBox={`0 0 ${Math.max(1, element.rawInk.captureFrame.width)} ${Math.max(1, element.rawInk.captureFrame.height)}`}
      aria-hidden="true"
    >
      {element.rawInk.sourceStrokes.map((stroke) => (
        <polyline
          key={stroke.id}
          points={stroke.points.map((point) => (
            `${point.x - element.rawInk!.captureFrame.x},${point.y - element.rawInk!.captureFrame.y}`
          )).join(" ")}
          fill="none"
          stroke={stroke.color}
          strokeWidth={stroke.size}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  ) : undefined;
  return (
    <div className="math-element-view">
      <MathBlock
      latex={displayedLatex}
      inputKind={displayedElement.inputKind === "typed" ? "typed" : "ink"}
      status={recognitionStatus}
      resultMode={settings.resultMode}
      numberMode={settings.numberMode}
      autoRecognition={displayedElement.autoRecognition}
      exactResult={displayedElement.result.exactLatex}
      decimalResult={displayedElement.result.decimalText}
      candidates={displayedElement.recognition.alternatives}
      dependencyState={displayedElement.dependencies.state}
      diagnostics={displayedElement.result.diagnostics}
      inkPreview={inkPreview}
      editable={editable}
      labels={labels}
      onTypedInput={(latex) => onUpdate(element.id, {
        typedLatex: latex,
        result: { state: "none", diagnostics: [] },
        dependencies: { defines: [], references: [], dependsOnElementIds: [], state: "valid" },
      }, "Edit typed math")}
      onCorrection={(correction) => {
        const corrected = applyMathCorrection(element, correction.latex, new Date().toISOString());
        onUpdate(
          element.id,
          {
            correctedLatex: corrected.correctedLatex,
            result: corrected.result,
            dependencies: corrected.dependencies,
          },
          correction.source === "candidate" ? "Choose math recognition candidate" : "Correct math formula",
        );
      }}
      onResultModeChange={(resultMode) => onSettingsUpdate({ resultMode })}
      onNumberModeChange={(numberMode) => onSettingsUpdate({ numberMode })}
      onAutoRecognitionChange={(autoRecognition) => onUpdate(
        element.id,
        { autoRecognition },
        "Change Math block automatic recognition",
      )}
      onAcceptSuggestion={() => onSettingsUpdate({ resultMode: "insert" })}
      onRecognizeNow={onRecognize}
      />
      {displayedElement.result.currencyRate ? (
        <small className="math-element-view__currency-rate">
          {t("canvas.math.currencyRate", {
            source: displayedElement.result.currencyRate.source,
            date: displayedElement.result.currencyRate.asOf,
            status: t(displayedElement.result.currencyRate.status === "stale"
              ? "canvas.math.units.stale"
              : "canvas.math.units.current"),
            version: displayedElement.result.currencyRate.snapshotVersion,
          })}
        </small>
      ) : null}
      {scrubbable && scrubbable.literals.length > 0 ? (
        <div className="math-element-view__scrubbers" role="group" aria-label={t("canvas.math.scrubbers")}>
          {scrubbable.literals.map((literal) => (
            <NumberScrubber
              key={literal.id}
              value={literal.value}
              step={literal.role === "exponent" ? 1 : 1}
              viewer={!editable}
              labels={{
                scrubber: t("canvas.math.scrubber", { value: literal.source }),
                value: t("canvas.math.scrubber.value"),
              }}
              onPreview={(value) => {
                try {
                  onScrubPreview(element.id, replaceScrubbableNumber(baseLatex, {
                    targetId: literal.id,
                    sourceFingerprint: scrubbable.sourceFingerprint,
                    value,
                  }).latex);
                } catch {
                  onScrubPreview(element.id, null);
                }
              }}
              onCommit={(value) => {
                const replacement = replaceScrubbableNumber(baseLatex, {
                  targetId: literal.id,
                  sourceFingerprint: scrubbable.sourceFingerprint,
                  value,
                });
                const corrected = applyMathCorrection(element, replacement.latex, new Date().toISOString());
                onScrubPreview(element.id, null);
                onUpdate(element.id, {
                  correctedLatex: corrected.correctedLatex,
                  result: corrected.result,
                  dependencies: corrected.dependencies,
                }, "Scrub math number");
              }}
              onCancel={() => onScrubPreview(element.id, null)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GraphElementView({
  element,
  pageElements,
  angleMode,
  editable,
  onUpdate,
}: {
  element: GraphElementV3;
  pageElements: Readonly<Record<string, LivePageElementV2>>;
  angleMode: "degrees" | "radians";
  editable: boolean;
  onUpdate: (elementId: string, update: Partial<GraphElementV3>, message: string) => void;
}) {
  const { t } = useI18n();
  const [inspectedPoint, setInspectedPoint] = useState<{ x: number; y: number } | null>(null);
  const coordinateFrameRef = useRef<number | null>(null);
  const series = useMemo(
    () => graphSeriesFromPage(element, pageElements, angleMode),
    [angleMode, element, pageElements],
  );
  const viewport = useMemo(() => ({
    xMin: element.viewport.xMin,
    xMax: element.viewport.xMax,
    yMin: element.viewport.yMin,
    yMax: element.viewport.yMax,
  }), [element.viewport.xMax, element.viewport.xMin, element.viewport.yMax, element.viewport.yMin]);
  const changeVisibility = useCallback((renderSeriesId: string, visible: boolean) => {
    const sourceSeriesId = element.series.find((item) => (
      renderSeriesId === item.id || renderSeriesId.startsWith(`${item.id}:`)
    ))?.id;
    if (!sourceSeriesId) return;
    onUpdate(
      element.id,
      { series: element.series.map((item) => item.id === sourceSeriesId ? { ...item, visible } : item) },
      "Change graph series visibility",
    );
  }, [element.id, element.series, onUpdate]);
  // The newest viewport this view has written. A pan or zoom is committed after
  // a short pause, so it can land in the same render as a toggle; each write
  // starts from the newest viewport, not from the element of the last render,
  // or the later one would undo the earlier.
  const latestViewportRef = useRef(element.viewport);
  useLayoutEffect(() => {
    latestViewportRef.current = element.viewport;
  }, [element.viewport]);
  const writeViewport = useCallback((patch: Partial<GraphElementV3["viewport"]>, message: string) => {
    const next = { ...latestViewportRef.current, ...patch };
    latestViewportRef.current = next;
    onUpdate(element.id, { viewport: next }, message);
  }, [element.id, onUpdate]);
  const changeEqualScale = useCallback(
    (equalScale: boolean) => writeViewport({ equalScale }, "Change graph axis scale"),
    [writeViewport],
  );
  const changeAxesVisible = useCallback(
    (axesVisible: boolean) => writeViewport({ axesVisible }, "Change graph axes visibility"),
    [writeViewport],
  );
  const changeGridVisible = useCallback(
    (gridVisible: boolean) => writeViewport({ gridVisible }, "Change graph grid visibility"),
    [writeViewport],
  );
  const changeViewport = useCallback(
    (next: { xMin: number; xMax: number; yMin: number; yMax: number }) => writeViewport(next, "Change graph viewport"),
    [writeViewport],
  );
  const inspectCoordinate = useCallback((point: { x: number; y: number }) => {
    const nearest = nearestGraphCoordinate(series, point, viewport);
    if (typeof requestAnimationFrame !== "function") {
      setInspectedPoint(nearest);
      return;
    }
    if (coordinateFrameRef.current !== null) cancelAnimationFrame(coordinateFrameRef.current);
    coordinateFrameRef.current = requestAnimationFrame(() => {
      coordinateFrameRef.current = null;
      setInspectedPoint(nearest);
    });
  }, [series, viewport]);
  useEffect(() => () => {
    if (coordinateFrameRef.current !== null) cancelAnimationFrame(coordinateFrameRef.current);
  }, []);
  return (
    <div className="graph-element-view">
      <GraphBoard
      factory={jsxGraphFactoryOnDemand()}
      series={series}
      viewport={viewport}
      resetViewport={{ xMin: -10, xMax: 10, yMin: -10, yMax: 10 }}
      equalScale={element.viewport.equalScale}
      axesVisible={element.viewport.axesVisible}
      gridVisible={element.viewport.gridVisible}
      viewer={!editable}
      labels={{
        graph: t("canvas.math.graph"),
        reset: t("canvas.math.graph.reset"),
        equalScale: t("canvas.math.graph.equalScale"),
        axesVisible: t("canvas.math.graph.axesVisible"),
        gridVisible: t("canvas.math.graph.gridVisible"),
        visible: t("canvas.math.graph.visible"),
        coordinate: t("canvas.math.graph.coordinate"),
      }}
      onVisibilityChange={changeVisibility}
      onEqualScaleChange={changeEqualScale}
      onAxesVisibleChange={changeAxesVisible}
      onGridVisibleChange={changeGridVisible}
      onViewportChange={changeViewport}
      onCoordinateInspect={inspectCoordinate}
      />
      <output
        className="graph-element-view__coordinate"
        aria-live="polite"
        aria-label={t("canvas.math.graph.inspectedPoint")}
      >
        {inspectedPoint ? formatGraphCoordinate(inspectedPoint) : t("canvas.math.graph.noInspectedPoint")}
      </output>
    </div>
  );
}

export function formatGraphCoordinate(point: { x: number; y: number }): string {
  const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
  return `x = ${format.format(point.x)}, y = ${format.format(point.y)}`;
}

export function nearestGraphCoordinate(
  series: readonly GraphSeries[],
  target: { x: number; y: number },
  viewport: { xMin: number; xMax: number; yMin: number; yMax: number },
): { x: number; y: number } | null {
  const xRange = Math.max(Number.EPSILON, viewport.xMax - viewport.xMin);
  const yRange = Math.max(Number.EPSILON, viewport.yMax - viewport.yMin);
  let nearest: { x: number; y: number } | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const item of series) {
    if (!item.visible) continue;
    for (const point of item.points) {
      const distance = ((point.x - target.x) / xRange) ** 2 + ((point.y - target.y) / yRange) ** 2;
      if (distance >= nearestDistance) continue;
      nearestDistance = distance;
      nearest = { x: point.x, y: point.y };
    }
  }
  return nearest;
}

function mathOnly(
  elements: Readonly<Record<string, PageElementV2>>,
): Record<string, PageElementV2> {
  const subset: Record<string, PageElementV2> = {};
  for (const id in elements) {
    if (elements[id].kind === "math") subset[id] = elements[id];
  }
  return subset;
}

function sameEntries(
  left: Readonly<Record<string, PageElementV2>>,
  right: Readonly<Record<string, PageElementV2>>,
): boolean {
  const leftIds = Object.keys(left);
  return leftIds.length === Object.keys(right).length
    && leftIds.every((id) => left[id] === right[id]);
}

/**
 * The page's Math blocks, as the same object for as long as none of them
 * changed, so Math recomputation does not rerun for every ink stroke.
 */
function useStableMathSubset(
  elements: Readonly<Record<string, PageElementV2>>,
): Record<string, PageElementV2> {
  const [state, setState] = useState(() => ({ source: elements, subset: mathOnly(elements) }));
  if (state.source === elements) return state.subset;
  const next = mathOnly(elements);
  const subset = sameEntries(state.subset, next) ? state.subset : next;
  setState({ source: elements, subset });
  return subset;
}

const projectedRichText = new WeakMap<object, PageElementV2>();

/**
 * The editor's element map for a page snapshot. Snapshots are frozen and
 * share unchanged elements between versions, so non-text elements are used as
 * they are and a rich-text projection is computed once per element version.
 * A page change therefore costs one pass over the ids, not a deep copy.
 */
export function liveMapToOperationMap(
  elements: Readonly<Record<string, LivePageElementV2>>,
  projectRichText?: (elementId: string) => RichTextDocument,
): Record<string, PageElementV2> {
  const result: Record<string, PageElementV2> = {};
  for (const id in elements) {
    const element = elements[id];
    if (element.kind !== "richText") {
      result[id] = element;
      continue;
    }
    const cached = projectRichText ? projectedRichText.get(element) : undefined;
    if (cached) {
      result[id] = cached;
      continue;
    }
    const { text, ...metadata } = element;
    const projected: PageElementV2 = {
      ...structuredClone(metadata),
      kind: "richText",
      content: projectRichText ? NOT_PROJECTED_YET : plainTextContent(id, text),
    };
    // Projecting the spans costs time proportional to the text, and a
    // keystroke in a long text box changes the element, so it is done when the
    // content is first read (copying, undo, checking for emptiness).
    if (projectRichText) {
      defineLazyContent(projected, lazyProjection(projectRichText, id, text));
      projectedRichText.set(element, projected);
    }
    result[id] = projected;
  }
  return result;
}

/** Stands in for `content` until `defineLazyContent` replaces the property. */
const NOT_PROJECTED_YET: RichTextDocument = Object.freeze({ type: "doc", blocks: [] });

function plainTextContent(elementId: string, text: string): RichTextDocument {
  return {
    type: "doc",
    blocks: [
      {
        id: `live-fallback-${elementId}`,
        type: "paragraph",
        spans: text ? [{ text, marks: [] }] : [],
      },
    ],
  };
}

/**
 * Reads a text box's content from the live document. The function that
 * builds it is created here, in its own scope: closures created inside the
 * editor component would keep the component's whole scope (its DOM nodes and
 * canvases) alive for as long as the cached element does.
 */
function richTextProjector(handle: { doc(): unknown }): (elementId: string) => RichTextDocument {
  return (elementId) => projectLiveRichText(handle.doc() as PageAutomergeDoc, elementId);
}

/** The projection of one text box; a text box that was removed since reads as its plain text. */
function lazyProjection(
  projectRichText: (elementId: string) => RichTextDocument,
  elementId: string,
  text: string,
): () => RichTextDocument {
  return () => {
    try {
      return projectRichText(elementId);
    } catch {
      return plainTextContent(elementId, text);
    }
  };
}

/** `content` becomes a plain value on first read. */
function defineLazyContent(element: object, project: () => RichTextDocument): void {
  const settle = (value: RichTextDocument) => Object.defineProperty(element, "content", {
    value, writable: true, configurable: true, enumerable: true,
  });
  Object.defineProperty(element, "content", {
    configurable: true,
    enumerable: true,
    get() {
      const content = project();
      settle(content);
      return content;
    },
    set: settle,
  });
}

function acceptPointer(
  event: ReactPointerEvent<HTMLDivElement>,
  phase: "down" | "move" | "up" | "cancel" | "enter" | "leave",
  root: HTMLDivElement | null,
  palmRef: { current: PalmRejectionState },
  zoom = 1,
): boolean {
  const result = updatePalmRejection(
    palmRef.current,
    phase,
    pointerSample(event.nativeEvent, eventPoint(event, root, zoom)),
  );
  palmRef.current = result.state;
  return result.accepted;
}

/** Pointer samples of a live gesture, using the surface position from its start. */
function livePoints(
  event: ReactPointerEvent<HTMLDivElement>,
  rect: { left: number; top: number },
  zoom: number,
  preset: LivePenPreset | undefined,
): StrokePointV2[] {
  const native = event.nativeEvent;
  return inkSamples(native, native.getCoalescedEvents?.() ?? [], rect, zoom, preset);
}

/**
 * Where the browser predicts the pen will be by the next frame (empty where
 * it has no prediction). They are painted on the overlay only, so the stored
 * stroke holds real samples and an overshoot vanishes on the next move.
 */
function predictedPoints(
  event: ReactPointerEvent<HTMLDivElement>,
  rect: { left: number; top: number },
  zoom: number,
  preset: LivePenPreset | undefined,
): StrokePointV2[] {
  const predicted = event.nativeEvent.getPredictedEvents?.() ?? [];
  const last = predicted.at(-1);
  return last ? inkSamples(last, predicted.slice(0, -1), rect, zoom, preset) : [];
}

/** `primary` is the newest sample; `earlier` are the ones before it, oldest first. */
function inkSamples(
  primary: PointerEvent,
  earlier: readonly PointerEvent[],
  rect: { left: number; top: number },
  zoom: number,
  preset: LivePenPreset | undefined,
): StrokePointV2[] {
  const toCanvas = (sample: PointerEvent) =>
    clientPointToCanvas({ x: sample.clientX, y: sample.clientY }, rect, zoom);
  return normalizePointerSamples(
    pointerSample(primary, toCanvas(primary)),
    earlier.map((sample) => pointerSample(sample, toCanvas(sample))),
  ).map((point) => ({
    ...point,
    pressure: applyPressureCurve(point.pressure, preset?.pressureCurve ?? "linear"),
  }));
}

function liveOverlayTransform(
  overlay: HTMLCanvasElement | null,
  surface: HTMLElement | null,
  zoom: number,
): OverlayTransform | null {
  return overlay && surface ? overlayTransform(overlay, surface, zoom) : null;
}

export function applyPressureCurve(
  pressure: number,
  curve: PressureCurve,
): number {
  if (curve === "soft") return Math.sqrt(Math.max(0, pressure));
  if (curve === "firm") return Math.max(0, pressure) ** 2;
  return Math.max(0, pressure);
}

function pointerSample(event: PointerEvent, point: Point): PointerSampleLike {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    x: point.x,
    y: point.y,
    pressure: event.pressure,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    time: event.timeStamp,
    buttons: event.buttons,
    width: event.width,
    height: event.height,
  };
}

function performanceClockNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function eventPoint(
  event: ReactPointerEvent<HTMLDivElement>,
  root: HTMLDivElement | null,
  zoom = 1,
): Point {
  const rect = root?.getBoundingClientRect();
  return clientPointToCanvas(
    { x: event.clientX, y: event.clientY },
    rect ?? { left: 0, top: 0 },
    zoom,
  );
}

function pointToStrokePoint(point: Point, time: number): StrokePointV2 {
  return {
    ...point,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    time,
    pointerType: "unknown",
  };
}

function snapDrawPoint(
  point: StrokePointV2,
  grid: boolean,
  angle: boolean,
  ruler: CanvasRulerState | undefined,
  start: Point,
): StrokePointV2 {
  let next: Point = point;
  if (grid) next = snapPointToGrid(next, 10);
  if (angle) next = snapPointToAngle(start, next, 15);
  if (ruler?.visible)
    next = snapPointToRulerEdge(next, rulerEdgeGeometry(ruler), Number.POSITIVE_INFINITY);
  return { ...point, ...next };
}

/**
 * Text boxes created in Canvink keep the canvas font. Imported ones (from
 * OneNote) carry their own colour, font and size in the element style, which
 * is applied only where it differs from Canvink's own defaults. Text with its
 * own font also gets OneNote's compact metrics (single line spacing, no
 * paragraph gap, tight table cells), so handwriting that was written next to
 * the text still lines up with it.
 */
function richTextAppearance(
  style: { color: string; fontFamily: string; fontSize: number },
): CSSProperties & Record<`--${string}`, string> {
  const appearance: CSSProperties & Record<`--${string}`, string> = {};
  if (style.color && style.color.toLowerCase() !== "#111827") appearance.color = style.color;
  if (style.fontFamily && !style.fontFamily.startsWith("Inter")) {
    appearance.fontFamily = style.fontFamily;
    appearance["--canvink-text-line-height"] = "1.3";
    appearance["--canvink-paragraph-gap"] = "0";
    appearance["--canvink-text-padding"] = "0";
    appearance["--canvink-cell-padding"] = "3px 5px";
    // Imported tables have no column widths in the rich-text model; sizing
    // columns by their content comes closest to OneNote's own widths.
    appearance["--canvink-table-layout"] = "auto";
  }
  if (Number.isFinite(style.fontSize) && style.fontSize !== 16) appearance.fontSize = style.fontSize;
  return appearance;
}

function frameForStroke(points: readonly StrokePointV2[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    rotation: 0,
  };
}

function strokeTombstonePatch(before: StrokeElementV2, after: StrokeElementV2) {
  return {
    elementId: before.id,
    before: { tombstonedAt: before.tombstonedAt, updatedAt: before.updatedAt },
    after: { tombstonedAt: after.tombstonedAt, updatedAt: after.updatedAt },
  } as LocalCommand["patches"][number];
}

/** The text block a press landed on, outside its editable text (the block's own padding or empty lower part). */
function textBlockUnder(
  target: EventTarget,
  elements: Readonly<Record<string, { kind: string } | undefined>>,
): { id: string; editor: HTMLElement } | undefined {
  if (!(target instanceof Element) || isTextEntryTarget(target)) return undefined;
  const container = target.closest<HTMLElement>("[data-element-id]");
  const id = container?.dataset.elementId;
  if (!container || !id || elements[id]?.kind !== "richText") return undefined;
  const editor = container.querySelector<HTMLElement>("[contenteditable='true']");
  return editor ? { id, editor } : undefined;
}

/**
 * Focuses an editable once the tap's own click has passed: the browser moves focus to the block
 * it tapped (a focusable container) after the pointer is up, which would undo an earlier focus.
 */
function focusAfterTap(editor: HTMLElement): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    document.removeEventListener("click", onClick, true);
    window.clearTimeout(timer);
    if (editor.isConnected) focusAtEnd(editor);
  };
  const onClick = () => queueMicrotask(run);
  const timer = window.setTimeout(run, 400);
  document.addEventListener("click", onClick, true);
}

/** Focuses an editable with the caret after its last character. */
function focusAtEnd(editor: HTMLElement): void {
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function findElementId(target: EventTarget): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest<HTMLElement>("[data-element-id]")?.dataset.elementId;
}

function findSelectionResizeHandle(target: EventTarget): SelectionResizeHandle | undefined {
  if (!(target instanceof Element)) return undefined;
  const value = target.closest<HTMLElement>("[data-selection-resize]")
    ?.dataset.selectionResize;
  return value === "north-west" || value === "north-east"
    || value === "south-east" || value === "south-west"
    ? value
    : undefined;
}

function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

function defaultCreateId(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`;
}

function defaultClipboard() {
  return {
    readText: async () => navigator.clipboard.readText(),
    writeText: async (value: string) => navigator.clipboard.writeText(value),
  };
}
