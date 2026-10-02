import * as Automerge from "@automerge/automerge";
import { describe, expect, it } from "vitest";
import { parsePublishedSummary } from "../storage/pageIndex";
import type { SpaceWorkspaceDocV1 } from "./contract";
import {
  addNotebook,
  addPage,
  createInitialWorkspaceDoc,
  initWorkspaceDoc,
  loadWorkspaceDoc,
  purge,
  recordAsset,
  reorderNotebook,
  restore,
  rewriteWorkspaceDoc,
  saveWorkspaceDoc,
  softDelete,
} from "./workspaceDoc";

const TIME = "2026-09-02T08:00:00.000Z";
const LATER = "2026-09-02T09:00:00.000Z";

describe("initWorkspaceDoc / save / load", () => {
  it("creates an empty v1 doc", () => {
    const doc = initWorkspaceDoc();
    expect(doc).toEqual({ v: 1, notebooks: {}, pages: {}, assets: {} });
  });

  it("round-trips through save/load", () => {
    const doc = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    const bytes = saveWorkspaceDoc(doc);
    const reloaded = loadWorkspaceDoc(bytes);
    expect(reloaded.notebooks).toEqual(doc.notebooks);
  });
});

describe("createInitialWorkspaceDoc", () => {
  it("seeds notebooks in the given order with ascending fractional keys, and their pages", () => {
    const doc = createInitialWorkspaceDoc({
      notebookDocumentIdsInOrder: ["notebook:a", "notebook:b"],
      notebooks: [
        { documentId: "notebook:a", pageDocumentIds: ["page:1", "page:2"] },
        { documentId: "notebook:b", pageDocumentIds: ["page:3"] },
      ],
      now: TIME,
    });
    expect(Object.keys(doc.notebooks)).toEqual(["notebook:a", "notebook:b"]);
    expect(doc.notebooks["notebook:a"].order < doc.notebooks["notebook:b"].order).toBe(true);
    expect(doc.notebooks["notebook:a"].addedAt).toBe(TIME);
    expect(doc.pages["page:1"]).toEqual({ notebookDocumentId: "notebook:a", addedAt: TIME });
    expect(doc.pages["page:3"]).toEqual({ notebookDocumentId: "notebook:b", addedAt: TIME });
  });

  it("skips a page whose notebook is not present in the seed input", () => {
    const doc = createInitialWorkspaceDoc({
      notebookDocumentIdsInOrder: ["notebook:a"],
      notebooks: [{ documentId: "notebook:a", pageDocumentIds: ["page:1"] }],
      now: TIME,
    });
    expect(doc.pages["page:orphan"]).toBeUndefined();
    expect(Object.keys(doc.pages)).toEqual(["page:1"]);
  });

  it("produces an empty doc for empty input", () => {
    const doc = createInitialWorkspaceDoc({ notebookDocumentIdsInOrder: [], notebooks: [], now: TIME });
    expect(doc.notebooks).toEqual({});
    expect(doc.pages).toEqual({});
  });
});

describe("addNotebook / addPage", () => {
  it("adds a fresh notebook entry", () => {
    const doc = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    expect(doc.notebooks["notebook:a"]).toEqual({ order: "a0", addedAt: TIME });
  });

  it("is idempotent: does not overwrite an existing entry, including a deleted one", () => {
    let doc = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    doc = Automerge.change(doc, softDelete("notebook", "notebook:a", LATER));
    doc = Automerge.change(doc, addNotebook("notebook:a", { order: "z9", addedAt: LATER }));
    expect(doc.notebooks["notebook:a"]).toEqual({ order: "a0", addedAt: TIME, deletedAt: LATER });
  });

  it("adds a fresh page entry and is idempotent", () => {
    let doc = Automerge.change(
      initWorkspaceDoc(),
      addPage("page:1", { notebookDocumentId: "notebook:a", addedAt: TIME }),
    );
    doc = Automerge.change(doc, addPage("page:1", { notebookDocumentId: "notebook:b", addedAt: LATER }));
    expect(doc.pages["page:1"]).toEqual({ notebookDocumentId: "notebook:a", addedAt: TIME });
  });
});

describe("softDelete / restore / purge (§6.3)", () => {
  function seeded(): Automerge.Doc<SpaceWorkspaceDocV1> {
    return Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
  }

  it("softDelete sets deletedAt without removing the entry", () => {
    const doc = Automerge.change(seeded(), softDelete("notebook", "notebook:a", LATER));
    expect(doc.notebooks["notebook:a"]).toMatchObject({ deletedAt: LATER });
  });

  it("restore clears deletedAt", () => {
    let doc = Automerge.change(seeded(), softDelete("notebook", "notebook:a", LATER));
    doc = Automerge.change(doc, restore("notebook", "notebook:a"));
    expect(doc.notebooks["notebook:a"].deletedAt).toBeUndefined();
  });

  it("purge sets purgedAt and is then permanent: neither softDelete nor restore change it further", () => {
    let doc = Automerge.change(seeded(), purge("notebook", "notebook:a", LATER));
    expect(doc.notebooks["notebook:a"].purgedAt).toBe(LATER);
    doc = Automerge.change(doc, restore("notebook", "notebook:a"));
    expect(doc.notebooks["notebook:a"].purgedAt).toBe(LATER);
    doc = Automerge.change(doc, softDelete("notebook", "notebook:a", "2027-01-01T00:00:00.000Z"));
    expect(doc.notebooks["notebook:a"].deletedAt).toBeUndefined();
  });

  it("is a no-op on a missing entry", () => {
    const before = seeded();
    const after = Automerge.change(before, softDelete("notebook", "notebook:does-not-exist", LATER));
    expect(after.notebooks).toEqual(before.notebooks);
  });

  it("works identically for pages", () => {
    let doc = Automerge.change(
      initWorkspaceDoc(),
      addPage("page:1", { notebookDocumentId: "notebook:a", addedAt: TIME }),
    );
    doc = Automerge.change(doc, softDelete("page", "page:1", LATER));
    expect(doc.pages["page:1"].deletedAt).toBe(LATER);
    doc = Automerge.change(doc, restore("page", "page:1"));
    expect(doc.pages["page:1"].deletedAt).toBeUndefined();
  });
});

