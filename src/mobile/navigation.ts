/**
 * Where the phone app is: one of three destinations of the bottom bar, each
 * with its own stack of screens on top (notebook, section, page), so a tab
 * keeps its place while another one is used. Back pops the stack of the
 * current tab, then returns to Start, then leaves the app.
 */

export type MobileTab = 'home' | 'notebooks' | 'search';

export type MobileRoute =
  | { kind: 'notebook'; notebookId: string }
  | { kind: 'section'; notebookId: string; sectionId: string }
  | { kind: 'page'; notebookId: string; sectionId: string; pageId: string };

export interface MobileNavState {
  tab: MobileTab;
  stacks: Readonly<Record<MobileTab, readonly MobileRoute[]>>;
}

export const INITIAL_NAV: MobileNavState = Object.freeze({
  tab: 'home',
  stacks: Object.freeze({ home: [], notebooks: [], search: [] }),
});

export function currentStack(state: MobileNavState): readonly MobileRoute[] {
  return state.stacks[state.tab];
}

export function topRoute(state: MobileNavState): MobileRoute | null {
  const stack = currentStack(state);
  return stack[stack.length - 1] ?? null;
}

/** How many presses of back stay inside the app. */
export function backDepth(state: MobileNavState): number {
  return currentStack(state).length + (state.tab === 'home' ? 0 : 1);
}

function withStack(state: MobileNavState, tab: MobileTab, stack: readonly MobileRoute[]): MobileNavState {
  return { tab, stacks: { ...state.stacks, [tab]: stack } };
}

export function push(state: MobileNavState, route: MobileRoute): MobileNavState {
  const stack = currentStack(state);
  const top = stack[stack.length - 1];
  if (top && routeKey(top) === routeKey(route)) return state;
  return withStack(state, state.tab, [...stack, route]);
}

/** Swaps the screen on top (turning a page) without adding a back step. */
export function replaceTop(state: MobileNavState, route: MobileRoute): MobileNavState {
  const stack = currentStack(state);
  if (stack.length === 0) return push(state, route);
  return withStack(state, state.tab, [...stack.slice(0, -1), route]);
}

/** One step back; `null` when back leaves the app. */
export function pop(state: MobileNavState): MobileNavState | null {
  const stack = currentStack(state);
  if (stack.length > 0) return withStack(state, state.tab, stack.slice(0, -1));
  if (state.tab !== 'home') return { ...state, tab: 'home' };
  return null;
}

/** Choosing the current tab again returns to its first screen, as on Android. */
export function selectTab(state: MobileNavState, tab: MobileTab): MobileNavState {
  if (tab === state.tab) return currentStack(state).length === 0 ? state : withStack(state, tab, []);
  return { ...state, tab };
}

/**
 * The stack that shows a page from the notebook tab: notebook, its section,
 * the page. Opening a page from Start or Search keeps that tab's stack short
 * (back returns to the list it was opened from).
 */
export function openPage(
  state: MobileNavState,
  page: { notebookId: string; sectionId: string; pageId: string },
): MobileNavState {
  return push(state, { kind: 'page', ...page });
}

export function routeKey(route: MobileRoute): string {
  switch (route.kind) {
    case 'notebook':
      return `notebook:${route.notebookId}`;
    case 'section':
      return `section:${route.notebookId}:${route.sectionId}`;
    case 'page':
      return `page:${route.pageId}`;
  }
}

/** Drops screens of things that no longer exist (deleted on another device). */
export function pruneRoutes(
  state: MobileNavState,
  exists: (route: MobileRoute) => boolean,
): MobileNavState {
  let changed = false;
  const stacks = { ...state.stacks };
  for (const tab of Object.keys(stacks) as MobileTab[]) {
    const stack = stacks[tab];
    const firstMissing = stack.findIndex((route) => !exists(route));
    if (firstMissing >= 0) {
      stacks[tab] = stack.slice(0, firstMissing);
      changed = true;
    }
  }
  return changed ? { ...state, stacks } : state;
}
