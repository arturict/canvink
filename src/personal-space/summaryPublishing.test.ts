import * as Automerge from "@automerge/automerge";
import { describe, expect, it } from "vitest";
import { parsePublishedSummary, summarizePage, type PageSummary } from "../storage/pageIndex";
import type { SpaceWorkspaceDocV1 } from "./contract";
import { publishedText, publishSummaries, SUMMARY_REFRESH_MS, summariesToPublish } from "./summaryPublishing";
import { initWorkspaceDoc } from "./workspaceDoc";

const TIME = "2026-09-02T08:00:00.000Z";

function summary(overrides: Partial<PageSummary> = {}): PageSummary {
  return {
    ...summarizePage({
      documentId: "page:one", pageId: "one", notebookId: "n", sectionId: "s", title: "One", tags: ["a"],
      pageType: "a4", background: { type: "grid", color: "#fff" }, createdAt: TIME, updatedAt: TIME, schemaVersion: 3,
    }, ["b".repeat(64)]),
    ...overrides,
  };
}

function docWith(summaries: PageSummary[]): Automerge.Doc<SpaceWorkspaceDocV1> {
  return Automerge.change(initWorkspaceDoc(), (doc) => {
    for (const entry of summaries) doc.pages[entry.documentId] = { notebookDocumentId: "notebook:n", addedAt: TIME };
  });
}

describe("summary publishing", () => {
  it("publishes a summary the page entry lacks, and the round trip is what a fresh device reads", () => {
    const local = summary();
    const doc = docWith([local]);
    expect(summariesToPublish(doc, [local])).toEqual([local]);
    const published = Automerge.change(doc, publishSummaries([local]));
    expect(summariesToPublish(published, [local])).toEqual([]);
    expect(parsePublishedSummary(published.pages["page:one"]?.summary, "page:one")?.title).toBe("One");
    expect(parsePublishedSummary(published.pages["page:one"]?.summary, "page:one")?.tags).toEqual(["a"]);
    const reloaded = Automerge.load<SpaceWorkspaceDocV1>(Automerge.save(published));
    expect(parsePublishedSummary(reloaded.pages["page:one"]?.summary, "page:one")?.heads).toEqual(["b".repeat(64)]);
  });

  it("publishes again when a field the sidebar shows changed", () => {
    const local = summary();
    const published = Automerge.change(docWith([local]), publishSummaries([local]));
    expect(summariesToPublish(published, [summary({ title: "Renamed" })])).toHaveLength(1);
    expect(summariesToPublish(published, [summary({ tags: ["a", "b"] })])).toHaveLength(1);
    expect(summariesToPublish(published, [summary({ sectionId: "other" })])).toHaveLength(1);
  });

  it("lets edits that only advance the heads and updatedAt wait for the refresh interval", () => {
    const local = summary();
    const published = Automerge.change(docWith([local]), publishSummaries([local]));
    const soon = new Date(Date.parse(TIME) + 60_000).toISOString();
    const later = new Date(Date.parse(TIME) + SUMMARY_REFRESH_MS + 1_000).toISOString();
    expect(summariesToPublish(published, [summary({ updatedAt: soon, heads: ["c".repeat(64)] })])).toEqual([]);
    expect(summariesToPublish(published, [summary({ updatedAt: later, heads: ["c".repeat(64)] })])).toHaveLength(1);
  });

  it("leaves the asset references out of the published summary and never republishes because of them", () => {
    const local = summary({ assets: [{ assetId: "sha256:aa", mimeType: "image/png" }] });
    const published = Automerge.change(docWith([local]), publishSummaries([local]));
    expect(String(published.pages["page:one"]?.summary)).not.toContain("assets");
    expect(summariesToPublish(published, [local])).toEqual([]);
    expect(summariesToPublish(published, [summary({ assets: [{ assetId: "sha256:bb", mimeType: "image/png" }] })])).toEqual([]);
  });

  it("replaces a published summary as one value and leaves an unchanged one untouched", () => {
    const local = summary();
    const first = Automerge.change(docWith([local]), publishSummaries([local]));
    const again = Automerge.change(first, publishSummaries([local]));
    expect(Automerge.getHeads(again)).toEqual(Automerge.getHeads(first));
    const renamed = summary({ title: "Renamed" });
    const second = Automerge.change(first, publishSummaries([renamed]));
    expect(parsePublishedSummary(second.pages["page:one"]?.summary, "page:one")?.title).toBe("Renamed");
    expect(parsePublishedSummary(second.pages["page:one"]?.summary, "page:one")?.tags).toEqual(["a"]);
  });

  it("still reads a summary that an older build published as a map of fields", () => {
    const local = summary();
    const legacy = Automerge.change(docWith([local]), (doc) => {
      doc.pages["page:one"]!.summary = JSON.parse(JSON.stringify(local)) as PageSummary;
    });
    expect(summariesToPublish(legacy, [local])).toEqual([]);
    const upgraded = Automerge.change(legacy, publishSummaries([summary({ title: "Renamed" })]));
    expect(parsePublishedSummary(upgraded.pages["page:one"]?.summary, "page:one")?.title).toBe("Renamed");
  });

  it("keeps the workspace document of a large account smaller than nested text fields would", () => {
    const pages = Array.from({ length: 120 }, (_, index) => summary({ documentId: `page:${index}`, pageId: `${index}`, title: `Seite ${index} mit einem längeren Titel` }));
    const base = Automerge.change(initWorkspaceDoc(), (doc) => {
      for (const entry of pages) doc.pages[entry.documentId] = { notebookDocumentId: "notebook:n", addedAt: TIME };
    });
    const published = Automerge.change(Automerge.clone(base), publishSummaries(pages));
    const nested = Automerge.change(Automerge.clone(base), (doc) => {
      for (const entry of pages) doc.pages[entry.documentId]!.summary = JSON.parse(publishedText(entry)) as PageSummary;
    });
    // Each character of a plain string is an operation of its own, and the time to load follows the operation count.
    expect(Automerge.save(published).byteLength).toBeLessThan(Automerge.save(nested).byteLength * 0.8);
  });

  it("skips pages the workspace document does not list or has purged", () => {
    const local = summary();
    expect(summariesToPublish(initWorkspaceDoc(), [local])).toEqual([]);
    const purged = Automerge.change(docWith([local]), (doc) => { doc.pages["page:one"]!.purgedAt = TIME; });
    expect(summariesToPublish(purged, [local])).toEqual([]);
    const written = Automerge.change(purged, publishSummaries([local]));
    expect(written.pages["page:one"]?.summary).toBeUndefined();
  });
});
