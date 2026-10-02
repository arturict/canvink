import { useEffect, useRef, useState } from "react";
import { Highlighter, Palette, PenTool } from "lucide-react";
import { useI18n } from "../i18n";
import {
  INK_PALETTE,
  INK_SIZE_RANGE,
  INK_WIDTH_LABELS,
  INK_WIDTHS,
  inkWidthMillimeters,
  isInkColor,
  type InkStyle,
  type InkTool,
} from "./penStyles";
import { PenButtonSettings } from "./PenButtonSettings";
import { RibbonPopover } from "./RibbonPopover";
import { formatLocale } from '../i18n/core';
import "./PenStyleMenu.css";

/**
 * The pen menu of OneNote's Draw tab: a colour palette with a custom colour
 * and a free thickness for the pen and the highlighter. The choice is kept
 * across sessions (penStyles). With ink selected, the same choice also
 * restyles the selection ("Auswahl anpassen").
 */
export function PenStyleMenu({
  activeTool,
  inkStyles,
  setInkStyle,
  selectTool,
  editable,
  selectedInkCount,
  restyleSelection,
}: {
  activeTool: InkTool | null;
  inkStyles: Record<InkTool, InkStyle>;
  setInkStyle: (tool: InkTool, update: Partial<InkStyle>) => void;
  selectTool: (tool: InkTool) => void;
  editable: boolean;
  selectedInkCount: number;
  restyleSelection: (update: Partial<InkStyle>) => void;
}) {
  const { t, language } = useI18n();
  const shownTool = activeTool ?? "pen";
  const current = inkStyles[shownTool];
  return (
    <RibbonPopover
      label={t("canvas.pen.customize")}
      disabled={!editable}
      className="pen-style-menu__button"
      panelClassName="pen-style-menu"
      buttonContent={(
        <>
          <Palette aria-hidden="true" />
          <span className="pen-style-menu__current" style={{ background: current.color }} aria-hidden="true" />
        </>
      )}
    >
      <PenStylePanel
        initialTool={shownTool}
        inkStyles={inkStyles}
        setInkStyle={setInkStyle}
        selectTool={selectTool}
        selectedInkCount={selectedInkCount}
        restyleSelection={restyleSelection}
        formatNumber={(value) => value.toLocaleString(formatLocale(language))}
        t={t}
      />
    </RibbonPopover>
  );
}

