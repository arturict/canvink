import type { CSSProperties } from "react";
import type { PageDocV3, PagePaperV1 } from "../domain/v3";
import type { TranslationKey } from "../i18n/catalog";

/**
 * The paper of a page: its size (OneNote's "Papiergrösse") and its rule
 * lines (OneNote's "Ansicht > Linien"). Everything here reads optional page
 * fields with defaults, so pages written before these settings existed look
 * exactly as they did.
 */
export type PageBackground = PageDocV3["background"];
export type RuleStrength = NonNullable<PageBackground["lineStrength"]>;
export type PaperSize = PagePaperV1["size"];

export interface PaperDimensions {
  width: number;
  height: number;
}

/** Portrait sizes in page units (CSS pixels at 96 dpi). */
const PAPER_PORTRAIT: Readonly<Record<PaperSize, PaperDimensions>> = {
  a4: { width: 794, height: 1123 },
  a5: { width: 559, height: 794 },
  letter: { width: 816, height: 1056 },
};

export const DEFAULT_PAPER: PagePaperV1 = { size: "a4", orientation: "portrait" };

export const PAPER_CHOICES: ReadonlyArray<{ paper: PagePaperV1; labelKey: TranslationKey }> = [
  { paper: { size: "a4", orientation: "portrait" }, labelKey: "paper.size.a4Portrait" },
  { paper: { size: "a4", orientation: "landscape" }, labelKey: "paper.size.a4Landscape" },
  { paper: { size: "a5", orientation: "portrait" }, labelKey: "paper.size.a5Portrait" },
  { paper: { size: "a5", orientation: "landscape" }, labelKey: "paper.size.a5Landscape" },
  { paper: { size: "letter", orientation: "portrait" }, labelKey: "paper.size.letterPortrait" },
  { paper: { size: "letter", orientation: "landscape" }, labelKey: "paper.size.letterLandscape" },
];

/** The paper of a fixed-size page; unknown or missing values fall back to A4 portrait. */
export function pagePaper(page: Pick<PageDocV3, "paper">): PagePaperV1 {
  const paper = page.paper;
  const size = paper && paper.size in PAPER_PORTRAIT ? paper.size : DEFAULT_PAPER.size;
  const orientation = paper?.orientation === "landscape" ? "landscape" : "portrait";
  return { size, orientation };
}

export function samePaper(left: PagePaperV1, right: PagePaperV1): boolean {
  return left.size === right.size && left.orientation === right.orientation;
}

/** Sheet size of a fixed-size page, or `null` for a free page that grows with its content. */
export function fixedPaperDimensions(
  page: Pick<PageDocV3, "pageType" | "paper">,
): PaperDimensions | null {
  if (page.pageType !== "a4") return null;
  const paper = pagePaper(page);
  const portrait = PAPER_PORTRAIT[paper.size];
  return paper.orientation === "landscape"
    ? { width: portrait.height, height: portrait.width }
    : { ...portrait };
}

export type RulingKind = "none" | "lines" | "squares" | "millimeter";

export interface RulingPreset {
  id: string;
  type: PageBackground["type"];
  spacing?: number;
  labelKey: TranslationKey;
}

/**
 * OneNote's line and square sizes. "Standard" lines (32) and large squares
 * (40) are the spacings Canvink always used, so existing pages keep them.
 * Small squares are the 5 mm "Häuschen" of Swiss school paper.
 */
export const RULING_PRESETS: Readonly<Record<Exclude<RulingKind, "none" | "millimeter">, readonly RulingPreset[]>> = {
  lines: [
    { id: "lines-narrow", type: "lined", spacing: 24, labelKey: "paper.lines.narrow" },
    { id: "lines-college", type: "lined", spacing: 28, labelKey: "paper.lines.college" },
    { id: "lines-standard", type: "lined", spacing: 32, labelKey: "paper.lines.standard" },
    { id: "lines-wide", type: "lined", spacing: 40, labelKey: "paper.lines.wide" },
  ],
  squares: [
    { id: "squares-small", type: "grid", spacing: 19, labelKey: "paper.squares.small" },
    { id: "squares-medium", type: "grid", spacing: 28, labelKey: "paper.squares.medium" },
    { id: "squares-large", type: "grid", spacing: 40, labelKey: "paper.squares.large" },
    { id: "squares-xlarge", type: "grid", spacing: 76, labelKey: "paper.squares.xlarge" },
  ],
};

