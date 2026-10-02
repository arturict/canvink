/**
 * Which device rebuilds a legacy page. Two devices that both notice the same page must not both
 * write a replacement, so a rebuild starts with a claim in the notebook document, next to the page
 * list it will change. A claim is a root field of its own per device and page
 * (`rebuild:<pageDocumentId>:<deviceId>`), never an entry of a shared map: devices that claim at the
 * same time then merge into several claims instead of one overwriting the other. All devices read
 * the same rule, so they agree on the winner without talking to each other: the earliest unexpired
 * claim, ties broken by device id. A claim expires, so a device that went away mid-rebuild does not
 * block the page for good.
 *
 * The swap that replaces a page writes a `swap:<newDocumentId>` field naming the document it
 * replaced; other devices use it to retire the old document from the personal space.
 */
export const LEASE_PREFIX = 'rebuild:';
export const SWAP_PREFIX = 'swap:';
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

export interface RebuildClaim {
  at: string;
  expiresAt: string;
}

export function claimKey(pageDocumentId: string, deviceId: string): string {
  return `${LEASE_PREFIX}${pageDocumentId}:${deviceId}`;
}

/** A change function for the notebook document that records this device's claim. */
export function claimChange(
  pageDocumentId: string,
  deviceId: string,
  now: Date,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): (notebook: Record<string, unknown>) => void {
  return (notebook) => {
    const claim: RebuildClaim = { at: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    notebook[claimKey(pageDocumentId, deviceId)] = claim;
  };
}

/** Removes every claim on a page (the swap does this, or a device that gives up removes its own). */
export function releaseChange(pageDocumentId: string, deviceId?: string): (notebook: Record<string, unknown>) => void {
  return (notebook) => {
    const prefix = `${LEASE_PREFIX}${pageDocumentId}:`;
    for (const key of Object.keys(notebook)) {
      if (key.startsWith(prefix) && (deviceId === undefined || key === claimKey(pageDocumentId, deviceId))) {
        delete notebook[key];
      }
    }
  };
}

export interface ActiveClaim extends RebuildClaim {
  deviceId: string;
}

export function activeClaims(notebook: object, pageDocumentId: string, nowMs: number): ActiveClaim[] {
  const prefix = `${LEASE_PREFIX}${pageDocumentId}:`;
  const claims: ActiveClaim[] = [];
  for (const [key, value] of Object.entries(notebook as Record<string, unknown>)) {
    if (!key.startsWith(prefix)) continue;
    const claim = value as Partial<RebuildClaim> | null;
    if (typeof claim?.at !== 'string' || typeof claim.expiresAt !== 'string') continue;
    if (Date.parse(claim.expiresAt) <= nowMs) continue;
    claims.push({ deviceId: key.slice(prefix.length), at: claim.at, expiresAt: claim.expiresAt });
  }
  return claims;
}

/** The device whose claim wins: earliest, then lowest device id. Undefined when nobody holds one. */
export function leaseWinner(notebook: object, pageDocumentId: string, nowMs: number): string | undefined {
  const claims = activeClaims(notebook, pageDocumentId, nowMs);
  claims.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.deviceId < right.deviceId ? -1 : 1));
  return claims[0]?.deviceId;
}

/** The document a new page document replaced, from the swap field the rebuild wrote. */
export function swappedDocuments(notebook: object): Array<{ replacement: string; replaced: string }> {
  const swaps: Array<{ replacement: string; replaced: string }> = [];
  for (const [key, value] of Object.entries(notebook as Record<string, unknown>)) {
    if (key.startsWith(SWAP_PREFIX) && typeof value === 'string') {
      swaps.push({ replacement: key.slice(SWAP_PREFIX.length), replaced: value });
    }
  }
  return swaps;
}

/**
 * The id of the document that replaces `documentId`: the same id with a generation suffix, so the
 * page id (which is what routes, pins and sub-pages refer to) does not change. Repeated rebuilds
 * count up.
 */
export function nextGenerationDocumentId(documentId: string): string {
  const match = /^(.*)~r(\d+)$/.exec(documentId);
  return match ? `${match[1]}~r${Number(match[2]) + 1}` : `${documentId}~r1`;
}
