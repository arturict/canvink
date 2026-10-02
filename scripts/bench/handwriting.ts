/**
 * Synthetic handwriting for seeded pages: text written with a small
 * single-stroke cursive alphabet, the way a pen leaves it on a page.
 *
 * Glyphs live in a unit box (baseline 0, x-height 1, ascenders up to about 2.2,
 * descenders down to about -1.2, y pointing up). Lower-case letters join into
 * one stroke per word like joined-up school writing; capitals, digits and
 * symbols are separate strokes, and i dots and t bars follow after the word.
 * Every glyph is jittered a little, words drift off the baseline and the pen
 * pressure varies, so no two words look stamped.
 */

export type Unit = readonly [number, number];

interface Glyph {
  /** Advance width. */
  w: number;
  /** The joined part of a lower-case letter, entered from the previous letter. */
  join?: readonly Unit[];
  /** Separate strokes: capitals, digits, symbols. */
  solo?: ReadonlyArray<readonly Unit[]>;
  /** Strokes added after the word: dots, bars. */
  marks?: ReadonlyArray<readonly Unit[]>;
}

const ascender = (x: number): Unit[] => [[x, 0.25], [x + 0.25, 1], [x + 0.38, 1.8], [x + 0.32, 2.15], [x + 0.18, 2], [x + 0.12, 1.2]];
const bowl = (x: number): Unit[] => [[x + 0.68, 0.75], [x + 0.48, 0.98], [x + 0.2, 0.85], [x + 0.05, 0.45], [x + 0.16, 0.06], [x + 0.4, 0.03], [x + 0.6, 0.32]];
const dot = (x: number, y: number): Unit[] => [[x, y], [x + 0.04, y + 0.05]];

