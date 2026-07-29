export type UiPreferences = {
  readonly schemaVersion: 1;
  readonly guideDismissed: boolean;
  readonly textSize: 'default' | 'large';
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = Object.freeze({
  schemaVersion: 1,
  guideDismissed: false,
  textSize: 'default',
});

const STORAGE_KEY = 'canvink:ui-preferences:v1';

function defaultPreferences(): UiPreferences {
  return { ...DEFAULT_UI_PREFERENCES };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePreferences(value: unknown): UiPreferences | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.guideDismissed !== 'boolean' ||
    (value.textSize !== 'default' && value.textSize !== 'large')
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    guideDismissed: value.guideDismissed,
    textSize: value.textSize,
  };
}

function localStorageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadUiPreferences(): UiPreferences {
  const storage = localStorageOrNull();
  if (!storage) return defaultPreferences();

  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === null) return defaultPreferences();
    return parsePreferences(JSON.parse(stored)) ?? defaultPreferences();
  } catch {
    return defaultPreferences();
  }
}

export function saveUiPreferences(preferences: UiPreferences): void {
  const storage = localStorageOrNull();
  if (!storage) return;

  try {
    const parsed = parsePreferences(preferences);
    if (!parsed) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // UI preferences are optional and must never prevent note editing.
  }
}
