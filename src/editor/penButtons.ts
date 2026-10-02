/**
 * What an active pen's buttons do. Windows delivers three physical sources as
 * pointer-event button bits, and which of them a given pen model fires is
 * only known from the hardware, so every source is its own slot the user can
 * map (the "Knopf testen" helper in the pen menu shows which one fired):
 *
 * - `barrel`: the first barrel button, the right button (`buttons & 2`,
 *   `button === 2`).
 * - `secondary`: a second barrel button some pens report as the middle or an
 *   extra button (`buttons & 4`, `8` or `16`).
 * - `eraserEnd`: the tail of the pen, or a barrel button the Windows pen
 *   settings turn into the eraser (`buttons & 32`, `button === 5`).
 *
 * A held button is a temporary tool for one gesture: the toolbar's tool is
 * never changed, so the previous tool is simply active again on release.
 */

export type PenSlot = 'barrel' | 'secondary' | 'eraserEnd';
export type PenButtonAction = 'none' | 'eraser' | 'lasso' | 'rectangleSelect' | 'screenshot';
/** The temporary tool a button asks for; `none` leaves the pen writing. */
export type PenGestureAction = Exclude<PenButtonAction, 'none'>;
export type PenButtonMapping = Record<PenSlot, PenButtonAction>;

export const PEN_SLOTS: readonly PenSlot[] = ['barrel', 'secondary', 'eraserEnd'];
export const PEN_BUTTON_ACTIONS: readonly PenButtonAction[] = [
  'eraser',
  'lasso',
  'rectangleSelect',
  'screenshot',
  'none',
];

/**
 * OneNote's pairing: the barrel button erases, a second button selects with
 * the lasso, the eraser end erases.
 */
export const DEFAULT_PEN_BUTTON_MAPPING: PenButtonMapping = {
  barrel: 'eraser',
  secondary: 'lasso',
  eraserEnd: 'eraser',
};

export interface PenButtonInput {
  pointerType: string;
  button: number;
  buttons: number;
}

const BUTTON_BITS: Record<PenSlot, number> = {
  barrel: 2,
  /** Middle (4), back (8) and forward (16) buttons. */
  secondary: 4 | 8 | 16,
  eraserEnd: 32,
};
/** `PointerEvent.button` values that announce a button in a pointerdown or pointerup. */
const BUTTON_NUMBERS: Record<PenSlot, readonly number[]> = {
  barrel: [2],
  secondary: [1, 3, 4],
  eraserEnd: [5],
};
const SLOT_PRIORITY: readonly PenSlot[] = ['eraserEnd', 'barrel', 'secondary'];

/** Every slot the event reports, in priority order (eraser end first). */
export function penSlotsPressed(input: PenButtonInput): PenSlot[] {
  if (input.pointerType !== 'pen') return [];
  return SLOT_PRIORITY.filter((slot) =>
    (input.buttons & BUTTON_BITS[slot]) !== 0 || BUTTON_NUMBERS[slot].includes(input.button));
}

/**
 * The temporary tool the pen's pressed buttons ask for, or `null` for a plain
 * tip, a button mapped to `none`, and anything that is not a pen. With
 * several buttons down the highest-priority slot decides.
 */
export function penButtonAction(input: PenButtonInput, mapping: PenButtonMapping): PenGestureAction | null {
  const [slot] = penSlotsPressed(input);
  if (!slot) return null;
  const action = mapping[slot];
  return action === 'none' ? null : action;
}

/** The raw `buttons` bits set, for the "Knopf testen" readout. */
export function pressedButtonBits(buttons: number): number[] {
  return [1, 2, 4, 8, 16, 32].filter((bit) => (buttons & bit) !== 0);
}

export const PEN_BUTTONS_STORAGE_KEY = 'canvink:pen-buttons';
/** The single barrel choice stored before the mapping existed. */
export const PEN_BUTTONS_LEGACY_KEY = 'canvink:pen-barrel';

function isAction(value: unknown): value is PenButtonAction {
  return typeof value === 'string' && (PEN_BUTTON_ACTIONS as readonly string[]).includes(value);
}

/** Parses stored settings; unknown or missing fields fall back to the defaults. */
export function parsePenButtonMapping(raw: string | null, legacyBarrel: string | null = null): PenButtonMapping {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Record<PenSlot, unknown>>;
      return {
        barrel: isAction(parsed.barrel) ? parsed.barrel : DEFAULT_PEN_BUTTON_MAPPING.barrel,
        secondary: isAction(parsed.secondary) ? parsed.secondary : DEFAULT_PEN_BUTTON_MAPPING.secondary,
        eraserEnd: isAction(parsed.eraserEnd) ? parsed.eraserEnd : DEFAULT_PEN_BUTTON_MAPPING.eraserEnd,
      };
    } catch {
      return DEFAULT_PEN_BUTTON_MAPPING;
    }
  }
  // Someone who set the barrel button to the lasso keeps that, and the second
  // button takes the eraser.
  if (legacyBarrel === 'lasso') return { ...DEFAULT_PEN_BUTTON_MAPPING, barrel: 'lasso', secondary: 'eraser' };
  return DEFAULT_PEN_BUTTON_MAPPING;
}