const LOWER: Record<string, Glyph> = {
  a: { w: 0.85, join: [...bowl(0), [0.72, 0.85], [0.74, 1], [0.66, 0.35], [0.7, 0.04], [0.85, 0.12]] },
  b: { w: 0.75, join: [...ascender(0), [0.1, 0.1], [0.3, 0], [0.5, 0.3], [0.5, 0.75], [0.32, 0.88], [0.4, 0.78], [0.75, 0.82]] },
  c: { w: 0.65, join: [[0.55, 0.85], [0.4, 1], [0.15, 0.85], [0.03, 0.45], [0.15, 0.06], [0.4, 0], [0.65, 0.16]] },
  d: { w: 0.9, join: [...bowl(0), [0.72, 1], [0.78, 2.1], [0.74, 1.4], [0.7, 0.4], [0.74, 0.04], [0.9, 0.12]] },
  e: { w: 0.6, join: [[0.02, 0.3], [0.35, 0.5], [0.48, 0.75], [0.38, 0.97], [0.15, 0.85], [0.07, 0.45], [0.2, 0.06], [0.42, 0], [0.62, 0.15]] },
  f: { w: 0.55, join: [[0, 0.25], [0.3, 1], [0.45, 1.8], [0.4, 2.15], [0.22, 2.05], [0.18, 1.4], [0.18, 0.3], [0.14, -0.6], [0.08, -1.05], [0, -0.85], [0.1, -0.4], [0.35, 0], [0.55, 0.2]] },
  g: { w: 0.8, join: [...bowl(0), [0.7, 1], [0.66, 0.1], [0.58, -0.7], [0.4, -1.1], [0.18, -1], [0.22, -0.55], [0.5, -0.15], [0.8, 0.15]] },
  h: { w: 0.85, join: [...ascender(0), [0.08, 0], [0.14, 0.5], [0.32, 0.9], [0.52, 0.92], [0.58, 0.55], [0.58, 0.12], [0.66, 0], [0.85, 0.12]] },
  i: { w: 0.38, join: [[0, 0.25], [0.15, 0.7], [0.2, 1], [0.16, 0.35], [0.2, 0.03], [0.38, 0.12]], marks: [dot(0.26, 1.42)] },
  j: { w: 0.42, join: [[0, 0.25], [0.15, 0.7], [0.22, 1], [0.2, 0], [0.15, -0.75], [0.02, -1.1], [-0.1, -0.95], [0.05, -0.45], [0.42, 0.12]], marks: [dot(0.28, 1.42)] },
  k: { w: 0.8, join: [...ascender(0), [0.08, 0], [0.14, 0.45], [0.38, 0.9], [0.55, 0.85], [0.45, 0.55], [0.18, 0.45], [0.42, 0.38], [0.55, 0.05], [0.8, 0.12]] },
  l: { w: 0.42, join: [...ascender(0), [0.12, 0.25], [0.22, 0], [0.42, 0.12]] },
  m: { w: 1.2, join: [[0, 0.2], [0.08, 0.6], [0.12, 0.95], [0.1, 0], [0.16, 0.55], [0.32, 0.95], [0.46, 0.88], [0.48, 0], [0.54, 0.55], [0.7, 0.95], [0.84, 0.88], [0.86, 0.15], [0.95, 0], [1.15, 0.12]] },
  n: { w: 0.85, join: [[0, 0.2], [0.08, 0.6], [0.12, 0.95], [0.1, 0], [0.16, 0.55], [0.34, 0.95], [0.5, 0.88], [0.52, 0.15], [0.6, 0], [0.8, 0.12]] },
  o: { w: 0.72, join: [[0.42, 0.97], [0.15, 0.85], [0.04, 0.45], [0.18, 0.05], [0.42, 0.02], [0.56, 0.4], [0.52, 0.85], [0.42, 0.97], [0.52, 0.8], [0.72, 0.85]] },
  p: { w: 0.82, join: [[0, 0.2], [0.1, 0.65], [0.14, 0.95], [0.12, 0], [0.08, -1.1], [0.1, -0.2], [0.14, 0.5], [0.36, 0.95], [0.58, 0.8], [0.6, 0.3], [0.4, 0.02], [0.18, 0.08], [0.45, 0.05], [0.82, 0.15]] },
  q: { w: 0.82, join: [...bowl(0), [0.7, 1], [0.66, 0], [0.64, -1.1], [0.7, -0.3], [0.82, 0.1]] },
  // Exits at the top like a school-script r, so it never reads as an n.
  r: { w: 0.58, join: [[0, 0.2], [0.12, 0.75], [0.14, 1], [0.1, 0], [0.16, 0.55], [0.3, 0.9], [0.48, 0.97], [0.58, 0.88]] },
  s: { w: 0.58, join: [[0, 0.2], [0.28, 0.95], [0.22, 0.7], [0.42, 0.45], [0.42, 0.12], [0.22, 0], [0.06, 0.12], [0.35, 0.04], [0.58, 0.15]] },
  t: { w: 0.52, join: [[0, 0.2], [0.18, 0.8], [0.28, 1.55], [0.22, 0.8], [0.18, 0.2], [0.28, 0], [0.52, 0.12]], marks: [[[0.02, 0.98], [0.48, 1.02]]] },
  u: { w: 0.82, join: [[0, 0.2], [0.08, 0.65], [0.1, 0.98], [0.08, 0.3], [0.2, 0], [0.42, 0.15], [0.52, 0.65], [0.55, 0.98], [0.52, 0.3], [0.6, 0], [0.82, 0.12]] },
  v: { w: 0.7, join: [[0, 0.2], [0.1, 0.7], [0.12, 0.98], [0.18, 0.45], [0.32, 0.02], [0.46, 0.4], [0.52, 0.85], [0.46, 0.98], [0.55, 0.82], [0.7, 0.82]] },
  w: { w: 1.05, join: [[0, 0.2], [0.08, 0.7], [0.1, 0.98], [0.12, 0.3], [0.26, 0], [0.42, 0.35], [0.46, 0.75], [0.5, 0.3], [0.64, 0], [0.8, 0.4], [0.85, 0.85], [0.8, 0.98], [0.9, 0.82], [1.05, 0.82]] },
  // Two crossing strokes, as x is written in maths; joined it reads as an alpha.
  x: { w: 0.72, solo: [[[0.05, 0.9], [0.2, 0.98], [0.46, 0.06], [0.64, 0.1]], [[0.6, 0.96], [0.08, 0.02]]] },
  y: { w: 0.78, join: [[0, 0.2], [0.08, 0.65], [0.1, 0.98], [0.08, 0.3], [0.2, 0], [0.42, 0.15], [0.52, 0.65], [0.55, 0.98], [0.52, 0], [0.46, -0.75], [0.3, -1.1], [0.12, -0.95], [0.25, -0.45], [0.78, 0.12]] },
  // Repeated points keep the corners sharp; rounded, a z reads as an e.
  z: { w: 0.64, join: [[0, 0.2], [0.1, 0.8], [0.13, 0.98], [0.13, 0.98], [0.52, 0.98], [0.52, 0.98], [0.08, 0.02], [0.08, 0.02], [0.48, 0.02], [0.64, 0.14]] },
};
const umlaut = (base: Glyph, x: number, y = 1.38): Glyph => ({ ...base, marks: [...(base.marks ?? []), dot(x, y), dot(x + 0.24, y)] });
LOWER['ä'] = umlaut(LOWER.a, 0.28);
LOWER['ö'] = umlaut(LOWER.o, 0.2);
LOWER['ü'] = umlaut(LOWER.u, 0.2);

