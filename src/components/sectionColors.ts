import type { TranslationKey } from '../i18n';

/**
 * Section colours offered by "Abschnittsfarbe", like OneNote's palette. The
 * first eight are also the defaults derived from a section id, so a section
 * that never had a colour chosen keeps the colour it always showed.
 */
export const SECTION_COLOR_PALETTE: ReadonlyArray<{ value: string; labelKey: TranslationKey }> = [
  { value: '#2f9e5b', labelKey: 'sectionColor.green' },
  { value: '#c2185b', labelKey: 'sectionColor.magenta' },
  { value: '#b08d57', labelKey: 'sectionColor.sand' },
  { value: '#1f6fb2', labelKey: 'sectionColor.blue' },
  { value: '#ef6c1a', labelKey: 'sectionColor.orange' },
  { value: '#e0a800', labelKey: 'sectionColor.yellow' },
  { value: '#7b4bb7', labelKey: 'sectionColor.purple' },
  { value: '#0f8b8d', labelKey: 'sectionColor.teal' },
  { value: '#d13438', labelKey: 'sectionColor.red' },
  { value: '#2aa0c8', labelKey: 'sectionColor.cyan' },
  { value: '#7cb342', labelKey: 'sectionColor.lime' },
  { value: '#8a8f98', labelKey: 'sectionColor.silver' },
];

const DERIVED_COLORS = SECTION_COLOR_PALETTE.slice(0, 8).map((color) => color.value);

/** The colour a section shows: the chosen one, else one derived from its stable id. */
export function sectionColor(section: { id: string; color?: string }): string {
  if (section.color && /^#[0-9a-f]{6}$/i.test(section.color)) return section.color;
  let hash = 0;
  for (let index = 0; index < section.id.length; index += 1) {
    hash = (hash * 31 + section.id.charCodeAt(index)) >>> 0;
  }
  return DERIVED_COLORS[hash % DERIVED_COLORS.length];
}