describe("reorderNotebook", () => {
  it("rewrites the order scalar", () => {
    let doc = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    doc = Automerge.change(doc, reorderNotebook("notebook:a", "z9"));
    expect(doc.notebooks["notebook:a"].order).toBe("z9");
  });

  it("is a no-op on an already-purged notebook", () => {
    let doc = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    doc = Automerge.change(doc, purge("notebook", "notebook:a", LATER));
    doc = Automerge.change(doc, reorderNotebook("notebook:a", "z9"));
    expect(doc.notebooks["notebook:a"].order).toBe("a0");
  });

  it("concurrent reorders merge to one valid, deterministic order with no duplicate entries", () => {
    const base = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    const forkA = Automerge.change(Automerge.clone(base), reorderNotebook("notebook:a", "b0"));
    const forkB = Automerge.change(Automerge.clone(base), reorderNotebook("notebook:a", "c0"));
    const merged = Automerge.merge(Automerge.clone(forkA), forkB);
    expect(Object.keys(merged.notebooks)).toEqual(["notebook:a"]);
    expect(["b0", "c0"]).toContain(merged.notebooks["notebook:a"].order);
  });
});

describe("recordAsset", () => {
  it("adds a fresh asset entry", () => {
    const doc = Automerge.change(
      initWorkspaceDoc(),
      recordAsset("abc123", { size: 1024, mimeType: "image/png", addedAt: TIME }),
    );
    expect(doc.assets.abc123).toEqual({ size: 1024, mimeType: "image/png", addedAt: TIME });
  });

  it("is idempotent for the same content hash", () => {
    let doc = Automerge.change(
      initWorkspaceDoc(),
      recordAsset("abc123", { size: 1024, mimeType: "image/png", addedAt: TIME }),
    );
    doc = Automerge.change(doc, recordAsset("abc123", { size: 999, mimeType: "image/jpeg", addedAt: LATER }));
    expect(doc.assets.abc123).toEqual({ size: 1024, mimeType: "image/png", addedAt: TIME });
  });
});

describe("rewriteWorkspaceDoc", () => {
  function bloated(): Automerge.Doc<SpaceWorkspaceDocV1> {
    let doc = Automerge.change(initWorkspaceDoc(), addNotebook("notebook:a", { order: "a0", addedAt: TIME }));
    doc = Automerge.change(doc, addPage("page:one", { notebookDocumentId: "notebook:a", addedAt: TIME }));
    doc = Automerge.change(doc, recordAsset("sha256:aa", { size: 3, mimeType: "image/png", addedAt: TIME }));
    // A summary rewritten many times, as older builds did, with its asset references.
    for (let round = 0; round < 30; round += 1) {
      doc = Automerge.change(doc, (draft) => {
        draft.pages["page:one"]!.summary = {
          documentId: "page:one", pageId: "one", notebookId: "a", sectionId: "s", title: `Round ${round}`, tags: [],
          pageType: "free", background: { type: "grid" }, pageContentKind: "canvas", createdAt: TIME, updatedAt: TIME,
          schemaVersion: 3, heads: ["b".repeat(64)],
          assets: Array.from({ length: 40 }, (_, index) => ({ assetId: `sha256:${round}-${index}`, mimeType: "image/png" })),
        } as never;
      });
    }
    return doc;
  }

  it("keeps the state and drops the history and the published asset references", () => {
    const doc = bloated();
    const rewritten = rewriteWorkspaceDoc(doc);
    expect(rewritten.notebooks).toEqual(doc.notebooks);
    expect(rewritten.assets).toEqual(doc.assets);
    // A map of fields from an older build comes back as one immutable string of JSON.
    expect(Automerge.isImmutableString(rewritten.pages["page:one"]?.summary)).toBe(true);
    expect(parsePublishedSummary(rewritten.pages["page:one"]?.summary, "page:one")?.title).toBe("Round 29");
    expect(String(rewritten.pages["page:one"]?.summary)).not.toContain("assets");
    expect(Automerge.getAllChanges(rewritten)).toHaveLength(1);
    expect(saveWorkspaceDoc(rewritten).byteLength).toBeLessThan(saveWorkspaceDoc(doc).byteLength / 4);
    expect(loadWorkspaceDoc(saveWorkspaceDoc(rewritten)).pages).toEqual(rewritten.pages);
  });

  it("shares no history with the old document, so it replaces the room's copy and never merges into it", () => {
    const doc = bloated();
    const known = new Set(Automerge.getAllChanges(doc).map((change) => Automerge.decodeChange(change).hash));
    expect(Automerge.getHeads(rewriteWorkspaceDoc(doc)).some((head) => known.has(head))).toBe(false);
    const merged = Automerge.merge(Automerge.clone(doc), rewriteWorkspaceDoc(doc));
    expect(Automerge.getAllChanges(merged).length).toBe(Automerge.getAllChanges(doc).length + 1);
  });
});
