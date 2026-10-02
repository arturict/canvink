/**
 * Which page summaries a device publishes into the personal space's workspace
 * document. A summary is what a fresh device lists a page by before it holds
 * the page, so it has to be there for every page and follow the fields the
 * sidebar and search show. Edits that only advance `updatedAt` and the heads
 * are published at most every `SUMMARY_REFRESH_MS`, which keeps the workspace
 * document from growing with every keystroke.
 */

import { ImmutableString, isImmutableString } from '@automerge/automerge';
import { parsePublishedSummary, type PageSummary } from '../storage/pageIndex';
import type { SpaceWorkspaceDocV1 } from './contract';

export const SUMMARY_REFRESH_MS = 10 * 60_000;

function sameFields(left: PageSummary, right: PageSummary): boolean {
  // Undefined fields drop out of the JSON, which leaves what the sidebar shows. The asset references
  // are not published (see `publishedText`), so they never make a summary differ.
  const shown = (summary: PageSummary): string => JSON.stringify({ ...summary, heads: undefined, updatedAt: undefined, assets: undefined });
  return shown(left) === shown(right);
}

/** Summaries a device holding these pages should publish now: missing, changed, or stale in `updatedAt`. */
export function summariesToPublish(
  workspaceDoc: SpaceWorkspaceDocV1,
  local: readonly PageSummary[],
): PageSummary[] {
  const due: PageSummary[] = [];
  for (const summary of local) {
    const entry = workspaceDoc.pages[summary.documentId];
    if (!entry || entry.purgedAt) continue;
    const published = parsePublishedSummary(entry.summary, summary.documentId);
    if (!published || !sameFields(published, summary)) {
      due.push(summary);
      continue;
    }
    const drift = Date.parse(summary.updatedAt) - Date.parse(published.updatedAt);
    if (drift > SUMMARY_REFRESH_MS) due.push(summary);
  }
  return due;
}

/**
 * The JSON a summary is published as. The asset references are left out: a page's images,
 * printouts and ink segments make up most of a summary (a printout book lists hundreds), nothing
 * that lists or opens a page reads them from the workspace document, and every rewrite of them stays
 * in the document's history for good. A device that holds the page has them in its own page index.
 */
export function publishedText(summary: PageSummary): string {
  const { assets: _assets, ...published } = summary;
  void _assets;
  return JSON.stringify(published);
}

/**
 * Writes the summaries into the workspace document's page entries as one immutable string each
 * (see `parsePublishedSummary`); entries the document lacks are skipped, and a summary that is
 * already published as it is stays untouched.
 */
export function publishSummaries(summaries: readonly PageSummary[]): (doc: SpaceWorkspaceDocV1) => void {
  return (doc) => {
    for (const summary of summaries) {
      const entry = doc.pages[summary.documentId];
      if (!entry || entry.purgedAt) continue;
      const text = publishedText(summary);
      const current = entry.summary;
      if (isImmutableString(current) && current.toString() === text) continue;
      entry.summary = new ImmutableString(text);
    }
  };
}