const UPPER: Record<string, Glyph> = {
  A: { w: 1.15, solo: [[[0, 0], [0.55, 2], [1.1, 0]], [[0.25, 0.85], [0.85, 0.85]]] },
  B: { w: 0.95, solo: [[[0.1, 0], [0.1, 2]], [[0.1, 2], [0.6, 1.95], [0.78, 1.6], [0.6, 1.1], [0.1, 1.05], [0.7, 1], [0.88, 0.55], [0.65, 0.05], [0.1, 0]]] },
  C: { w: 1, solo: [[[0.9, 1.7], [0.6, 2], [0.2, 1.7], [0.05, 1], [0.25, 0.15], [0.6, 0], [0.9, 0.3]]] },
  D: { w: 1.05, solo: [[[0.1, 0], [0.1, 2]], [[0.1, 2], [0.6, 1.9], [0.95, 1.3], [0.9, 0.5], [0.55, 0.05], [0.1, 0]]] },
  E: { w: 0.9, solo: [[[0.8, 2], [0.1, 2], [0.1, 0], [0.8, 0]], [[0.1, 1.05], [0.65, 1.05]]] },
  F: { w: 0.85, solo: [[[0.8, 2], [0.1, 2], [0.1, 0]], [[0.1, 1.05], [0.6, 1.05]]] },
  G: { w: 1.05, solo: [[[0.9, 1.7], [0.6, 2], [0.2, 1.7], [0.05, 1], [0.25, 0.15], [0.6, 0], [0.95, 0.4], [0.95, 0.9], [0.55, 0.9]]] },
  H: { w: 1.1, solo: [[[0.1, 2], [0.1, 0]], [[0.95, 2], [0.95, 0]], [[0.1, 1], [0.95, 1]]] },
  I: { w: 0.42, solo: [[[0.2, 2], [0.2, 0]]] },
  J: { w: 0.8, solo: [[[0.7, 2], [0.7, 0.4], [0.5, 0], [0.2, 0.05], [0.05, 0.35]]] },
  K: { w: 1, solo: [[[0.1, 2], [0.1, 0]], [[0.85, 2], [0.12, 0.9], [0.9, 0]]] },
  L: { w: 0.85, solo: [[[0.1, 2], [0.1, 0], [0.8, 0]]] },
  M: { w: 1.4, solo: [[[0.05, 0], [0.15, 2], [0.7, 0.6], [1.2, 2], [1.3, 0]]] },
  N: { w: 1.15, solo: [[[0.1, 0], [0.1, 2], [1, 0], [1, 2]]] },
  O: { w: 1.2, solo: [[[0.6, 2], [0.15, 1.7], [0.05, 0.9], [0.3, 0.1], [0.7, 0], [1.05, 0.5], [1.05, 1.3], [0.75, 1.95], [0.55, 2]]] },
  P: { w: 0.95, solo: [[[0.1, 0], [0.1, 2], [0.65, 1.95], [0.88, 1.55], [0.7, 1.05], [0.1, 1]]] },
  Q: { w: 1.2, solo: [[[0.6, 2], [0.15, 1.7], [0.05, 0.9], [0.3, 0.1], [0.7, 0], [1.05, 0.5], [1.05, 1.3], [0.75, 1.95], [0.55, 2]], [[0.7, 0.4], [1.1, -0.1]]] },
  R: { w: 1, solo: [[[0.1, 0], [0.1, 2], [0.65, 1.95], [0.88, 1.55], [0.7, 1.05], [0.1, 1], [0.45, 1], [0.95, 0]]] },
  S: { w: 0.9, solo: [[[0.82, 1.75], [0.5, 2], [0.15, 1.75], [0.2, 1.3], [0.7, 0.9], [0.85, 0.4], [0.55, 0], [0.15, 0.1], [0.05, 0.3]]] },
  T: { w: 1, solo: [[[0, 2], [1, 2]], [[0.5, 2], [0.5, 0]]] },
  U: { w: 1.1, solo: [[[0.1, 2], [0.1, 0.5], [0.3, 0.05], [0.6, 0], [0.9, 0.3], [0.95, 2]]] },
  V: { w: 1.1, solo: [[[0, 2], [0.55, 0], [1.1, 2]]] },
  W: { w: 1.6, solo: [[[0, 2], [0.35, 0], [0.8, 1.6], [1.25, 0], [1.6, 2]]] },
  X: { w: 1, solo: [[[0, 2], [1, 0]], [[1, 2], [0, 0]]] },
  Y: { w: 1, solo: [[[0, 2], [0.5, 1], [1, 2]], [[0.5, 1], [0.5, 0]]] },
  Z: { w: 1, solo: [[[0.1, 2], [0.9, 2], [0.1, 0], [0.95, 0]]] },
};
const umlautUpper = (base: Glyph, x: number): Glyph => ({ ...base, solo: [...(base.solo ?? []), dot(x, 2.35), dot(x + 0.36, 2.35)] });
UPPER['Ä'] = umlautUpper(UPPER.A, 0.36);
UPPER['Ö'] = umlautUpper(UPPER.O, 0.42);
UPPER['Ü'] = umlautUpper(UPPER.U, 0.36);

