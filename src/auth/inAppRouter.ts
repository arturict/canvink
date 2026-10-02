/**
 * History-API navigation for Clerk's `routerPush` / `routerReplace` options.
 *
 * Without these, Clerk performs `window.location` navigations after a modal
 * sign-in or sign-up completes. In this SPA that is a full reload, which
 * tears down the open collab join session and, on the anonymous-viewer
 * upgrade path, briefly leaves the guest on a signed-out page. Routing
 * through `history` keeps the page alive, so the auth state simply flips
 * and the join surface upgrades the session in place.
 */
export interface InAppRouter {
  push(to: string): void;
  replace(to: string): void;
}

export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

/** Same document (origin + path + search) — only the hash may differ. */
export function isSameDocument(to: string, currentHref: string): boolean {
  try {
    const target = new URL(to, currentHref);
    const current = new URL(currentHref);
    return target.origin === current.origin
      && target.pathname === current.pathname
      && target.search === current.search;
  } catch {
    return false;
  }
}

export function createInAppRouter(
  history: HistoryLike,
  getHref: () => string,
  hardNavigate: (to: string) => void,
): InAppRouter {
  const go = (kind: 'push' | 'replace', to: string) => {
    const href = getHref();
    if (!isSameDocument(to, href)) {
      // A genuinely different page (e.g. an account-portal URL) still needs a
      // real navigation; only same-document hops stay in the SPA.
      hardNavigate(to);
      return;
    }
    if (kind === 'push') history.pushState(null, '', to);
    else history.replaceState(null, '', to);
    const target = new URL(to, href);
    const current = new URL(href);
    if (target.hash !== current.hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  return {
    push: (to) => go('push', to),
    replace: (to) => go('replace', to),
  };
}