function PenStylePanel({
  initialTool,
  inkStyles,
  setInkStyle,
  selectTool,
  selectedInkCount,
  restyleSelection,
  formatNumber,
  t,
}: {
  initialTool: InkTool;
  inkStyles: Record<InkTool, InkStyle>;
  setInkStyle: (tool: InkTool, update: Partial<InkStyle>) => void;
  selectTool: (tool: InkTool) => void;
  selectedInkCount: number;
  restyleSelection: (update: Partial<InkStyle>) => void;
  formatNumber: (value: number) => string;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [tool, setTool] = useState<InkTool>(initialTool);
  const style = inkStyles[tool];
  const range = INK_SIZE_RANGE[tool];
  const colorInput = useRef<HTMLInputElement>(null);
  const choose = (update: Partial<InkStyle>, restyle = true) => {
    setInkStyle(tool, update);
    selectTool(tool);
    if (restyle && selectedInkCount > 0) restyleSelection(update);
  };
  // The native colour picker reports every intermediate colour as "input";
  // the selection is restyled once, on the final "change".
  const chooseRef = useRef(choose);
  useEffect(() => {
    chooseRef.current = choose;
  });
  useEffect(() => {
    const input = colorInput.current;
    if (!input) return;
    const onChange = () => {
      if (isInkColor(input.value)) chooseRef.current({ color: input.value.toLowerCase() });
    };
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, []);
  const commitSize = (value: number) => {
    if (selectedInkCount > 0) restyleSelection({ size: value });
  };
  const inPalette = INK_PALETTE[tool].some((swatch) => swatch.color === style.color);

  return (
    <div className="pen-style-menu__body">
      <div className="pen-style-menu__tools" role="group" aria-label={t("ribbon.group.pens")}>
        {(["pen", "highlighter"] as const).map((candidate) => {
          const Icon = candidate === "pen" ? PenTool : Highlighter;
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={tool === candidate}
              onClick={() => {
                setTool(candidate);
                selectTool(candidate);
              }}
            >
              <Icon aria-hidden="true" />
              {t(candidate === "pen" ? "canvas.tool.pen" : "canvas.tool.highlighter")}
            </button>
          );
        })}
      </div>
      <svg className="pen-style-menu__preview" viewBox="0 0 240 44" role="img" aria-label={t("canvas.pen.preview")}>
        <path
          d="M 14 30 C 50 4, 80 4, 110 22 S 170 42, 226 14"
          fill="none"
          stroke={style.color}
          strokeWidth={Math.max(1, style.size)}
          strokeLinecap="round"
          strokeOpacity={tool === "highlighter" ? 0.45 : 1}
        />
      </svg>
      <p className="ribbon-popover__heading">{t("canvas.ink.colors")}</p>
      <div className="pen-style-menu__palette" role="group" aria-label={t("canvas.ink.colors")}>
        {INK_PALETTE[tool].map((swatch) => (
          <button
            key={swatch.color}
            type="button"
            className="pen-style-menu__swatch"
            aria-label={t(swatch.labelKey)}
            title={t(swatch.labelKey)}
            aria-pressed={style.color === swatch.color}
            style={{ background: swatch.color }}
            onClick={() => choose({ color: swatch.color })}
          />
        ))}
        <label
          className="pen-style-menu__custom"
          title={t("canvas.pen.customColor")}
          data-active={inPalette ? undefined : "true"}
        >
          <input
            ref={colorInput}
            type="color"
            aria-label={t("canvas.pen.customColor")}
            value={style.color}
            onChange={(event) => {
              // Live preview for new ink; the selection follows on "change".
              if (isInkColor(event.target.value)) setInkStyle(tool, { color: event.target.value.toLowerCase() });
            }}
          />
          <span>{t("canvas.pen.customColor")}</span>
        </label>
      </div>
      <p className="ribbon-popover__heading">{t("canvas.pen.thickness")}</p>
      <div className="pen-style-menu__size">
        <input
          type="range"
          aria-label={t("canvas.pen.thickness")}
          aria-valuetext={t("canvas.pen.thicknessValue", { value: formatNumber(inkWidthMillimeters(style.size)) })}
          min={range.min}
          max={range.max}
          step={range.step}
          value={style.size}
          onChange={(event) => choose({ size: Number(event.target.value) }, false)}
          onPointerUp={(event) => commitSize(Number(event.currentTarget.value))}
          onKeyUp={(event) => commitSize(Number(event.currentTarget.value))}
        />
        <output>{t("canvas.pen.thicknessValue", { value: formatNumber(inkWidthMillimeters(style.size)) })}</output>
      </div>
      <div className="pen-style-menu__presets" role="group" aria-label={t("canvas.ink.widths")}>
        {INK_WIDTHS[tool].map((size, index) => (
          <button
            key={size}
            type="button"
            aria-pressed={style.size === size}
            onClick={() => choose({ size })}
          >
            <span aria-hidden="true" style={{ width: 4 + index * 4, height: 4 + index * 4 }} />
            {t(INK_WIDTH_LABELS[index])}
          </button>
        ))}
      </div>
      <PenButtonSettings />
      {selectedInkCount > 0 ? (
        <p className="pen-style-menu__selection" role="note">
          <strong>{t("canvas.pen.selection")}</strong>
          <span>{t("canvas.pen.selectionHint")}</span>
        </p>
      ) : null}
    </div>
  );
}
