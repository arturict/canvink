import { useCallback, useState } from 'react';

/**
 * Which section groups, pages with subpages and (in the phone tree) sections
 * are folded. OneNote remembers this per notebook; Canvink keeps it per
 * device in localStorage because it is a view preference, not notebook
 * content, and writing it into the shared document would sync every fold.
 */
export interface NavigationCollapseState {
  /** Folded section groups. */
  groups: string[];
  /** Pages whose subpages are hidden. */
  pages: string[];
  /**
   * Sections of the phone tree whose pages are shown or hidden by choice.
   * Absent sections follow the default: only the open section is expanded.
   */
  sections: Record<string, boolean>;
}

export type CollapseKind = 'groups' | 'pages';

export const NAVIGATION_COLLAPSE_KEY = 'canvink:navigation-collapse';
/** Bounds the stored lists so years of folding cannot grow storage forever. */
const MAX_ENTRIES = 2_000;

export function emptyCollapseState(): NavigationCollapseState {
  return { groups: [], pages: [], sections: {} };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-MAX_ENTRIES) : [];

export function parseCollapseState(serialized: string | null): NavigationCollapseState {
  if (!serialized) return emptyCollapseState();
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object') return emptyCollapseState();
    const record = value as Record<string, unknown>;
    const sections: Record<string, boolean> = {};
    if (record.sections && typeof record.sections === 'object') {
      for (const [id, open] of Object.entries(record.sections).slice(-MAX_ENTRIES)) {
        if (typeof open === 'boolean') sections[id] = open;
      }
    }
    return { groups: stringList(record.groups), pages: stringList(record.pages), sections };
  } catch {
    return emptyCollapseState();
  }
}

function readStored(): NavigationCollapseState {
  try {
    return parseCollapseState(globalThis.localStorage?.getItem(NAVIGATION_COLLAPSE_KEY) ?? null);
  } catch {
    return emptyCollapseState();
  }
}

function store(state: NavigationCollapseState): void {
  try {
    globalThis.localStorage?.setItem(NAVIGATION_COLLAPSE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: folding still works for this session.
  }
}

export interface NavigationCollapse {
  isCollapsed: (kind: CollapseKind, id: string) => boolean;
  toggle: (kind: CollapseKind, id: string) => void;
  /** Unfolds the given groups and pages, for example the path to the open page. */
  reveal: (kind: CollapseKind, ids: readonly string[]) => void;
  isSectionOpen: (sectionId: string, fallback: boolean) => boolean;
  /** The stored choice for a section of the phone tree, if any. */
  storedSectionOpen: (sectionId: string) => boolean | undefined;
  setSectionOpen: (sectionId: string, open: boolean) => void;
}

export function useNavigationCollapse(): NavigationCollapse {
  const [state, setState] = useState<NavigationCollapseState>(readStored);
  const update = useCallback((change: (current: NavigationCollapseState) => NavigationCollapseState) => {
    setState((current) => {
      const next = change(current);
      if (next !== current) store(next);
      return next;
    });
  }, []);
  return {
    isCollapsed: (kind, id) => state[kind].includes(id),
    toggle: (kind, id) => update((current) => ({
      ...current,
      [kind]: current[kind].includes(id)
        ? current[kind].filter((entry) => entry !== id)
        : [...current[kind], id].slice(-MAX_ENTRIES),
    })),
    reveal: (kind, ids) => update((current) => (
      ids.some((id) => current[kind].includes(id))
        ? { ...current, [kind]: current[kind].filter((entry) => !ids.includes(entry)) }
        : current
    )),
    isSectionOpen: (sectionId, fallback) => state.sections[sectionId] ?? fallback,
    storedSectionOpen: (sectionId) => state.sections[sectionId],
    setSectionOpen: (sectionId, open) => update((current) => (
      current.sections[sectionId] === open
        ? current
        : { ...current, sections: { ...current.sections, [sectionId]: open } }
    )),
  };
}