const DIGITS: Record<string, readonly (readonly Unit[])[]> = {
  '0': [[[0.4, 1.6], [0.1, 1.3], [0.05, 0.6], [0.25, 0], [0.55, 0.05], [0.72, 0.7], [0.65, 1.4], [0.4, 1.6]]],
  '1': [[[0.15, 1.25], [0.45, 1.6], [0.45, 0]]],
  '2': [[[0.08, 1.25], [0.35, 1.6], [0.65, 1.4], [0.6, 0.95], [0.05, 0], [0.75, 0]]],
  '3': [[[0.1, 1.4], [0.4, 1.6], [0.65, 1.35], [0.55, 0.95], [0.3, 0.85], [0.6, 0.75], [0.7, 0.35], [0.45, 0], [0.1, 0.15]]],
  '4': [[[0.55, 0], [0.55, 1.6], [0.05, 0.45], [0.8, 0.45]]],
  '5': [[[0.7, 1.6], [0.2, 1.6], [0.12, 0.9], [0.45, 1], [0.7, 0.65], [0.6, 0.15], [0.3, 0], [0.08, 0.15]]],
  '6': [[[0.6, 1.55], [0.3, 1.4], [0.08, 0.8], [0.15, 0.15], [0.4, 0], [0.65, 0.3], [0.6, 0.75], [0.35, 0.85], [0.1, 0.6]]],
  '7': [[[0.05, 1.6], [0.75, 1.6], [0.3, 0]], [[0.25, 0.8], [0.65, 0.8]]],
  '8': [[[0.4, 0.85], [0.1, 1.2], [0.35, 1.6], [0.65, 1.3], [0.4, 0.85], [0.08, 0.4], [0.35, 0], [0.7, 0.35], [0.4, 0.85]]],
  '9': [[[0.65, 1.15], [0.4, 0.85], [0.1, 1.1], [0.3, 1.6], [0.65, 1.4], [0.6, 0.6], [0.45, 0]]],
};
const OTHER: Record<string, Glyph> = {
  '=': { w: 0.85, solo: [[[0.08, 0.75], [0.72, 0.75]], [[0.08, 0.35], [0.72, 0.35]]] },
  '+': { w: 0.85, solo: [[[0.08, 0.55], [0.72, 0.55]], [[0.4, 0.2], [0.4, 0.9]]] },
  '−': { w: 0.75, solo: [[[0.08, 0.55], [0.62, 0.55]]] },
  '-': { w: 0.55, solo: [[[0.08, 0.5], [0.45, 0.5]]] },
  '±': { w: 0.85, solo: [[[0.08, 0.7], [0.72, 0.7]], [[0.4, 0.35], [0.4, 1.05]], [[0.08, 0.1], [0.72, 0.1]]] },
  '·': { w: 0.4, solo: [dot(0.16, 0.5)] },
  '(': { w: 0.42, solo: [[[0.36, 1.8], [0.14, 1.2], [0.1, 0.4], [0.32, -0.3]]] },
  ')': { w: 0.42, solo: [[[0.06, 1.8], [0.28, 1.2], [0.3, 0.4], [0.1, -0.3]]] },
  '[': { w: 0.42, solo: [[[0.36, 1.8], [0.12, 1.8], [0.12, -0.3], [0.36, -0.3]]] },
  ']': { w: 0.42, solo: [[[0.06, 1.8], [0.3, 1.8], [0.3, -0.3], [0.06, -0.3]]] },
  '|': { w: 0.35, solo: [[[0.18, 1.8], [0.16, -0.3]]] },
  "'": { w: 0.25, solo: [[[0.16, 1.9], [0.1, 1.4]]] },
  '/': { w: 0.6, solo: [[[0.05, -0.2], [0.55, 1.8]]] },
  ',': { w: 0.3, solo: [[[0.14, 0.08], [0.05, -0.3]]] },
  '.': { w: 0.3, solo: [dot(0.1, 0.02)] },
  ':': { w: 0.32, solo: [dot(0.12, 0.85), dot(0.12, 0.05)] },
  '?': { w: 0.65, solo: [[[0.05, 1.35], [0.3, 1.6], [0.55, 1.35], [0.3, 0.9], [0.3, 0.55]], dot(0.28, 0.04)] },
  '!': { w: 0.35, solo: [[[0.18, 1.6], [0.16, 0.5]], dot(0.15, 0.04)] },
  '<': { w: 0.8, solo: [[[0.7, 1], [0.1, 0.55], [0.7, 0.1]]] },
  '>': { w: 0.8, solo: [[[0.1, 1], [0.7, 0.55], [0.1, 0.1]]] },
  '→': { w: 1.15, solo: [[[0.05, 0.55], [1, 0.55]], [[0.75, 0.8], [1.02, 0.55], [0.75, 0.3]]] },
  '⇒': { w: 1.15, solo: [[[0.05, 0.75], [0.9, 0.75]], [[0.05, 0.35], [0.9, 0.35]], [[0.7, 1.05], [1.05, 0.55], [0.7, 0.05]]] },
  '≈': { w: 0.85, solo: [[[0.08, 0.72], [0.25, 0.85], [0.55, 0.65], [0.72, 0.78]], [[0.08, 0.32], [0.25, 0.45], [0.55, 0.25], [0.72, 0.38]]] },
  '√': { w: 0.68, solo: [[[0, 0.6], [0.15, 0.72], [0.35, -0.05], [0.62, 1.65], [1.55, 1.65]]] },
  '∫': { w: 0.75, solo: [[[0.66, 2.05], [0.52, 2.3], [0.36, 2.05], [0.34, 0.6], [0.3, -0.75], [0.15, -1.05], [0.02, -0.85]]] },
  'Δ': { w: 1.05, solo: [[[0.5, 1.8], [0.02, 0], [1, 0], [0.5, 1.8]]] },
  '°': { w: 0.4, solo: [[[0.2, 1.75], [0.08, 1.6], [0.2, 1.45], [0.32, 1.6], [0.2, 1.75]]] },
  '∞': { w: 1.15, solo: [[[0.55, 0.55], [0.3, 0.85], [0.05, 0.55], [0.3, 0.25], [0.55, 0.55], [0.8, 0.85], [1.05, 0.55], [0.8, 0.25], [0.55, 0.55]]] },
  'π': { w: 0.9, solo: [[[0.02, 0.8], [0.25, 0.98], [0.85, 0.95]], [[0.3, 0.95], [0.25, 0]], [[0.62, 0.95], [0.64, 0.1], [0.8, 0.02]]] },
};

