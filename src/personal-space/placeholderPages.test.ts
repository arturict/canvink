/**
 * Placeholder pages against a real `WorkspaceV2Runtime`: a page the account lists by its
 * published summary while this device does not hold its document yet.
 */

import { describe, expect, it, vi } from "vitest";
import { createAutomergeDocument, saveAutomergeDocument } from "../crdt";
import type { WorkspaceState } from "../domain/types";
import type { PageDocV3 } from "../domain/v3";
import type { RecoveryDraft } from "../storage/recoveryJournal";
import { summarizePage, type PageSummary } from "../storage/pageIndex";
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from "../storage/v2WorkspaceStorage";
import { MemoryWorkspaceStore, memoryRepoFactory } from "../storage/testing/memoryWorkspaceStore";
import { PageNotDownloadedError, WorkspaceV2Runtime } from "../storage/workspaceV2Runtime";
import * as Automerge from "@automerge/automerge";

const TIME = "2026-09-02T08:00:00.000Z";

function workspace(): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [{
      id: "notebook-1",
      title: "School",
      color: "#123456",
      createdAt: TIME,
      updatedAt: TIME,
      sections: [{
        id: "section-1",
        title: "Physics",
        createdAt: TIME,
        updatedAt: TIME,
        pages: [{ id: "page-1", title: "Vectors", mode: "a4", createdAt: TIME, updatedAt: TIME, elements: [] }],
      }],
    }],
    trash: [],
    activeNotebookId: "notebook-1",
    activeSectionId: "section-1",
    activePageId: "page-1",
  };
}

class MemorySource implements V1WorkspaceMigrationSource {
  async loadWorkspace() {
    return { workspace: structuredClone(workspace()), backend: "indexeddb" as const };
  }

  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return null;
  }
}

function remotePageDocument(title: string): PageDocV3 {
  return {
    schemaVersion: 3, documentId: "page:remote", kind: "page", notebookId: "notebook-1",
    sectionId: "section-1", pageId: "remote", title, tags: ["physics"], pageType: "a4",
    background: { type: "grid", color: "#ffffff" }, createdAt: TIME, updatedAt: TIME,
    elementsById: {}, zOrder: [], version: { protocol: "uninitialized", heads: [] },
  };
}

/** The page's bytes and the summary a device holding it would publish. */
function remotePage(title: string): { bytes: Uint8Array; summary: PageSummary } {
  const bytes = saveAutomergeDocument(createAutomergeDocument(remotePageDocument(title)));
  return { bytes, summary: summarizePage(remotePageDocument(title), Automerge.getHeads(Automerge.load(bytes))) };
}

async function startedRuntime() {
  const store = new MemoryWorkspaceStore();
  const source = new MemorySource();
  const activationStore = new BrowserV2WorkspaceActivationStore(store);
  await new V2WorkspaceMigrationOrchestrator(
    source,
    activationStore,
    new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(),
    { now: () => TIME },
  ).run();
  const createRuntime = (startPageId?: () => string | undefined) => new WorkspaceV2Runtime({
    source,
    ...(startPageId ? { startPageId } : {}),
    activationStore,
    repoFactory: memoryRepoFactory(store),
    acquireWriteAccess: vi.fn(async () => "indexeddb" as const),
  });
  const runtime = createRuntime();
  await runtime.startup();
  const state = await runtime.ensureSchemaV3();
  if (state.schemaVersion !== 3) throw new Error("Expected schema v3.");
  return { createRuntime, runtime, state };
}

async function listPlaceholder(runtime: WorkspaceV2Runtime, summary: PageSummary) {
  const state = runtime.getState();
  if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
  return runtime.commitWorkspaceGraphRevision({
    operationId: "list-remote-page",
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
    message: "List a page by its summary",
    placeholderPages: [{ documentId: "page:remote", summary }],
    // The notebook lists the page, as it does once it arrives from the account.
    changes: [{
      documentId: "notebook:notebook-1",
      change: (document) => {
        if (document.kind !== "notebook") throw new Error("Expected notebook.");
        document.sections[0].pageDocumentIds.push("page:remote");
      },
    }],
    updateManifest: (manifest) => { manifest.pageDocumentIds.push("page:remote"); },
  });
}

