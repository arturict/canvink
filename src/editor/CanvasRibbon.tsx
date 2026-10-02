import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Axis3D,
  ChartLine,
  Circle,
  CircleDot,
  ClipboardPaste,
  Copy,
  Eraser,
  Gauge,
  Grid3X3,
  Hand,
  Highlighter,
  LassoSelect,
  Minus,
  MousePointer2,
  MoveDiagonal2,
  PanelRightOpen,
  PenTool,
  Plus,
  Redo2,
  RectangleHorizontal,
  RotateCw,
  Ruler,
  Sigma,
  Slash,
  Table,
  SquareFunction,
  Triangle,
  Type,
  Undo2,
  VectorSquare,
  type LucideIcon,
} from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import { VIEWER_APP } from "../platform/viewerApp";
import { type InkStyle, type InkTool } from "./penStyles";
import { PenStyleMenu } from "./PenStyleMenu";
import { EditorState } from "prosemirror-state";
import { RichTextToolbar } from "./richText/RichTextToolbar";
import { canvinkRichTextSchema } from "./richText/schema";
import type { LiveCanvasTool } from "./LiveCanvasEditor";
import type { ToolbarProps } from "./LiveCanvasToolbar";

/** Elements of the notebook's ribbon that the canvas fills with its groups. */
export interface CanvasRibbonSlots {
  home: HTMLElement | null;
  insert: HTMLElement | null;
  draw: HTMLElement | null;
  view: HTMLElement | null;
  /** The floating ink toolbar of the full page view, when it is shown. */
  float?: HTMLElement | null;
  /** The collapsed floating toolbar's button, which shows the current pen. */
  floatCurrent?: HTMLElement | null;
}

/**
 * A pen gallery as in OneNote's Draw tab: a few ready pens and highlighters
 * instead of a colour picker; the width buttons next to it apply to the
 * active one.
 */
const PEN_GALLERY: ReadonlyArray<{ tool: InkTool; color: string; labelKey: TranslationKey }> = [
  { tool: "pen", color: "#1f2937", labelKey: "canvas.ink.color.black" },
  { tool: "pen", color: "#1d4ed8", labelKey: "canvas.ink.color.blue" },
  { tool: "pen", color: "#dc2626", labelKey: "canvas.ink.color.red" },
  { tool: "pen", color: "#15803d", labelKey: "canvas.ink.color.green" },
  { tool: "pen", color: "#7c3aed", labelKey: "canvas.ink.color.purple" },
  { tool: "highlighter", color: "#facc15", labelKey: "canvas.ink.color.yellow" },
  { tool: "highlighter", color: "#4ade80", labelKey: "canvas.ink.color.green" },
  { tool: "highlighter", color: "#f472b6", labelKey: "canvas.ink.color.pink" },
];

const IDLE_TEXT_STATE = EditorState.create({ schema: canvinkRichTextSchema });

export interface CanvasRibbonProps extends ToolbarProps {
  slots: CanvasRibbonSlots;
  /** Selected ink strokes, which the pen menu restyles ("Auswahl anpassen"). */
  selectedInkCount: number;
  restyleSelection: (update: Partial<InkStyle>) => void;
}

function RibbonButton({
  label,
  icon: Icon,
  onClick,
  pressed,
  disabled = false,
  showLabel = false,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  onClick: () => void | Promise<void>;
  pressed?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ribbon-button${showLabel ? " ribbon-button--labelled" : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children ?? (showLabel ? <span>{label}</span> : null)}
    </button>
  );
}

function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ribbon-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * The canvas part of the OneNote-style ribbon. Each group is portalled into
 * the tab of the notebook ribbon it belongs to; the ribbon itself lives in the
 * notebook shell because this editor remounts on every page switch.
 */
