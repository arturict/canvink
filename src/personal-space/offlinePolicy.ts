/**
 * Whether this device keeps offline copies of every page of the personal space
 * (`all`, the default: the pages are downloaded in the background once the
 * notebook tree is usable) or only of the pages that were opened (`opened`).
 */

export type OfflineCopiesPolicy = 'all' | 'opened';

const KEY = 'canvink:personal-space:offline-copies:v1';

export function loadOfflineCopiesPolicy(): OfflineCopiesPolicy {
  if (typeof localStorage === 'undefined') return 'all';
  try {
    return localStorage.getItem(KEY) === 'opened' ? 'opened' : 'all';
  } catch {
    return 'all';
  }
}

export function saveOfflineCopiesPolicy(policy: OfflineCopiesPolicy): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (policy === 'all') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, policy);
  } catch {
    // Storage blocked: the default (all pages) stays in force.
  }
}