describe("placeholder pages", () => {
  it("lists the page with its summary without storing a document, and keeps that across a restart", async () => {
    const { createRuntime, runtime } = await startedRuntime();
    const { summary } = remotePage("Remote title");
    const next = await listPlaceholder(runtime, summary);
    expect(next.pages.map((page) => page.title)).toContain("Remote title");
    expect(runtime.isDocumentAvailable("page:remote")).toBe(false);
    expect(runtime.listPlaceholderDocuments()).toEqual(["page:remote"]);
    expect(runtime.listDocuments().map((document) => document.documentId)).not.toContain("page:remote");
    expect(runtime.getDocumentHeads("page:remote")).toBeUndefined();
    expect(runtime.getPageSummary("remote")?.tags).toEqual(["physics"]);

    const reopened = createRuntime();
    const state = await reopened.startup();
    if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
    expect(state.pages.map((page) => page.title)).toContain("Remote title");
    expect(reopened.listPlaceholderDocuments()).toEqual(["page:remote"]);
    expect(reopened.isDocumentAvailable("page:1")).toBe(false);
  });

  it("refuses to read a placeholder page when nothing can download it", async () => {
    const { runtime } = await startedRuntime();
    await listPlaceholder(runtime, remotePage("Remote title").summary);
    await expect(runtime.readPage("remote", (page) => page.title)).rejects.toBeInstanceOf(PageNotDownloadedError);
    await expect(runtime.loadPage("remote")).rejects.toBeInstanceOf(PageNotDownloadedError);
    expect(runtime.isPageLoaded("remote")).toBe(false);
  });

  it("downloads the page on the first read through the content source and stores it", async () => {
    const { createRuntime, runtime } = await startedRuntime();
    const page = remotePage("Remote title");
    await listPlaceholder(runtime, page.summary);
    const requested: string[] = [];
    runtime.setDocumentContentSource({
      request: (documentId) => {
        requested.push(documentId);
        // The download arrives later, as the sync layer's catch-up commit: the bytes replace the placeholder.
        setTimeout(() => {
          const state = runtime.getState();
          if (state.schemaVersion === 1) return;
          void runtime.commitWorkspaceGraphRevision({
            operationId: "download-remote-page",
            expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
            message: "Adopt the downloaded page",
            adoptedDocuments: [{ documentId, kind: "page", bytes: page.bytes, expectedSummary: page.summary }],
            removedDocumentIds: [documentId],
          });
        }, 5);
      },
    });

    const title = await runtime.readPage("remote", (document) => document.title);
    expect(title).toBe("Remote title");
    expect(requested).toEqual(["page:remote"]);
    expect(runtime.isDocumentAvailable("page:remote")).toBe(true);
    expect(runtime.listPlaceholderDocuments()).toEqual([]);
    expect(runtime.listDocuments().map((document) => document.documentId)).toContain("page:remote");

    const reopened = createRuntime();
    await reopened.startup();
    expect(reopened.listPlaceholderDocuments()).toEqual([]);
    expect(await reopened.readPage("remote", (document) => document.title)).toBe("Remote title");
  });

  it("opening a placeholder page waits for its download and makes it the active page", async () => {
    const { runtime } = await startedRuntime();
    const page = remotePage("Remote title");
    await listPlaceholder(runtime, page.summary);
    runtime.setDocumentContentSource({
      request: (documentId) => {
        setTimeout(() => {
          const state = runtime.getState();
          if (state.schemaVersion === 1) return;
          void runtime.commitWorkspaceGraphRevision({
            operationId: "download-for-navigation",
            expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
            message: "Adopt the downloaded page",
            adoptedDocuments: [{ documentId, kind: "page", bytes: page.bytes }],
            removedDocumentIds: [documentId],
          });
        }, 5);
      },
    });
    const context = await runtime.navigateTo({ notebookId: "notebook-1", sectionId: "section-1", pageId: "remote" });
    expect(context.page.title).toBe("Remote title");
  });

  it("does not let a commit leave the workspace on a page it only lists", async () => {
    const { runtime } = await startedRuntime();
    const page = remotePage("Remote title");
    await listPlaceholder(runtime, page.summary);
    const state = runtime.getState();
    if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
    const next = await runtime.commitWorkspaceGraphRevision({
      operationId: "point-at-placeholder",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Point the manifest's active page at a placeholder",
      updateManifest: (manifest) => { manifest.active = { notebookId: "notebook-1", sectionId: "section-1", pageId: "remote" }; },
    }).catch((error: unknown) => error as Error);
    // Either the commit was refused or the view stayed on a page that is stored.
    if (next instanceof Error) return;
    expect(runtime.isPageLoaded(next.active.pageId)).toBe(true);
  });

  it("rejects a placeholder whose summary does not match the document id", async () => {
    const { runtime } = await startedRuntime();
    const { summary } = remotePage("Remote title");
    const state = runtime.getState();
    if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
    await expect(runtime.commitWorkspaceGraphRevision({
      operationId: "bad-placeholder",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Bad placeholder",
      placeholderPages: [{ documentId: "page:other", summary }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push("page:other"); },
    })).rejects.toThrow(/no usable summary/);
  });

  it("fails at once, with the page's id, when the source cannot download it (offline)", async () => {
    const { runtime } = await startedRuntime();
    await listPlaceholder(runtime, remotePage("Remote title").summary);
    runtime.setDocumentContentSource({ request: () => { throw new Error("offline"); } });
    const started = Date.now();
    await expect(runtime.readPage("remote", (page) => page.title)).rejects.toBeInstanceOf(PageNotDownloadedError);
    await expect(runtime.navigateTo({ notebookId: "notebook-1", sectionId: "section-1", pageId: "remote" }))
      .rejects.toBeInstanceOf(PageNotDownloadedError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops a waiting reader when the download is abandoned, and keeps every stored page editable", async () => {
    const { runtime } = await startedRuntime();
    await listPlaceholder(runtime, remotePage("Remote title").summary);
    runtime.setDocumentContentSource({ request: (documentId) => { setTimeout(() => runtime.abandonContentRequest(documentId, "dropped"), 5); } });
    await expect(runtime.readPage("remote", (page) => page.title)).rejects.toBeInstanceOf(PageNotDownloadedError);
    await runtime.changePage("page-1", { message: "Edit offline" }, (page) => { page.title = "Edited offline"; });
    expect(await runtime.readPage("page-1", (page) => page.title)).toBe("Edited offline");
    await runtime.flush();
  });

  it("does not wait for a download when a revision changes a page that is only listed", async () => {
    const { runtime } = await startedRuntime();
    await listPlaceholder(runtime, remotePage("Remote title").summary);
    runtime.setDocumentContentSource({ request: () => { throw new Error("offline"); } });
    const state = runtime.getState();
    if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
    await expect(runtime.commitWorkspaceGraphRevision({
      operationId: "change-placeholder",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Change a page that is not here",
      changes: [{ documentId: "page:remote", change: () => undefined }],
    })).rejects.toBeInstanceOf(PageNotDownloadedError);
  });

  it("starts on a stored page when the last viewed page is only listed", async () => {
    const { createRuntime, runtime } = await startedRuntime();
    await listPlaceholder(runtime, remotePage("Remote title").summary);
    const reopened = createRuntime(() => "remote");
    const state = await reopened.startup();
    if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
    expect(state.active.pageId).toBe("page-1");
    expect(reopened.getActiveContext().page.title).toBe("Vectors");
  });

  it("commits with work that does not grow with the pages the activation already lists", async () => {
    const { runtime } = await startedRuntime();
    const listMany = async (operationId: string, ids: string[]) => {
      const state = runtime.getState();
      if (state.schemaVersion === 1) throw new Error("Expected a v2/v3 workspace.");
      await runtime.commitWorkspaceGraphRevision({
        operationId,
        expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
        message: "List pages by their summaries",
        placeholderPages: ids.map((id) => ({
          documentId: `page:${id}`,
          summary: summarizePage({ ...remotePageDocument(`Seite ${id}`), documentId: `page:${id}`, pageId: id }, [`${id}`.padStart(64, "a")]),
        })),
        changes: [{
          documentId: "notebook:notebook-1",
          change: (document) => {
            if (document.kind !== "notebook") throw new Error("Expected notebook.");
            for (const id of ids) document.sections[0].pageDocumentIds.push(`page:${id}`);
          },
        }],
        updateManifest: (manifest) => { for (const id of ids) manifest.pageDocumentIds.push(`page:${id}`); },
      });
    };
    await listMany("list-many", Array.from({ length: 150 }, (_, index) => `many-${index}`));
    expect(runtime.listPlaceholderDocuments()).toHaveLength(150);

    // One more page: the commit may copy what it changes, not the entry of every page already listed.
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await listMany("list-one-more", ["one-more"]);
      expect(runtime.listPlaceholderDocuments()).toHaveLength(151);
      expect(clone.mock.calls.length).toBeLessThan(40);
    } finally {
      clone.mockRestore();
    }
  });
});
