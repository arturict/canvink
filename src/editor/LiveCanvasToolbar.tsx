import {
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Axis3D,
  ChartLine,
  ChevronDown,
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
  MoreHorizontal,
  MousePointer2,
  MoveDiagonal2,
  PanelRightOpen,
  PenTool,
  Plus,
  Redo2,
  RectangleHorizontal,
  RotateCw,
  Ruler,
  Shapes,
  Sigma,
  Slash,
  SquareFunction,
  Triangle,
  Type,
  Undo2,
  VectorSquare,
  type LucideIcon,
} from "lucide-react";
import {
  useI18n,
  type TranslationKey,
} from "../i18n";
import {
  INK_SWATCHES,
  INK_WIDTH_LABELS,
  INK_WIDTHS,
  type InkStyle,
  type InkTool,
} from "./penStyles";
import type {
  CanvasRulerState,
  CanvasViewport,
  LiveCanvasTool,
  LivePenPreset,
} from "./LiveCanvasEditor";

export interface ToolbarProps {
  tool: LiveCanvasTool;
  setTool: (tool: LiveCanvasTool) => void;
  presets: readonly LivePenPreset[];
  presetId: string;
  setPresetId: (id: string) => void;
  inkStyles: Record<InkTool, InkStyle>;
  setInkStyle: (tool: InkTool, update: Partial<InkStyle>) => void;
  onFormatSlotMount: (element: HTMLDivElement | null) => void;
  gridSnap: boolean;
  setGridSnap: (value: boolean) => void;
  angleSnap: boolean;
  setAngleSnap: (value: boolean) => void;
  ruler: CanvasRulerState;
  setRulerVisible: (value: boolean) => void;
  setRulerAngle: (value: number) => void;
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  copy: () => Promise<void>;
  paste: () => Promise<void>;
  createText: () => void;
  createTable: () => void;
  createGraph: () => void;
  canCreateGraph: boolean;
  convertSelectionToMath: () => void;
  canConvertSelectionToMath: boolean;
  resize: () => void;
  rotate: () => void;
  viewport: CanvasViewport;
  zoomOut: () => void;
  zoomIn: () => void;
  resetViewport: () => void;
  exportPerformanceEvidence: () => void;
  performanceEvidenceReady: boolean;
  editable: boolean;
  mathSidebarOpen: boolean;
  mathFeaturesEnabled: boolean;
  toggleMathSidebar: () => void;
}