const DEFAULT_SPACING: Readonly<Record<PageBackground["type"], number | undefined>> = {
  plain: undefined,
  lined: 32,
  grid: 40,
  millimeter: 10,
};

export const MIN_RULE_SPACING = 8;
export const MAX_RULE_SPACING = 160;

/** Distance between rule lines in page units, or `undefined` for plain paper. */
export function ruleSpacing(background: Pick<PageBackground, "type" | "spacing">): number | undefined {
  const fallback = DEFAULT_SPACING[background.type];
  if (fallback === undefined) return undefined;
  // Millimetre paper has a fixed scale; only lines and squares are sized.
  if (background.type === "millimeter") return fallback;
  const spacing = background.spacing;
  return typeof spacing === "number" && Number.isFinite(spacing)
    ? Math.min(MAX_RULE_SPACING, Math.max(MIN_RULE_SPACING, spacing))
    : fallback;
}

export interface RuleColor {
  color: string;
  labelKey: TranslationKey;
}

export const RULE_COLORS: readonly RuleColor[] = [
  { color: "#3b82f6", labelKey: "paper.color.blue" },
  { color: "#64748b", labelKey: "paper.color.grey" },
  { color: "#16a34a", labelKey: "paper.color.green" },
  { color: "#e11d48", labelKey: "paper.color.red" },
  { color: "#111827", labelKey: "paper.color.black" },
];

export const DEFAULT_RULE_COLOR = RULE_COLORS[0].color;

export const RULE_STRENGTHS: ReadonlyArray<{ strength: RuleStrength; labelKey: TranslationKey }> = [
  { strength: "light", labelKey: "paper.strength.light" },
  { strength: "medium", labelKey: "paper.strength.medium" },
  { strength: "strong", labelKey: "paper.strength.strong" },
];

