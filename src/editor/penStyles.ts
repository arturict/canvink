import type { TranslationKey } from "../i18n/catalog";

/**
 * Pen and highlighter choices, modelled on OneNote's Draw tab: a gallery of
 * ready pens with three widths, and per pen a menu with a colour palette, a
 * custom colour and a free thickness. The last choice is remembered per tool.
 */
export type InkTool = "pen" | "highlighter";

export interface InkSwatch {
  color: string;
  labelKey: TranslationKey;
}

export interface InkStyle {
  color: string;
  size: number;
}

export const INK_SWATCHES: Readonly<Record<InkTool, readonly InkSwatch[]>> = {
  pen: [
    { color: "#1f2937", labelKey: "canvas.ink.color.black" },
    { color: "#1d4ed8", labelKey: "canvas.ink.color.blue" },
    { color: "#dc2626", labelKey: "canvas.ink.color.red" },
    { color: "#15803d", labelKey: "canvas.ink.color.green" },
    { color: "#7c3aed", labelKey: "canvas.ink.color.purple" },
    { color: "#ea580c", labelKey: "canvas.ink.color.orange" },
  ],
  highlighter: [
    { color: "#facc15", labelKey: "canvas.ink.color.yellow" },
    { color: "#4ade80", labelKey: "canvas.ink.color.green" },
    { color: "#38bdf8", labelKey: "canvas.ink.color.blue" },
    { color: "#f472b6", labelKey: "canvas.ink.color.pink" },
    { color: "#fb923c", labelKey: "canvas.ink.color.orange" },
  ],
};

/** The colour palette of the pen menu, as in OneNote's pen colour grid. */
export const INK_PALETTE: Readonly<Record<InkTool, readonly InkSwatch[]>> = {
  pen: [
    { color: "#1f2937", labelKey: "canvas.ink.color.black" },
    { color: "#6b7280", labelKey: "canvas.ink.color.grey" },
    { color: "#ffffff", labelKey: "canvas.ink.color.white" },
    { color: "#1d4ed8", labelKey: "canvas.ink.color.blue" },
    { color: "#0ea5e9", labelKey: "canvas.ink.color.lightBlue" },
    { color: "#0f766e", labelKey: "canvas.ink.color.teal" },
    { color: "#15803d", labelKey: "canvas.ink.color.green" },
    { color: "#65a30d", labelKey: "canvas.ink.color.lime" },
    { color: "#ca8a04", labelKey: "canvas.ink.color.darkYellow" },
    { color: "#ea580c", labelKey: "canvas.ink.color.orange" },
    { color: "#dc2626", labelKey: "canvas.ink.color.red" },
    { color: "#db2777", labelKey: "canvas.ink.color.pink" },
    { color: "#7c3aed", labelKey: "canvas.ink.color.purple" },
    { color: "#92400e", labelKey: "canvas.ink.color.brown" },
  ],
  highlighter: [
    { color: "#facc15", labelKey: "canvas.ink.color.yellow" },
    { color: "#4ade80", labelKey: "canvas.ink.color.green" },
    { color: "#2dd4bf", labelKey: "canvas.ink.color.turquoise" },
    { color: "#38bdf8", labelKey: "canvas.ink.color.blue" },
    { color: "#c084fc", labelKey: "canvas.ink.color.purple" },
    { color: "#f472b6", labelKey: "canvas.ink.color.pink" },
    { color: "#f87171", labelKey: "canvas.ink.color.red" },
    { color: "#fb923c", labelKey: "canvas.ink.color.orange" },
    { color: "#d1d5db", labelKey: "canvas.ink.color.grey" },
  ],
};

/** Thickness range of the pen menu's slider, in page units. */
export const INK_SIZE_RANGE: Readonly<Record<InkTool, { min: number; max: number; step: number }>> = {
  pen: { min: 0.5, max: 24, step: 0.5 },
  highlighter: { min: 4, max: 48, step: 1 },
};

/** A stroke width in millimetres on paper (page units are CSS pixels at 96 dpi). */
export function inkWidthMillimeters(size: number): number {
  return Math.round((size * 25.4) / 96 * 100) / 100;
}

export function clampInkSize(tool: InkTool, size: number): number {
  const { min, max } = INK_SIZE_RANGE[tool];
  return Math.min(max, Math.max(min, size));
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isInkColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export const INK_WIDTHS: Readonly<Record<InkTool, readonly number[]>> = {
  pen: [2, 3, 6],
  highlighter: [10, 14, 22],
};

export const INK_WIDTH_LABELS: readonly TranslationKey[] = [
  "canvas.ink.width.fine",
  "canvas.ink.width.medium",
  "canvas.ink.width.thick",
];

const STORAGE_KEY = "canvink:ink-styles:v1";

export function defaultInkStyles(): Record<InkTool, InkStyle> {
  return {
    pen: { color: "#1d4ed8", size: 3 },
    highlighter: { color: "#facc15", size: 14 },
  };
}

function validStyle(tool: InkTool, value: unknown): InkStyle | null {
  if (!value || typeof value !== "object") return null;
  const { color, size } = value as Partial<InkStyle>;
  if (!isInkColor(color)) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || clampInkSize(tool, size) !== size) return null;
  return { color: color.toLowerCase(), size };
}

/** Reads the last used pen styles; anything unknown falls back to the defaults. */
export function loadInkStyles(storage: Pick<Storage, "getItem"> | null): Record<InkTool, InkStyle> {
  const defaults = defaultInkStyles();
  if (!storage) return defaults;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (!parsed) return defaults;
    return {
      pen: validStyle("pen", parsed.pen) ?? defaults.pen,
      highlighter: validStyle("highlighter", parsed.highlighter) ?? defaults.highlighter,
    };
  } catch {
    return defaults;
  }
}

export function saveInkStyles(
  storage: Pick<Storage, "setItem"> | null,
  styles: Record<InkTool, InkStyle>,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(styles));
  } catch {
    // A full or blocked storage only loses the remembered pen choice.
  }
}