const shift = (strokes: ReadonlyArray<readonly Unit[]>, scale: number, dy: number): Unit[][] =>
  strokes.map((stroke) => stroke.map(([x, y]) => [x * scale, y * scale + dy] as Unit));
for (const [digit, strokes] of Object.entries(DIGITS)) OTHER[digit] = { w: 0.82, solo: strokes };
for (const [mark, digit] of [['²', '2'], ['³', '3'], ['⁴', '4'], ['¹', '1']] as const) OTHER[mark] = { w: 0.5, solo: shift(DIGITS[digit], 0.55, 1.15) };
for (const [mark, digit] of [['₀', '0'], ['₁', '1'], ['₂', '2']] as const) OTHER[mark] = { w: 0.5, solo: shift(DIGITS[digit], 0.55, -0.35) };
OTHER['⁺'] = { w: 0.5, solo: shift(OTHER['+'].solo ?? [], 0.55, 0.95) };
OTHER['⁻'] = { w: 0.45, solo: shift(OTHER['−'].solo ?? [], 0.55, 0.95) };
OTHER['ⁿ'] = { w: 0.5, solo: shift([LOWER.n.join ?? []], 0.55, 1.15) };
OTHER['ˣ'] = { w: 0.45, solo: shift(LOWER.x.solo ?? [], 0.55, 1.15) };
OTHER['½'] = { w: 0.8, solo: [...shift(DIGITS['1'], 0.5, 0.95), [[0.1, -0.1], [0.7, 1.75]], ...shift(DIGITS['2'], 0.5, -0.15).map((stroke) => stroke.map(([x, y]) => [x + 0.38, y] as Unit))] };
OTHER['–'] = { w: 0.75, solo: [[[0.08, 0.5], [0.62, 0.5]]] };
OTHER['↔'] = { w: 1.3, solo: [[[0.08, 0.55], [1.2, 0.55]], [[0.32, 0.8], [0.05, 0.55], [0.32, 0.3]], [[0.95, 0.8], [1.22, 0.55], [0.95, 0.3]]] };