export function CanvasRibbon(props: CanvasRibbonProps) {
  const { t } = useI18n();
  const { slots, onFormatSlotMount } = props;
  const inkTool: InkTool | null =
    props.tool === "pen" || props.tool === "highlighter" ? props.tool : null;
  const toolButton = (value: LiveCanvasTool, labelKey: TranslationKey, icon: LucideIcon, showLabel = false) => (
    <RibbonButton
      key={value}
      label={t(labelKey)}
      icon={icon}
      pressed={props.tool === value}
      onClick={() => props.setTool(value)}
      disabled={!props.editable && value !== "select" && value !== "pan"}
      showLabel={showLabel}
    />
  );

  const penGallery = (className: string) => (
    <div className={className} role="radiogroup" aria-label={t("ribbon.group.pens")}>
      {PEN_GALLERY.map((pen) => {
        const active = props.tool === pen.tool && props.inkStyles[pen.tool].color === pen.color;
        const name = `${t(pen.tool === "pen" ? "canvas.tool.pen" : "canvas.tool.highlighter")} ${t(pen.labelKey)}`;
        const Icon = pen.tool === "pen" ? PenTool : Highlighter;
        return (
          <button
            key={`${pen.tool}-${pen.color}`}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={name}
            title={name}
            className={`ribbon-pen ribbon-pen--${pen.tool}`}
            disabled={!props.editable}
            onClick={() => {
              props.setInkStyle(pen.tool, { color: pen.color });
              props.setTool(pen.tool);
            }}
          >
            <Icon aria-hidden="true" style={{ color: pen.color }} />
            <span className="ribbon-pen__tip" style={{ background: pen.color }} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
  const penMenu = (
    <PenStyleMenu
      activeTool={inkTool}
      inkStyles={props.inkStyles}
      setInkStyle={props.setInkStyle}
      selectTool={props.setTool}
      editable={props.editable}
      selectedInkCount={props.selectedInkCount}
      restyleSelection={props.restyleSelection}
    />
  );

  const home = (
    <div className="ribbon-groups" role="toolbar" aria-label={t("ribbon.home")}>
      <RibbonGroup label={t("ribbon.group.undo")}>
        <RibbonButton label={t("canvas.undo")} icon={Undo2} onClick={props.undo} disabled={!props.editable || !props.canUndo} />
        <RibbonButton label={t("canvas.redo")} icon={Redo2} onClick={props.redo} disabled={!props.editable || !props.canRedo} />
      </RibbonGroup>
      <RibbonGroup label={t("ribbon.group.clipboard")}>
        <RibbonButton label={t("canvas.copy")} icon={Copy} onClick={props.copy} disabled={props.selectedCount === 0} />
        <RibbonButton label={t("canvas.paste")} icon={ClipboardPaste} onClick={props.paste} disabled={!props.editable} />
      </RibbonGroup>
      {VIEWER_APP ? (
        // The Einfügen tab is hidden on the phone; a new text block is the one insert it keeps.
        <RibbonGroup label={t("ribbon.insert")}>
          <RibbonButton label={t("canvas.addText")} icon={Type} onClick={() => props.createText()} disabled={!props.editable} showLabel />
        </RibbonGroup>
      ) : null}
      <RibbonGroup label={t("ribbon.group.text")}>
        {/* The focused text container portals its live formatting controls
            into this slot; without one, a disabled set shows what is there. */}
        <div className="ribbon-format">
          <div ref={onFormatSlotMount} className="ribbon-format__slot" />
          <div className="ribbon-format__idle canvink-rich-text-toolbar-dock" aria-hidden="true" inert>
            <RichTextToolbar view={null} editable={false} idleState={IDLE_TEXT_STATE} />
          </div>
        </div>
      </RibbonGroup>
    </div>
  );

  const insert = (
    <div className="ribbon-groups" role="toolbar" aria-label={t("ribbon.insert")}>
      <RibbonGroup label={t("ribbon.group.text")}>
        <RibbonButton label={t("canvas.addText")} icon={Type} onClick={() => props.createText()} disabled={!props.editable} showLabel />
        <RibbonButton label={t("canvas.addTable")} icon={Table} onClick={props.createTable} disabled={!props.editable} showLabel />
      </RibbonGroup>
      {props.mathFeaturesEnabled ? (
        <RibbonGroup label={t("ribbon.group.math")}>
          {toolButton("math", "canvas.tool.math", Sigma, true)}
          <RibbonButton label={t("canvas.math.addGraph")} icon={ChartLine} onClick={props.createGraph} disabled={!props.editable || !props.canCreateGraph} showLabel />
          <RibbonButton label={t("canvas.math.sidebar")} icon={PanelRightOpen} pressed={props.mathSidebarOpen} onClick={props.toggleMathSidebar} />
          <RibbonButton label={t("canvas.math.convertSelection")} icon={SquareFunction} onClick={props.convertSelectionToMath} disabled={!props.editable || !props.canConvertSelectionToMath} />
        </RibbonGroup>
      ) : null}
    </div>
  );

  const draw = (
    <div className="ribbon-groups" role="toolbar" aria-label={t("canvas.toolbar")}>
      {/* OneNote's Draw tab starts with Undo as well. */}
      <RibbonGroup label={t("ribbon.group.undo")}>
        <RibbonButton label={t("canvas.undo")} icon={Undo2} onClick={props.undo} disabled={!props.editable || !props.canUndo} />
        <RibbonButton label={t("canvas.redo")} icon={Redo2} onClick={props.redo} disabled={!props.editable || !props.canRedo} />
      </RibbonGroup>
      <RibbonGroup label={t("ribbon.group.select")}>
        {toolButton("select", "canvas.tool.select", MousePointer2)}
        {toolButton("lasso", "canvas.tool.lasso", LassoSelect)}
        {toolButton("pan", "canvas.tool.pan", Hand)}
      </RibbonGroup>
      <RibbonGroup label={t("ribbon.group.eraser")}>
        {toolButton("strokeEraser", "canvas.tool.strokeEraser", Eraser)}
        {toolButton("pointEraser", "canvas.tool.pointEraser", CircleDot)}
      </RibbonGroup>
      <RibbonGroup label={t("ribbon.group.pens")}>
        {/* The current pen and highlighter, then ready-made colours. */}
        {toolButton("pen", "canvas.tool.pen", PenTool)}
        {toolButton("highlighter", "canvas.tool.highlighter", Highlighter)}
        {penGallery("ribbon-pens")}
        {/* Widths live in the pen menu next to the gallery, as in OneNote. */}
        {penMenu}
      </RibbonGroup>
      <RibbonGroup label={t("canvas.toolbar.shapes")}>
        {toolButton("line", "canvas.shape.line", Slash)}
        {toolButton("arrow", "canvas.shape.arrow", ArrowRight)}
        {toolButton("rectangle", "canvas.shape.rectangle", RectangleHorizontal)}
        {toolButton("ellipse", "canvas.shape.ellipse", Circle)}
        {toolButton("triangle", "canvas.shape.triangle", Triangle)}
        {toolButton("vector", "canvas.shape.vector", VectorSquare)}
        {toolButton("axes", "canvas.shape.axes", Axis3D)}
      </RibbonGroup>
      <RibbonGroup label={t("ribbon.group.helpers")}>
        <RibbonButton label={t("canvas.ruler")} icon={Ruler} pressed={props.ruler.visible} onClick={() => props.setRulerVisible(!props.ruler.visible)} disabled={!props.editable} />
        <RibbonButton label={t("canvas.snap.grid")} icon={Grid3X3} pressed={props.gridSnap} onClick={() => props.setGridSnap(!props.gridSnap)} disabled={!props.editable} />
        <RibbonButton label={t("canvas.snap.angle")} icon={RotateCw} pressed={props.angleSnap} onClick={() => props.setAngleSnap(!props.angleSnap)} disabled={!props.editable} />
        {props.ruler.visible ? (
          <label className="ribbon-field">
            {t("canvas.ruler.angle")}
            <input
              type="number"
              min={-180}
              max={179}
              step={1}
              value={props.ruler.angleDegrees}
              onChange={(event) => props.setRulerAngle(Number(event.target.value))}
              disabled={!props.editable}
              aria-describedby="canvas-ruler-keyboard-help"
            />
          </label>
        ) : null}
      </RibbonGroup>
      <RibbonGroup label={t("ribbon.group.arrange")}>
        <RibbonButton label={t("canvas.resize")} icon={MoveDiagonal2} onClick={props.resize} disabled={!props.editable || props.selectedCount === 0} />
        <RibbonButton label={t("canvas.rotate")} icon={RotateCw} onClick={props.rotate} disabled={!props.editable || props.selectedCount === 0} />
      </RibbonGroup>
      {props.performanceEvidenceReady ? (
        <RibbonGroup label={t("canvas.exportPerformance")}>
          <RibbonButton label={t("canvas.exportPerformance")} icon={Gauge} onClick={props.exportPerformanceEvidence} />
        </RibbonGroup>
      ) : null}
      <output className="sr-only" aria-live="polite">
        {t("canvas.selectedCount", { count: props.selectedCount })}
      </output>
    </div>
  );

  const view = (
    <div className="ribbon-groups" role="toolbar" aria-label={t("ribbon.view")}>
      <RibbonGroup label={t("canvas.zoom.group")}>
        <RibbonButton label={t("canvas.zoom.out")} icon={Minus} onClick={props.zoomOut} />
        <RibbonButton label={t("canvas.zoom.reset")} onClick={props.resetViewport}>
          <span className="ribbon-zoom">{Math.round(props.viewport.zoom * 100)} %</span>
        </RibbonButton>
        <RibbonButton label={t("canvas.zoom.in")} icon={Plus} onClick={props.zoomIn} />
      </RibbonGroup>
    </div>
  );

  // The floating toolbar of the full page view: the most used drawing tools
  // from the Draw tab, in OneNote's order of its floating ink toolbar.
  const separator = <span className="floating-ink-toolbar__separator" aria-hidden="true" />;
  const floating = (
    <>
      {penGallery("floating-ink-pens")}
      {penMenu}
      {separator}
      {toolButton("strokeEraser", "canvas.tool.strokeEraser", Eraser)}
      {toolButton("pointEraser", "canvas.tool.pointEraser", CircleDot)}
      {toolButton("lasso", "canvas.tool.lasso", LassoSelect)}
      {toolButton("select", "canvas.tool.select", MousePointer2)}
      {toolButton("pan", "canvas.tool.pan", Hand)}
      {separator}
      <RibbonButton label={t("canvas.undo")} icon={Undo2} onClick={props.undo} disabled={!props.editable || !props.canUndo} />
      <RibbonButton label={t("canvas.redo")} icon={Redo2} onClick={props.redo} disabled={!props.editable || !props.canRedo} />
    </>
  );
  const currentTool: InkTool = inkTool ?? "pen";
  const currentColor = props.inkStyles[currentTool].color;
  const CurrentIcon = currentTool === "pen" ? PenTool : Highlighter;
  const floatingCurrent = (
    <>
      <CurrentIcon aria-hidden="true" style={{ color: currentColor }} />
      <span className="floating-ink-toolbar__current-tip" style={{ background: currentColor }} aria-hidden="true" />
    </>
  );

  return (
    <>
      {slots.float ? createPortal(floating, slots.float) : null}
      {slots.floatCurrent ? createPortal(floatingCurrent, slots.floatCurrent) : null}
      {slots.home ? createPortal(home, slots.home) : null}
      {slots.insert ? createPortal(insert, slots.insert) : null}
      {slots.draw ? createPortal(draw, slots.draw) : null}
      {slots.view ? createPortal(view, slots.view) : null}
    </>
  );
}
