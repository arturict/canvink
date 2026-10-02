import { describe, expect, it } from "vitest";
import { createNotebookAutomergeDoc, saveAutomergeDocument } from "../crdt";
import type { NotebookDoc } from "../domain/v2";
import type { V2ActivationRecord } from "../storage/v2WorkspaceStorage";
import { summarizePage, type PageSummary } from "../storage/pageIndex";
import { projectSpacePlan, toDecodedNotebook } from "./manifestProjection";
import type { SpaceWorkspaceDocV1 } from "./contract";

const TIME = "2026-09-02T08:00:00.000Z";

function notebookBytes(documentId: string, pageDocumentIds: string[]): Uint8Array {
  const notebook: NotebookDoc = {
    schemaVersion: 2,
    documentId,
    kind: "notebook",
    notebookId: documentId.replace("notebook:", ""),
    title: "Remote notebook",
    color: "#123456",
    createdAt: TIME,
    updatedAt: TIME,
    sections: [{
      id: "section-1",
      title: "Section",
      createdAt: TIME,
      updatedAt: TIME,
      pageDocumentIds,
    }],
    settings: { defaultPageType: "a4" },
    version: { protocol: "uninitialized", heads: [] },
  };
  return saveAutomergeDocument(createNotebookAutomergeDoc(notebook));
}

function emptyDoc(): SpaceWorkspaceDocV1 {
  return { v: 1, notebooks: {}, pages: {}, assets: {} };
}

