/**
 * Typing in a text block only splices the block's text; unlike an element
 * change it did not move the page's `updatedAt`, so "recently changed" lists
 * (summaries are derived from `updatedAt`) kept showing the time of the last
 * other change, and a page written in looked untouched. A typed edit stamps
 * the page too.
 *
 * A stamp is at most every few seconds: each stamp changes the page summary
 * and with it the workspace state every list renders from, and the lists show
 * minutes, not seconds. The first edit of a page always stamps, so "never
 * touched" (`updatedAt === createdAt`) stays a reliable test.
 */
export const TEXT_EDIT_STAMP_INTERVAL_MS = 5_000;

/** The change message of a typed edit; repairs of old content use their own messages and stamp nothing. */
export const RICH_TEXT_EDIT_MESSAGE = 'Edit rich text';

export function stampTextEdit(page: { createdAt: string; updatedAt: string }, nowMs: number = Date.now()): void {
  const last = Date.parse(page.updatedAt);
  const untouched = page.updatedAt === page.createdAt;
  if (!untouched && Number.isFinite(last) && nowMs >= last && nowMs - last < TEXT_EDIT_STAMP_INTERVAL_MS) return;
  // Never the same value as before, or an edit within the creating millisecond would still read as untouched.
  page.updatedAt = new Date(nowMs === last ? nowMs + 1 : nowMs).toISOString();
}