export function LiveCanvasToolbar(props: ToolbarProps) {
  const { t } = useI18n();
  const { onFormatSlotMount } = props;
  const quickTools: Array<[LiveCanvasTool, TranslationKey, LucideIcon]> = [
    ["select", "canvas.tool.select", MousePointer2],
    ["pen", "canvas.tool.pen", PenTool],
    ["highlighter", "canvas.tool.highlighter", Highlighter],
    ["strokeEraser", "canvas.tool.strokeEraser", Eraser],
  ];
  const inkTool: InkTool | null =
    props.tool === "pen" || props.tool === "highlighter" ? props.tool : null;
  const shapes: Array<[LiveCanvasTool, TranslationKey, LucideIcon]> = [
    ["line", "canvas.shape.line", Slash],
    ["arrow", "canvas.shape.arrow", ArrowRight],
    ["vector", "canvas.shape.vector", VectorSquare],
    ["rectangle", "canvas.shape.rectangle", RectangleHorizontal],
    ["ellipse", "canvas.shape.ellipse", Circle],
    ["triangle", "canvas.shape.triangle", Triangle],
    ["axes", "canvas.shape.axes", Axis3D],
  ];
  const menuTools: Array<[LiveCanvasTool, TranslationKey, LucideIcon]> = [
    ["pan", "canvas.tool.pan", Hand],
    ["lasso", "canvas.tool.lasso", LassoSelect],
    ["strokeEraser", "canvas.tool.strokeEraser", Eraser],
    ["pointEraser", "canvas.tool.pointEraser", CircleDot],
    ...shapes,
  ];
  const activeMenuTool = menuTools.find(([value]) => props.tool === value);
  return (
    <div
      className="live-canvas-toolbar editor-toolbar__scroll"
      role="toolbar"
      aria-label={t("canvas.toolbar")}
    >
      <ToolbarIconButton
        label={t("canvas.undo")}
        icon={Undo2}
        onClick={props.undo}
        disabled={!props.editable || !props.canUndo}
      />
      <ToolbarIconButton
        label={t("canvas.redo")}
        icon={Redo2}
        onClick={props.redo}
        disabled={!props.editable || !props.canRedo}
      />
      <span className="live-canvas-toolbar__separator" aria-hidden="true" />
      {quickTools.map(([value, labelKey, icon]) => (
        <ToolbarIconButton
          key={value}
          label={t(labelKey)}
          icon={icon}
          pressed={props.tool === value}
          onClick={() => props.setTool(value)}
          disabled={!props.editable && value !== "select" && value !== "pan"}
        />
      ))}
      {inkTool ? (
        <div className="live-canvas-toolbar__ink" role="group" aria-label={t(inkTool === "pen" ? "canvas.tool.pen" : "canvas.tool.highlighter")}>
          <div className="live-canvas-toolbar__swatches" role="radiogroup" aria-label={t("canvas.ink.colors")}>
            {INK_SWATCHES[inkTool].map((swatch) => (
              <button
                key={swatch.color}
                type="button"
                role="radio"
                aria-checked={props.inkStyles[inkTool].color === swatch.color}
                aria-label={t(swatch.labelKey)}
                title={t(swatch.labelKey)}
                className="live-canvas-toolbar__swatch"
                style={{ backgroundColor: swatch.color }}
                disabled={!props.editable}
                onClick={() => props.setInkStyle(inkTool, { color: swatch.color })}
              />
            ))}
          </div>
          <div className="live-canvas-toolbar__widths" role="radiogroup" aria-label={t("canvas.ink.widths")}>
            {INK_WIDTHS[inkTool].map((width, index) => (
              <button
                key={width}
                type="button"
                role="radio"
                aria-checked={props.inkStyles[inkTool].size === width}
                aria-label={t(INK_WIDTH_LABELS[index])}
                title={t(INK_WIDTH_LABELS[index])}
                className="live-canvas-toolbar__width"
                disabled={!props.editable}
                onClick={() => props.setInkStyle(inkTool, { size: width })}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 4 + index * 4,
                    height: 4 + index * 4,
                    background: props.inkStyles[inkTool].color,
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <span className="live-canvas-toolbar__separator" aria-hidden="true" />
      <ToolbarMenu label={t("canvas.toolbar.insert")} icon={Type}>
        <ToolbarMenuAction
          label={t("canvas.addText")}
          icon={Type}
          onClick={() => props.createText()}
          disabled={!props.editable}
        />
        {props.mathFeaturesEnabled ? <>
          <ToolbarMenuAction
            label={t("canvas.tool.math")}
            icon={Sigma}
            pressed={props.tool === "math"}
            onClick={() => props.setTool("math")}
            disabled={!props.editable}
          />
          <ToolbarMenuAction
            label={t("canvas.math.addGraph")}
            icon={ChartLine}
            onClick={props.createGraph}
            disabled={!props.editable || !props.canCreateGraph}
          />
          <ToolbarMenuAction
            label={t("canvas.math.convertSelection")}
            icon={SquareFunction}
            onClick={props.convertSelectionToMath}
            disabled={!props.editable || !props.canConvertSelectionToMath}
          />
          <ToolbarMenuAction
            label={t("canvas.math.sidebar")}
            icon={PanelRightOpen}
            pressed={props.mathSidebarOpen}
            onClick={props.toggleMathSidebar}
          />
        </> : null}
      </ToolbarMenu>
      <ToolbarMenu
        label={t("canvas.toolbar.tools")}
        icon={activeMenuTool?.[2] ?? Shapes}
        activeLabel={activeMenuTool ? t(activeMenuTool[1]) : undefined}
        variant="tools"
      >
        <div
          className="live-canvas-toolbar__menu-group"
          role="group"
          aria-label={t("canvas.toolbar.drawing")}
        >
          <span className="live-canvas-toolbar__section-label" aria-hidden="true">
            {t("canvas.toolbar.drawing")}
          </span>
          <div className="live-canvas-toolbar__menu-items">
            <ToolbarMenuAction
              label={t("canvas.tool.pan")}
              icon={Hand}
              pressed={props.tool === "pan"}
              onClick={() => props.setTool("pan")}
            />
            <ToolbarMenuAction
              label={t("canvas.tool.lasso")}
              icon={LassoSelect}
              pressed={props.tool === "lasso"}
              onClick={() => props.setTool("lasso")}
              disabled={!props.editable}
            />
            <label className="live-canvas-toolbar__field">
              {t("canvas.penProfile")}
              <select
                value={props.presetId}
                onChange={(event) => {
                  props.setPresetId(event.target.value);
                  closeToolbarMenu(event);
                }}
                disabled={!props.editable}
              >
                {props.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.id === "school-pen"
                      ? t("canvas.preset.pen")
                      : preset.id === "school-highlighter"
                        ? t("canvas.preset.highlighter")
                        : preset.label}
                  </option>
                ))}
              </select>
            </label>
            <ToolbarMenuAction
              label={t("canvas.tool.strokeEraser")}
              icon={Eraser}
              pressed={props.tool === "strokeEraser"}
              onClick={() => props.setTool("strokeEraser")}
              disabled={!props.editable}
            />
            <ToolbarMenuAction
              label={t("canvas.tool.pointEraser")}
              icon={CircleDot}
              pressed={props.tool === "pointEraser"}
              onClick={() => props.setTool("pointEraser")}
              disabled={!props.editable}
            />
          </div>
        </div>
        <div
          className="live-canvas-toolbar__menu-group"
          role="group"
          aria-label={t("canvas.toolbar.view")}
        >
          <span className="live-canvas-toolbar__section-label" aria-hidden="true">
            {t("canvas.toolbar.view")}
          </span>
          <div className="live-canvas-toolbar__menu-items">
            <ToolbarMenuAction
              label={t("canvas.snap.grid")}
              icon={Grid3X3}
              pressed={props.gridSnap}
              onClick={() => props.setGridSnap(!props.gridSnap)}
              disabled={!props.editable}
              closeMenu={false}
            />
            <ToolbarMenuAction
              label={t("canvas.snap.angle")}
              icon={RotateCw}
              pressed={props.angleSnap}
              onClick={() => props.setAngleSnap(!props.angleSnap)}
              disabled={!props.editable}
              closeMenu={false}
            />
            <ToolbarMenuAction
              label={t("canvas.ruler")}
              icon={Ruler}
              pressed={props.ruler.visible}
              onClick={() => props.setRulerVisible(!props.ruler.visible)}
              disabled={!props.editable}
              closeMenu={false}
            />
            {props.ruler.visible ? (
              <label className="live-canvas-toolbar__field live-canvas-toolbar__ruler-angle">
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
            <span
              className="live-canvas-toolbar__zoom"
              role="group"
              aria-label={t("canvas.zoom.group")}
            >
              <ToolbarMenuAction
                label={t("canvas.zoom.out")}
                icon={Minus}
                onClick={props.zoomOut}
                iconOnly
                closeMenu={false}
              />
              <ToolbarMenuAction
                label={t("canvas.zoom.reset")}
                onClick={props.resetViewport}
                closeMenu={false}
              >
                {Math.round(props.viewport.zoom * 100)} %
              </ToolbarMenuAction>
              <ToolbarMenuAction
                label={t("canvas.zoom.in")}
                icon={Plus}
                onClick={props.zoomIn}
                iconOnly
                closeMenu={false}
              />
            </span>
          </div>
        </div>
        <div
          className="live-canvas-toolbar__menu-group live-canvas-toolbar__menu-group--shapes"
          role="group"
          aria-label={t("canvas.toolbar.shapes")}
        >
          <span className="live-canvas-toolbar__section-label" aria-hidden="true">
            {t("canvas.toolbar.shapes")}
          </span>
          <div className="live-canvas-toolbar__menu-items live-canvas-toolbar__menu-items--shapes">
            {shapes.map(([value, labelKey, icon]) => (
              <ToolbarMenuAction
                key={value}
                label={t(labelKey)}
                icon={icon}
                pressed={props.tool === value}
                onClick={() => props.setTool(value)}
                disabled={!props.editable}
              />
            ))}
          </div>
        </div>
      </ToolbarMenu>
      <ToolbarMenu label={t("canvas.toolbar.more")} icon={MoreHorizontal} align="end">
        <ToolbarMenuAction
          label={t("canvas.copy")}
          icon={Copy}
          onClick={props.copy}
          disabled={props.selectedCount === 0}
        />
        <ToolbarMenuAction
          label={t("canvas.paste")}
          icon={ClipboardPaste}
          onClick={props.paste}
          disabled={!props.editable}
        />
        <ToolbarMenuAction
          label={t("canvas.resize")}
          icon={MoveDiagonal2}
          onClick={props.resize}
          disabled={!props.editable || props.selectedCount === 0}
        />
        <ToolbarMenuAction
          label={t("canvas.rotate")}
          icon={RotateCw}
          onClick={props.rotate}
          disabled={!props.editable || props.selectedCount === 0}
        />
        {props.performanceEvidenceReady ? (
          <ToolbarMenuAction
            label={t("canvas.exportPerformance")}
            icon={Gauge}
            onClick={props.exportPerformanceEvidence}
          />
        ) : null}
      </ToolbarMenu>
      {/* The focused text container portals its formatting controls here. */}
      <div ref={onFormatSlotMount} className="live-canvas-toolbar__format-slot" />
      <output className="sr-only" aria-live="polite">
        {t("canvas.selectedCount", { count: props.selectedCount })}
      </output>
    </div>
  );
}

function ToolbarIconButton({
  label,
  icon: Icon,
  pressed,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="live-canvas-toolbar__icon-button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function ToolbarMenu({
  label,
  icon: Icon,
  align = "start",
  variant = "default",
  activeLabel,
  children,
}: {
  label: string;
  icon: LucideIcon;
  align?: "start" | "end";
  variant?: "default" | "tools";
  activeLabel?: string;
  children: ReactNode;
}) {
  return (
    <details
      className={`live-canvas-toolbar__menu live-canvas-toolbar__menu--${align}`}
      name="live-canvas-toolbar-menu"
      data-active={activeLabel ? "true" : undefined}
    >
      <summary
        aria-label={activeLabel ? `${label}: ${activeLabel}` : label}
        title={activeLabel ?? label}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown className="live-canvas-toolbar__chevron" aria-hidden="true" />
      </summary>
      <div
        className={`live-canvas-toolbar__popover live-canvas-toolbar__popover--${variant}`}
      >
        {children}
      </div>
    </details>
  );
}

function ToolbarMenuAction({
  label,
  icon: Icon,
  pressed,
  disabled = false,
  title,
  iconOnly = false,
  closeMenu = true,
  onClick,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
  iconOnly?: boolean;
  closeMenu?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={iconOnly ? "live-canvas-toolbar__menu-icon" : undefined}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={(event) => {
        const menu = event.currentTarget.closest("details");
        void Promise.resolve(onClick()).finally(() => {
          if (closeMenu) menu?.removeAttribute("open");
        });
      }}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {iconOnly ? null : children ?? label}
    </button>
  );
}

function closeToolbarMenu(event: { currentTarget: EventTarget & HTMLElement }): void {
  event.currentTarget.closest("details")?.removeAttribute("open");
}