/** Deterministic xorshift generator in [0, 1). */
export function generator(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** A pen stroke in page coordinates. */
export interface InkLine {
  points: Array<{ x: number; y: number; pressure: number }>;
}

export interface WriteOptions {
  /** x-height in page pixels. */
  size: number;
  /** Forward slant of upright strokes (dx per dy). */
  slant?: number;
  /** Horizontal stretch of the letters. */
  width?: number;
  random: () => number;
}

/**
 * Catmull-Rom spline through `points` (page coordinates), sampled about
 * every `step` pixels, as a digitizer reports a moving pen.
 */
export function spline(points: ReadonlyArray<readonly [number, number]>, step = 1.6): Array<[number, number]> {
  if (points.length < 2) return points.map(([x, y]) => [x, y]);
  const out: Array<[number, number]> = [[points[0][0], points[0][1]]];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const count = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let sample = 1; sample <= count; sample += 1) {
      const t = sample / count;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (axis: 0 | 1) => 0.5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * t
        + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2
        + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3);
      out.push([at(0), at(1)]);
    }
  }
  return out;
}

/** Pressure along a line: a little swell and wobble, lighter where the pen lands and lifts. */
export function withPressure(path: ReadonlyArray<readonly [number, number]>, random: () => number, base = 0.55): InkLine {
  const phase = random() * Math.PI * 2;
  const last = path.length - 1;
  return {
    points: path.map(([x, y], index) => {
      const ends = Math.min(1, index / 3, (last - index) / 3);
      const pressure = (base + 0.12 * Math.sin(phase + index * 0.09) + (random() - 0.5) * 0.04) * (0.6 + 0.4 * Math.max(0, ends));
      return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, pressure: Math.round(Math.min(0.95, Math.max(0.15, pressure)) * 1000) / 1000 };
    }),
  };
}