/** Opacity of the line colour; `light` on blue matches the old fixed line colour. */
const STRENGTH_ALPHA: Readonly<Record<RuleStrength, number>> = {
  light: 0.22,
  medium: 0.42,
  strong: 0.72,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function ruleStrength(background: Pick<PageBackground, "lineStrength">): RuleStrength {
  const strength = background.lineStrength;
  return strength === "medium" || strength === "strong" ? strength : "light";
}

export function ruleBaseColor(background: Pick<PageBackground, "lineColor">): string {
  const color = background.lineColor;
  return typeof color === "string" && HEX_COLOR.test(color) ? color.toLowerCase() : DEFAULT_RULE_COLOR;
}

/** The rule line colour as CSS `rgba()`. */
export function ruleLineColor(background: Pick<PageBackground, "lineColor" | "lineStrength">): string {
  const hex = ruleBaseColor(background);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${STRENGTH_ALPHA[ruleStrength(background)]})`;
}

function hexChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function hexFromChannels(channels: readonly number[]): string {
  return `#${channels.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

/** How far apart two colours look, as the largest channel difference. */
const CLOSE_ENOUGH = 6;

/**
 * Canvink's line settings that draw rule lines in `lineColor` as seen on
 * `paperColor`. OneNote stores the colour its lines are drawn in; Canvink
 * stores a base colour that a strength lays over the paper with some
 * transparency. Taking OneNote's colour as the base drew imported lines at
 * a fifth of their contrast. A palette colour and strength that look the
 * same are used as they are; otherwise the base colour is chosen so that
 * "Mittel" shows the exact colour (or "Kräftig", for colours "Mittel"
 * cannot reach), which leaves room to make the lines fainter or stronger.
 */
export function ruleSettingsForColor(
  lineColor: string,
  paperColor = "#ffffff",
): { lineColor: string; lineStrength: RuleStrength } {
  const target = hexChannels(HEX_COLOR.test(lineColor) ? lineColor.toLowerCase() : DEFAULT_RULE_COLOR);
  const paper = hexChannels(HEX_COLOR.test(paperColor) ? paperColor.toLowerCase() : "#ffffff");
  const shown = (base: readonly number[], alpha: number) => base.map((channel, index) => channel * alpha + paper[index] * (1 - alpha));
  const distance = (left: readonly number[], right: readonly number[]) => Math.max(...left.map((channel, index) => Math.abs(channel - right[index])));
  for (const { color } of RULE_COLORS) {
    for (const { strength } of RULE_STRENGTHS) {
      if (distance(shown(hexChannels(color), STRENGTH_ALPHA[strength]), target) <= CLOSE_ENOUGH) {
        return { lineColor: color, lineStrength: strength };
      }
    }
  }
  for (const strength of ["medium", "strong"] as const) {
    const alpha = STRENGTH_ALPHA[strength];
    const base = target.map((channel, index) => (channel - paper[index] * (1 - alpha)) / alpha);
    if (strength === "strong" || base.every((channel) => channel >= -0.5 && channel <= 255.5)) {
      return { lineColor: hexFromChannels(base), lineStrength: strength };
    }
  }
  return { lineColor: hexFromChannels(target), lineStrength: "strong" };
}

/** Which ruling preset the background shows, for highlighting it in a menu. */
export function activeRulingPreset(background: PageBackground): string {
  if (background.type === "plain") return "none";
  if (background.type === "millimeter") return "millimeter";
  const spacing = ruleSpacing(background);
  const presets = background.type === "lined" ? RULING_PRESETS.lines : RULING_PRESETS.squares;
  return presets.find((preset) => preset.spacing === spacing)?.id ?? "";
}

/**
 * The distance after which the rule pattern repeats on screen, or 0 on plain
 * paper. Millimetre paper repeats after its stronger tenth-line interval.
 */
export function rulePeriod(background: PageBackground, scale: number): number {
  const spacing = ruleSpacing(background);
  if (spacing === undefined) return 0;
  return spacing * scale * (background.type === "millimeter" ? 5 : 1);
}

/**
 * Where the left (or top) edge of a paper layer sits on screen when the
 * page's origin is at `origin`. Once the origin has scrolled off, the layer
 * stays one `period` wider than the view and only shifts within one period,
 * so its pattern lines up with the page and panning never repaints it. While
 * the origin is on screen the paper starts there.
 */
export function paperEdge(origin: number, period: number): number {
  if (origin >= 0 || period <= 0) return Math.max(0, origin);
  return (((origin % period) + period) % period) - period;
}

/**
 * CSS for the rule pattern of an element in screen space. `origin` is where
 * the page's (0, 0) is on that element and `scale` the current zoom. The
 * pattern is drawn unscaled with one-pixel lines, so it stays crisp and
 * visible at every zoom level instead of thinning out with the page transform.
 */
export function rulePatternStyle(
  background: PageBackground,
  scale: number,
  origin: { x: number; y: number },
): CSSProperties {
  const spacing = ruleSpacing(background);
  if (spacing === undefined) return {};
  const step = spacing * scale;
  const color = ruleLineColor(background);
  const line = `${color} 1px, transparent 1px`;
  const position = `${origin.x}px ${origin.y}px`;
  if (background.type === "lined") {
    return {
      backgroundImage: `linear-gradient(to bottom, ${line})`,
      backgroundSize: `100% ${step}px`,
      backgroundPosition: position,
    };
  }
  if (background.type === "millimeter") {
    // Every tenth millimetre line is drawn stronger, as on real graph paper.
    const major = ruleLineColor({ ...background, lineStrength: ruleStrength(background) === "light" ? "medium" : "strong" });
    const majorLine = `${major} 1px, transparent 1px`;
    return {
      backgroundImage: [
        `linear-gradient(to right, ${majorLine})`,
        `linear-gradient(to bottom, ${majorLine})`,
        `linear-gradient(to right, ${line})`,
        `linear-gradient(to bottom, ${line})`,
      ].join(", "),
      backgroundSize: `${step * 5}px ${step * 5}px, ${step * 5}px ${step * 5}px, ${step}px ${step}px, ${step}px ${step}px`,
      backgroundPosition: `${position}, ${position}, ${position}, ${position}`,
    };
  }
  return {
    backgroundImage: `linear-gradient(to right, ${line}), linear-gradient(to bottom, ${line})`,
    backgroundSize: `${step}px ${step}px`,
    backgroundPosition: `${position}, ${position}`,
  };
}
