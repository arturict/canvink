import { ChevronDown } from 'lucide-react';
import { AppMenuButton } from '../../ui/AppMenuButton';
import type { ContextMenuEntry } from '../../ui/ContextMenu';

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface SearchChoiceChipProps {
  /** Name of the filter on the chip, for example "Aufgaben". */
  label: string;
  options: readonly ChoiceOption[];
  /** The chosen option's id, or undefined for "any". */
  value: string | undefined;
  /** The row that clears the choice. */
  anyLabel: string;
  onChange(id: string | undefined): void;
  /** A filter with nothing to choose from, such as tags before any page has one. */
  disabled?: boolean;
}

/**
 * A filter chip for one choice out of a short list, built on the app's shared
 * button menu (arrow keys, typeahead, Escape, focus return). The chosen
 * option shows as a checked radio row; choosing it again clears the filter.
 */
export default function SearchChoiceChip({ label, options, value, anyLabel, onChange, disabled }: SearchChoiceChipProps) {
  const chosen = options.find((option) => option.id === value);
  const items = (): ContextMenuEntry[] => [
    { id: 'any', label: anyLabel, role: 'menuitemradio', checked: value === undefined, onSelect: () => onChange(undefined) },
    ...options.map((option): ContextMenuEntry => ({
      id: option.id,
      label: option.label,
      role: 'menuitemradio',
      checked: option.id === value,
      onSelect: () => onChange(option.id === value ? undefined : option.id),
    })),
  ];
  return (
    <AppMenuButton
      className="search-chip"
      data-active={chosen ? 'true' : undefined}
      label={chosen ? `${label}: ${chosen.label}` : label}
      align="start"
      disabled={disabled}
      items={items}
    >
      <span>{label}</span>
      {chosen ? <span className="search-chip__count">1</span> : null}
      <ChevronDown size={13} aria-hidden="true" />
    </AppMenuButton>
  );
}