function activation(overrides: Partial<V2ActivationRecord> = {}): V2ActivationRecord {
  return {
    version: 1,
    schemaVersion: 3,
    format: "canvink-automerge-v3",
    migrationId: "migration-1",
    sourceFingerprint: "sha256:source",
    artifactFingerprint: "sha256:artifact",
    activatedAt: TIME,
    manifest: {
      schemaVersion: 3,
      format: "canvink-schema-v3",
      upgrade: {
        name: "workspace-v2-to-v3",
        version: 1,
        upgradeId: "upgrade-1",
        sourceArtifactFingerprint: "sha256:source",
        preparedAt: TIME,
      },
      active: { notebookId: "local", sectionId: "local-section", pageId: "local-page" },
      notebookDocumentIds: [],
      pageDocumentIds: [],
      assetIds: [],
      trash: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    documents: [],
    chunks: [],
    assetIds: [],
    ...overrides,
  };
}

describe("projectSpacePlan", () => {
  it("defers a notebook whose bytes are available but whose referenced page's bytes are not (rule 2)", () => {
    const bytes = notebookBytes("notebook:remote", ["page:remote-1"]);
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:remote": { order: "a0", addedAt: TIME } },
      pages: { "page:remote-1": { notebookDocumentId: "notebook:remote", addedAt: TIME } },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map([["notebook:remote", bytes]]),
      activation: activation(),
    });
    // Neither the notebook nor the page is adopted this round: the notebook's own page
    // reference is not yet satisfiable, and adopting it anyway would produce a dangling
    // reference that fails `validateWorkspaceGraph`.
    expect(plan.adoptedDocuments).toEqual([]);
    expect(plan.notebookDocumentIds).toEqual([]);
  });

  it("adopts both notebook and page once both byte sets are available", () => {
    const bytes = notebookBytes("notebook:remote", ["page:remote-1"]);
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:remote": { order: "a0", addedAt: TIME } },
      pages: { "page:remote-1": { notebookDocumentId: "notebook:remote", addedAt: TIME } },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map([
        ["notebook:remote", bytes],
        ["page:remote-1", new Uint8Array([1, 2, 3])],
      ]),
      activation: activation(),
    });
    const ids = plan.adoptedDocuments.map((d) => d.documentId).sort();
    expect(ids).toEqual(["notebook:remote", "page:remote-1"]);
    expect(plan.notebookDocumentIds).toEqual(["notebook:remote"]);
    expect(plan.pageDocumentIds).toContain("page:remote-1");
  });

  it("takes a notebook that was decoded elsewhere instead of loading its bytes", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:remote": { order: "a0", addedAt: TIME } },
      pages: { "page:remote-1": { notebookDocumentId: "notebook:remote", addedAt: TIME } },
    };
    // Bytes that no document load would accept: the plan can only get the notebook from the decoded map.
    const unreadable = new Uint8Array([9, 9, 9]);
    const remoteDocBytes = new Map([["notebook:remote", unreadable], ["page:remote-1", new Uint8Array([1, 2, 3])]]);
    const without = projectSpacePlan({ workspaceDoc, remoteDocBytes, activation: activation() });
    expect(without.adoptedDocuments).toEqual([]);
    const decoded = toDecodedNotebook({
      notebookId: "remote",
      sections: [{ id: "section-1", pageDocumentIds: ["page:remote-1"] }],
    } as Parameters<typeof toDecodedNotebook>[0]);
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes,
      activation: activation(),
      decodedNotebooks: new Map([["notebook:remote", decoded]]),
    });
    expect(plan.adoptedDocuments.map((doc) => doc.documentId).sort()).toEqual(["notebook:remote", "page:remote-1"]);
    expect(plan.notebookDocumentIds).toEqual(["notebook:remote"]);
  });

  it("defers a page whose notebook is missing, and adopts it once the notebook becomes available (retry)", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:remote": { order: "a0", addedAt: TIME } },
      pages: { "page:remote-1": { notebookDocumentId: "notebook:remote", addedAt: TIME } },
    };
    // Round 1: only the page's bytes are available, not the notebook's.
    const round1 = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map([["page:remote-1", new Uint8Array([1])]]),
      activation: activation(),
    });
    expect(round1.adoptedDocuments).toEqual([]);

    // Round 2: the notebook's bytes have since arrived too.
    const bytes = notebookBytes("notebook:remote", ["page:remote-1"]);
    const round2 = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map([
        ["notebook:remote", bytes],
        ["page:remote-1", new Uint8Array([1])],
      ]),
      activation: activation(),
    });
    expect(round2.adoptedDocuments.map((d) => d.documentId).sort()).toEqual(["notebook:remote", "page:remote-1"]);
  });

  it("emits removedDocumentIds for a purged, locally-present entry", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:local": { order: "a0", addedAt: TIME, purgedAt: "2026-09-02T10:00:00.000Z" } },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map(),
      activation: activation({
        documents: [{ documentId: "notebook:local", kind: "notebook", url: "automerge:x", heads: [] }],
      }),
    });
    expect(plan.removedDocumentIds).toEqual(["notebook:local"]);
  });

  it("orders notebooks by (order, documentId) and appends purely-local notebooks", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: {
        "notebook:b": { order: "a1", addedAt: TIME },
        "notebook:a": { order: "a0", addedAt: TIME },
      },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map(),
      activation: activation({
        documents: [
          { documentId: "notebook:a", kind: "notebook", url: "automerge:a", heads: [] },
          { documentId: "notebook:b", kind: "notebook", url: "automerge:b", heads: [] },
          { documentId: "notebook:local-only", kind: "notebook", url: "automerge:c", heads: [] },
        ],
        manifest: {
          ...activation().manifest,
          notebookDocumentIds: ["notebook:a", "notebook:b", "notebook:local-only"],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    });
    expect(plan.notebookDocumentIds).toEqual(["notebook:a", "notebook:b", "notebook:local-only"]);
  });

  it("emits a trash addition for a soft-deleted, locally-present entry not yet in local trash", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:local": { order: "a0", addedAt: TIME, deletedAt: "2026-09-02T10:00:00.000Z" } },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map(),
      activation: activation({
        documents: [{ documentId: "notebook:local", kind: "notebook", url: "automerge:x", heads: [] }],
      }),
    });
    expect(plan.trashAdditions).toEqual([
      { documentId: "notebook:local", kind: "notebook", deletedAt: "2026-09-02T10:00:00.000Z" },
    ]);
  });

  it("does not duplicate a trash addition already recorded locally", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:local": { order: "a0", addedAt: TIME, deletedAt: "2026-09-02T10:00:00.000Z" } },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map(),
      activation: activation({
        documents: [{ documentId: "notebook:local", kind: "notebook", url: "automerge:x", heads: [] }],
        manifest: {
          ...activation().manifest,
          trash: [{
            id: "trash-1", kind: "notebook", deletedAt: "2026-09-02T10:00:00.000Z", origin: {},
            notebookDocumentId: "notebook:local",
          }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    });
    expect(plan.trashAdditions).toEqual([]);
  });

  it("emits a trash removal (restore) when deletedAt was cleared remotely", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:local": { order: "a0", addedAt: TIME } },
    };
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map(),
      activation: activation({
        documents: [{ documentId: "notebook:local", kind: "notebook", url: "automerge:x", heads: [] }],
        manifest: {
          ...activation().manifest,
          trash: [{
            id: "trash-1", kind: "notebook", deletedAt: "2026-09-02T09:00:00.000Z", origin: {},
            notebookDocumentId: "notebook:local",
          }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    });
    expect(plan.trashRemovals).toEqual(["notebook:local"]);
  });

  it("is total and deterministic for empty inputs", () => {
    const plan = projectSpacePlan({
      workspaceDoc: emptyDoc(),
      remoteDocBytes: new Map(),
      activation: activation(),
    });
    expect(plan).toEqual({
      adoptedDocuments: [],
      placeholderPages: [],
      removedDocumentIds: [],
      notebookDocumentIds: [],
      pageDocumentIds: [],
      trashAdditions: [],
      trashRemovals: [],
    });
  });

  it("is pure: the same inputs always produce the same plan", () => {
    const workspaceDoc: SpaceWorkspaceDocV1 = {
      ...emptyDoc(),
      notebooks: { "notebook:local": { order: "a0", addedAt: TIME } },
    };
    const input = {
      workspaceDoc,
      remoteDocBytes: new Map<string, Uint8Array>(),
      activation: activation({
        documents: [{ documentId: "notebook:local", kind: "notebook" as const, url: "automerge:x", heads: [] }],
      }),
    };
    expect(projectSpacePlan(input)).toEqual(projectSpacePlan(input));
  });

  describe("placeholder pages", () => {
    function summaryOf(documentId: string, overrides: Partial<PageSummary> = {}): PageSummary {
      const pageId = documentId.replace("page:", "");
      return {
        ...summarizePage({
          documentId, pageId, notebookId: "remote", sectionId: "section-1", title: `Title of ${pageId}`,
          tags: ["tag"], pageType: "a4", background: { type: "grid", color: "#ffffff" },
          createdAt: TIME, updatedAt: TIME, schemaVersion: 3,
        }, ["a".repeat(64)]),
        ...overrides,
      };
    }

    function publishedDoc(): SpaceWorkspaceDocV1 {
      return {
        ...emptyDoc(),
        notebooks: { "notebook:remote": { order: "a0", addedAt: TIME } },
        pages: {
          "page:one": { notebookDocumentId: "notebook:remote", addedAt: TIME, summary: summaryOf("page:one") },
          "page:two": { notebookDocumentId: "notebook:remote", addedAt: TIME, summary: summaryOf("page:two") },
        },
      };
    }

    it("adopts the notebook and lists pages that have a summary but no bytes as placeholders", () => {
      const plan = projectSpacePlan({
        workspaceDoc: publishedDoc(),
        remoteDocBytes: new Map([["notebook:remote", notebookBytes("notebook:remote", ["page:one", "page:two"])]]),
        activation: activation(),
      });
      expect(plan.adoptedDocuments.map((doc) => doc.documentId)).toEqual(["notebook:remote"]);
      expect(plan.placeholderPages.map((page) => page.documentId).sort()).toEqual(["page:one", "page:two"]);
      expect(plan.placeholderPages[0]?.summary.title).toMatch(/^Title of/);
      expect(plan.pageDocumentIds.sort()).toEqual(["page:one", "page:two"]);
    });

    it("keeps a notebook back when a page it lists has neither bytes nor a summary", () => {
      const workspaceDoc = publishedDoc();
      delete workspaceDoc.pages["page:two"]!.summary;
      const plan = projectSpacePlan({
        workspaceDoc,
        remoteDocBytes: new Map([["notebook:remote", notebookBytes("notebook:remote", ["page:one", "page:two"])]]),
        activation: activation(),
      });
      expect(plan.adoptedDocuments).toEqual([]);
      expect(plan.placeholderPages.map((page) => page.documentId)).toEqual([]);
    });

    it("does not list a page by a summary that disagrees with the notebook's section", () => {
      const workspaceDoc = publishedDoc();
      workspaceDoc.pages["page:one"]!.summary = summaryOf("page:one", { sectionId: "somewhere-else" });
      const plan = projectSpacePlan({
        workspaceDoc,
        remoteDocBytes: new Map([
          ["notebook:remote", notebookBytes("notebook:remote", ["page:one", "page:two"])],
          ["page:one", new Uint8Array([1])],
        ]),
        activation: activation(),
      });
      expect(plan.placeholderPages.map((page) => page.documentId)).toEqual(["page:two"]);
      expect(plan.adoptedDocuments.map((doc) => doc.documentId).sort()).toEqual(["notebook:remote", "page:one"]);
    });

    it("adopts downloaded bytes in place of a placeholder and removes the placeholder in the same plan", () => {
      const placeholder = activation({
        documents: [
          { documentId: "notebook:remote", kind: "notebook", url: "automerge:n", heads: ["c".repeat(64)] },
          { documentId: "page:one", kind: "page", url: "automerge:x", heads: ["a".repeat(64)] },
        ],
        manifest: { ...activation().manifest, notebookDocumentIds: ["notebook:remote"], pageDocumentIds: ["page:one"] },
      });
      const plan = projectSpacePlan({
        workspaceDoc: publishedDoc(),
        remoteDocBytes: new Map([["page:one", new Uint8Array([9, 9])]]),
        activation: placeholder,
        placeholderDocumentIds: new Set(["page:one"]),
      });
      expect(plan.adoptedDocuments.map((doc) => doc.documentId)).toEqual(["page:one"]);
      expect(plan.adoptedDocuments[0]?.expectedSummary?.title).toBe("Title of one");
      expect(plan.removedDocumentIds).toEqual(["page:one"]);
      expect(plan.pageDocumentIds).toContain("page:one");
    });

    it("leaves a placeholder alone while its bytes have not arrived", () => {
      const placeholder = activation({
        documents: [
          { documentId: "notebook:remote", kind: "notebook", url: "automerge:n", heads: ["c".repeat(64)] },
          { documentId: "page:one", kind: "page", url: "automerge:x", heads: ["a".repeat(64)] },
        ],
        manifest: { ...activation().manifest, notebookDocumentIds: ["notebook:remote"], pageDocumentIds: ["page:one"] },
      });
      const plan = projectSpacePlan({
        workspaceDoc: publishedDoc(),
        remoteDocBytes: new Map(),
        activation: placeholder,
        placeholderDocumentIds: new Set(["page:one"]),
      });
      expect(plan.adoptedDocuments).toEqual([]);
      // Only the page the device does not know at all is listed; the existing placeholder stays as it is.
      expect(plan.placeholderPages.map((page) => page.documentId)).toEqual(["page:two"]);
      expect(plan.removedDocumentIds).toEqual([]);
      expect(plan.pageDocumentIds).toContain("page:one");
    });
  });
});