const DEFAULT_WIDTH = 1.1;

/** About how wide `write` makes `text`, in page pixels: for laying out a line. */
export function measure(text: string, size: number, width = DEFAULT_WIDTH): number {
  let advance = 0;
  for (const character of text) advance += character === ' ' ? 0.6 : ((LOWER[character] ?? UPPER[character] ?? OTHER[character])?.w ?? 0.6) + 0.04;
  return advance * width * size;
}

/**
 * Writes `text` with its baseline starting at (x, y); returns the strokes and
 * where the pen stopped.
 */
export function write(text: string, x: number, y: number, options: WriteOptions): { lines: InkLine[]; end: number } {
  const { size, random } = options;
  const slant = options.slant ?? 0.22;
  const widthFactor = options.width ?? DEFAULT_WIDTH;
  const units: Unit[][] = [];
  let word: Unit[] | null = null;
  let marks: Unit[][] = [];
  let cursor = 0;
  let drift = (random() - 0.5) * 0.12;
  const flush = () => {
    if (word) units.push(word);
    units.push(...marks);
    word = null;
    marks = [];
  };
  for (const character of text) {
    if (character === ' ') {
      flush();
      cursor += 0.5 + random() * 0.2;
      drift = drift * 0.5 + (random() - 0.5) * 0.14;
      continue;
    }
    const glyph = LOWER[character] ?? UPPER[character] ?? OTHER[character];
    if (!glyph) {
      cursor += 0.6;
      continue;
    }
    const stretch = 0.94 + random() * 0.12;
    const lift = drift + (random() - 0.5) * 0.04;
    const place = (stroke: readonly Unit[]): Unit[] =>
      stroke.map(([gx, gy]) => [cursor + gx * stretch + (random() - 0.5) * 0.05, gy * (0.96 + random() * 0.06) + lift + (random() - 0.5) * 0.04]);
    if (glyph.join) {
      const placed = place(glyph.join);
      if (word) word.push(...placed);
      else word = placed;
    } else {
      flush();
      units.push(...(glyph.solo ?? []).map(place));
    }
    marks.push(...(glyph.marks ?? []).map(place));
    cursor += glyph.w * stretch + 0.04;
  }
  flush();
  const lines = units.map((stroke) => {
    const page = stroke.map(([gx, gy]) => [x + (gx * widthFactor + gy * slant) * size, y - gy * size] as [number, number]);
    return withPressure(stroke.length <= 2 && Math.hypot(stroke[stroke.length - 1][0] - stroke[0][0], stroke[stroke.length - 1][1] - stroke[0][1]) < 0.1 ? page : spline(page), random);
  });
  return { lines, end: x + cursor * widthFactor * size };
}

/** A hand-drawn line through `points`: slightly wavy, as a ruler-free pen draws it. */
export function sketch(points: ReadonlyArray<readonly [number, number]>, random: () => number, wobble = 0.8): InkLine {
  const dense: Array<[number, number]> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    const steps = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 18));
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      dense.push([x1 + (x2 - x1) * t + (random() - 0.5) * wobble, y1 + (y2 - y1) * t + (random() - 0.5) * wobble]);
    }
  }
  dense.push([points[points.length - 1][0], points[points.length - 1][1]]);
  return withPressure(spline(dense), random);
}
