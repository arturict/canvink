/**
 * End-to-end personal-space tests against a real `WorkspaceV2Runtime`
 * (PERSONAL-SYNC.md §9 Wave 3 "Tests"). Unlike `manifestProjection.test.ts`
 * and `materialize.test.ts` (pure/fake-runtime unit tests), these exercise
 * the actual Repo + activation store, mirroring `workspaceV2Runtime.test.ts`'s
 * harness.
 */

import * as Automerge from "@automerge/automerge";
import { describe, expect, it, vi } from "vitest";
import { FakeRelay } from "../collab/testRelay";
import { createAutomergeDocument, saveAutomergeDocument, type LivePageDocV2 } from "../crdt";
import type { WorkspaceState } from "../domain/types";
import type { PageDocV3 } from "../domain/v3";
import type { RecoveryDraft } from "../storage/recoveryJournal";
import {
  BrowserV2WorkspaceActivationStore,
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  V2WorkspaceMigrationOrchestrator,
  type V1WorkspaceMigrationSource,
} from "../storage/v2WorkspaceStorage";
import { MemoryWorkspaceStore, memoryRepoFactory } from "../storage/testing/memoryWorkspaceStore";
import { WorkspaceV2Runtime } from "../storage/workspaceV2Runtime";
import { applySpacePlan } from "./materialize";
import { projectSpacePlan } from "./manifestProjection";
import { createRuntimeSpacePort } from "./runtimeSpacePort";
import { bindPersonalSpace, type PersonalSpaceBinding } from "./spaceBinding";
import { openPersonalSpaceSession, type PersonalSpaceSession } from "./spaceSession";
import { addNotebook, initWorkspaceDoc, softDelete } from "./workspaceDoc";
import type { SpaceWorkspaceDocV1 } from "./contract";

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
        pages: [
          { id: "page-1", title: "Vectors", mode: "a4", createdAt: TIME, updatedAt: TIME, elements: [] },
          { id: "page-2", title: "Forces", mode: "a4", createdAt: TIME, updatedAt: TIME, elements: [] },
        ],
      }],
    }],
    trash: [],
    activeNotebookId: "notebook-1",
    activeSectionId: "section-1",
    activePageId: "page-1",
  };
}

class MemorySource implements V1WorkspaceMigrationSource {
  loadCount = 0;

  constructor(private readonly value: WorkspaceState) {}

  async loadWorkspace() {
    this.loadCount += 1;
    return { workspace: structuredClone(this.value), backend: "indexeddb" as const };
  }

  async loadRecoveryDraft(): Promise<RecoveryDraft | null> {
    return null;
  }
}

function runtimeSetup(value = workspace(), store = new MemoryWorkspaceStore()) {
  const atomic = store;
  const source = new MemorySource(value);
  const activationStore = new BrowserV2WorkspaceActivationStore(atomic);
  const migrationFactory = () => new V2WorkspaceMigrationOrchestrator(
    source,
    activationStore,
    new InMemoryAutomergeRepoMigrationAdapter(),
    new DefaultAutomergeMigrationMaterializer(),
    { now: () => TIME },
  );
  const createRuntime = () => new WorkspaceV2Runtime({
    source,
    activationStore,
    repoFactory: memoryRepoFactory(atomic),
    migrationFactory,
    acquireWriteAccess: vi.fn(async () => "indexeddb" as const),
  });
  return { atomic, source, activationStore, createRuntime };
}

describe("personal-space integration: adoptedDocuments preserves Automerge history (regression)", () => {
  it("a document adopted via adoptedDocuments keeps its history so a later remote change merges cleanly, unlike newDocuments", async () => {
    const setup = runtimeSetup();
    await new V2WorkspaceMigrationOrchestrator(
      setup.source,
      setup.activationStore,
      new InMemoryAutomergeRepoMigrationAdapter(),
      new DefaultAutomergeMigrationMaterializer(),
      { now: () => TIME },
    ).run();
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error("Expected schema v3.");

    const originPage: PageDocV3 = {
      schemaVersion: 3, documentId: "page:origin", kind: "page", notebookId: "notebook-1",
      sectionId: "section-1", pageId: "origin", title: "Origin", tags: [], pageType: "a4",
      background: { type: "grid", color: "#ffffff" }, createdAt: TIME, updatedAt: TIME,
      elementsById: {}, zOrder: [], version: { protocol: "uninitialized", heads: [] },
    };
    const originAutomergeDoc = createAutomergeDocument(originPage);
    const b0 = saveAutomergeDocument(originAutomergeDoc);

    // The "remote device"'s real Automerge history: B0 -> B1 -> B2.
    const remoteAtB0 = Automerge.load<LivePageDocV2>(b0);
    const remoteAtB1 = Automerge.change(remoteAtB0, (doc) => { doc.title = "Remote edit 1"; });
    const b1 = Automerge.save(remoteAtB1);
    const remoteAtB2 = Automerge.change(remoteAtB1, (doc) => { doc.title = "Remote edit 2"; });
    const laterChanges = Automerge.getChanges(remoteAtB1, remoteAtB2);

    // --- Path A: adopt B1 with its history intact (adoptedDocuments). ---
    const adopted = await runtime.commitWorkspaceGraphRevision({
      operationId: "adopt-origin",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Adopt remote page",
      adoptedDocuments: [{ documentId: "page:origin", kind: "page", bytes: b1 }],
      changes: [{
        documentId: "notebook:notebook-1",
        change: (document) => {
          if (document.kind !== "notebook") throw new Error("Expected notebook.");
          document.sections[0].pageDocumentIds.push("page:origin");
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push("page:origin"); },
    });
    expect(adopted.schemaVersion).toBe(3);

    const adoptedBytes = await runtime.readPage("origin", (doc) => Automerge.save(doc));
    const adoptedDoc = Automerge.load<LivePageDocV2>(adoptedBytes);
    expect(Automerge.getHeads(adoptedDoc)).toEqual(expect.arrayContaining(Automerge.getHeads(remoteAtB1)));

    const [patchedAdopted] = Automerge.applyChanges(adoptedDoc, laterChanges);
    expect(patchedAdopted.title).toBe("Remote edit 2");

    // --- Path B: materialize the SAME remote content via newDocuments instead. ---
    const copyPage: PageDocV3 = { ...originPage, documentId: "page:origin-copy", pageId: "origin-copy", title: "Remote edit 1" };
    const materialized = await runtime.commitWorkspaceGraphRevision({
      operationId: "materialize-origin-copy",
      expectedActivationArtifactFingerprint: adopted.activation.artifactFingerprint,
      message: "Materialize remote page as new",
      newDocuments: [copyPage],
      changes: [{
        documentId: "notebook:notebook-1",
        change: (document) => {
          if (document.kind !== "notebook") throw new Error("Expected notebook.");
          document.sections[0].pageDocumentIds.push("page:origin-copy");
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push("page:origin-copy"); },
    });
    expect(materialized.schemaVersion).toBe(3);

    const newHandleDoc = Automerge.load<LivePageDocV2>(await runtime.readPage("origin-copy", (doc) => Automerge.save(doc)));
    const newHeads = Automerge.getHeads(newHandleDoc);
    // Divergence at the history level: none of B1's real heads are reachable from the fresh copy.
    expect(newHeads.some((head) => Automerge.getHeads(remoteAtB1).includes(head))).toBe(false);

    // The later remote change cannot manifest: its causal dependency (B1's heads) is absent,
    // so Automerge holds it as a pending/inapplicable change rather than throwing.
    const [patchedNew] = Automerge.applyChanges(newHandleDoc, laterChanges);
    expect(patchedNew.title).not.toBe("Remote edit 2");
    expect(patchedNew.title).toBe("Remote edit 1");
  });

  it("adoption round-trips through a real commitActiveWorkspaceRevision, and the activation reopens and validates", async () => {
    const setup = runtimeSetup();
    await new V2WorkspaceMigrationOrchestrator(
      setup.source,
      setup.activationStore,
      new InMemoryAutomergeRepoMigrationAdapter(),
      new DefaultAutomergeMigrationMaterializer(),
      { now: () => TIME },
    ).run();
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error("Expected schema v3.");

    const originPage: PageDocV3 = {
      schemaVersion: 3, documentId: "page:origin", kind: "page", notebookId: "notebook-1",
      sectionId: "section-1", pageId: "origin", title: "Adopted page", tags: [], pageType: "a4",
      background: { type: "grid", color: "#ffffff" }, createdAt: TIME, updatedAt: TIME,
      elementsById: {}, zOrder: [], version: { protocol: "uninitialized", heads: [] },
    };
    const bytes = saveAutomergeDocument(createAutomergeDocument(originPage));

    await runtime.commitWorkspaceGraphRevision({
      operationId: "adopt-origin",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Adopt remote page",
      adoptedDocuments: [{ documentId: "page:origin", kind: "page", bytes }],
      changes: [{
        documentId: "notebook:notebook-1",
        change: (document) => {
          if (document.kind !== "notebook") throw new Error("Expected notebook.");
          document.sections[0].pageDocumentIds.push("page:origin");
        },
      }],
      updateManifest: (manifest) => { manifest.pageDocumentIds.push("page:origin"); },
    });

    // A brand-new runtime instance over the same underlying storage must reopen and validate
    // (`validateWorkspaceGraph`) without any special-casing for an adopted document.
    const reopened = setup.createRuntime();
    const reopenedState = await reopened.startup();
    if (reopenedState.schemaVersion !== 3) throw new Error("Expected schema v3 after reopening.");
    expect(await reopened.readPage("origin", (doc) => doc.title)).toBe("Adopted page");
  });
});

describe("personal-space integration: adopting a document whose id the local starter also has", () => {
  // Every fresh install carries the bundled start page under the same fixed id. A second device
  // that joins an account therefore receives a remote page whose id it already has locally, with
  // an unrelated Automerge history. The catch-up plan lists that id as adopted and as removed, so
  // the revision replaces the local root instead of failing on every retry.
  async function startedRuntime() {
    const setup = runtimeSetup();
    await new V2WorkspaceMigrationOrchestrator(
      setup.source,
      setup.activationStore,
      new InMemoryAutomergeRepoMigrationAdapter(),
      new DefaultAutomergeMigrationMaterializer(),
      { now: () => TIME },
    ).run();
    const runtime = setup.createRuntime();
    await runtime.startup();
    const state = await runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error("Expected schema v3.");
    return { setup, runtime, state };
  }

  function remoteCopyOfPageOne(): Uint8Array {
    const remotePage: PageDocV3 = {
      schemaVersion: 3, documentId: "page:page-1", kind: "page", notebookId: "notebook-1",
      sectionId: "section-1", pageId: "page-1", title: "Vectors from the account", tags: [], pageType: "a4",
      background: { type: "grid", color: "#ffffff" }, createdAt: TIME, updatedAt: TIME,
      elementsById: {}, zOrder: [], version: { protocol: "uninitialized", heads: [] },
    };
    return saveAutomergeDocument(createAutomergeDocument(remotePage));
  }

  it("replaces the local root when the same revision removes it", async () => {
    const { setup, runtime, state } = await startedRuntime();
    expect(runtime.getPageHandle("page-1").doc().title).toBe("Vectors");

    await runtime.commitWorkspaceGraphRevision({
      operationId: "replace-starter-page",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Adopt the account's copy of a page this device also has",
      adoptedDocuments: [{ documentId: "page:page-1", kind: "page", bytes: remoteCopyOfPageOne() }],
      removedDocumentIds: ["page:page-1"],
    });

    expect(await runtime.readPage("page-1", (doc) => doc.title)).toBe("Vectors from the account");
    const reopened = setup.createRuntime();
    const reopenedState = await reopened.startup();
    if (reopenedState.schemaVersion !== 3) throw new Error("Expected schema v3 after reopening.");
    expect(await reopened.readPage("page-1", (doc) => doc.title)).toBe("Vectors from the account");
    expect(reopenedState.activation.documents.filter((document) => document.documentId === "page:page-1")).toHaveLength(1);
  });

  it("still refuses a new document that reuses an id the revision keeps", async () => {
    const { runtime, state } = await startedRuntime();
    await expect(runtime.commitWorkspaceGraphRevision({
      operationId: "collide-starter-page",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Adopt without removing",
      adoptedDocuments: [{ documentId: "page:page-1", kind: "page", bytes: remoteCopyOfPageOne() }],
    })).rejects.toThrow(/collides with an existing root/);
    expect(runtime.getPageHandle("page-1").doc().title).toBe("Vectors");
  });
});

describe("personal-space integration: delete-on-A / edit-on-B (§6.3)", () => {
  it("produces a trash record and preserves the edited content", async () => {
    const setup = runtimeSetup();
    await new V2WorkspaceMigrationOrchestrator(
      setup.source,
      setup.activationStore,
      new InMemoryAutomergeRepoMigrationAdapter(),
      new DefaultAutomergeMigrationMaterializer(),
      { now: () => TIME },
    ).run();
    const runtimeB = setup.createRuntime();
    await runtimeB.startup();
    const state = await runtimeB.ensureSchemaV3();
    if (state.schemaVersion !== 3) throw new Error("Expected schema v3.");

    // "Edit on B": an ordinary local content edit, entirely unrelated to personal-space sync.
    await runtimeB.commitWorkspaceGraphRevision({
      operationId: "edit-on-b",
      expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
      message: "Edit page on B",
      changes: [{
        documentId: "page:page-1",
        change: (document) => {
          if (document.kind !== "page") throw new Error("Expected page.");
          document.title = "Edited on B while offline";
        },
      }],
    });

    // "Delete on A": simulated by a workspace doc where notebook-1 carries a `deletedAt` — as
    // if A's soft delete had already merged into the shared workspace CRDT B's session holds.
    const workspaceDoc: SpaceWorkspaceDocV1 = Automerge.change(
      Automerge.change(initWorkspaceDoc(), addNotebook("notebook:notebook-1", { order: "a0", addedAt: TIME })),
      softDelete("notebook", "notebook:notebook-1", "2026-09-02T10:00:00.000Z"),
    );

    const stateAfterEdit = runtimeB.getState();
    if (stateAfterEdit.schemaVersion !== 3) throw new Error("Expected schema v3.");
    const plan = projectSpacePlan({
      workspaceDoc,
      remoteDocBytes: new Map(),
      activation: stateAfterEdit.activation,
    });
    expect(plan.trashAdditions).toEqual([
      { documentId: "notebook:notebook-1", kind: "notebook", deletedAt: "2026-09-02T10:00:00.000Z" },
    ]);

    const applied = await applySpacePlan(runtimeB, plan, { operationId: "apply-delete-on-a", message: "Trash notebook" });
    expect(applied).not.toBeNull();
    if (!applied || applied.schemaVersion !== 3) throw new Error("Expected schema v3 after applying the plan.");

    // The notebook and its page document stay in the activation (soft delete, not a purge)...
    expect(applied.activation.manifest.notebookDocumentIds).toContain("notebook:notebook-1");
    expect(applied.activation.documents.some((d) => d.documentId === "page:page-1")).toBe(true);
    // ...a trash record now exists for it...
    const trashRecord = applied.activation.manifest.trash.find((record) => record.notebookDocumentId === "notebook:notebook-1");
    expect(trashRecord).toBeDefined();
    expect(trashRecord?.origin).toEqual({ source: "personal-space" });
    // ...and B's edit is not lost.
    expect(await runtimeB.readPage("page-1", (doc) => doc.title)).toBe("Edited on B while offline");
  });
});

describe("personal-space sync of pages that are not open (lazy runtime)", () => {
  interface Device {
    store: MemoryWorkspaceStore;
    runtime: WorkspaceV2Runtime;
    session: PersonalSpaceSession;
    binding: PersonalSpaceBinding;
    close(): Promise<void>;
  }

  /** One activated schema-v3 workspace, copied below to give two devices the same documents. */
  async function baseStore(): Promise<MemoryWorkspaceStore> {
    const setup = runtimeSetup();
    await new V2WorkspaceMigrationOrchestrator(
      setup.source,
      setup.activationStore,
      new InMemoryAutomergeRepoMigrationAdapter(),
      new DefaultAutomergeMigrationMaterializer(),
      { now: () => TIME },
    ).run();
    const runtime = setup.createRuntime();
    await runtime.startup();
    await runtime.ensureSchemaV3();
    await runtime.shutdown();
    return setup.atomic;
  }

  function copyOf(store: MemoryWorkspaceStore): MemoryWorkspaceStore {
    const copy = new MemoryWorkspaceStore();
    for (const record of store.entries()) copy.put(record.key, record.value);
    return copy;
  }

  async function startRuntime(store: MemoryWorkspaceStore): Promise<WorkspaceV2Runtime> {
    const runtime = runtimeSetup(workspace(), store).createRuntime();
    const state = await runtime.startup();
    if (state.schemaVersion !== 3) throw new Error("Expected schema v3.");
    return runtime;
  }

  async function connect(store: MemoryWorkspaceStore, relay: FakeRelay, runtime?: WorkspaceV2Runtime): Promise<Device> {
    const opened = runtime ?? await startRuntime(store);
    const port = createRuntimeSpacePort(opened, { onRemoteDocAdded: vi.fn() });
    const session = openPersonalSpaceSession({
      syncUrl: "https://sync.example.com",
      spaceId: "space-1",
      getAuth: async () => ({ jwt: "jwt", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
      getFullSnapshotBytes: (docId) => port.getSnapshotBytes(docId),
      webSocketFactory: relay.factory(),
      onStatus: () => undefined,
      visibilityTarget: null,
      onlineTarget: null,
    });
    const binding = bindPersonalSpace({
      session,
      port,
      onWorkspaceDoc: () => undefined,
      mayPushLocal: () => true,
      announced: new Set(),
    });
    return {
      store,
      runtime: opened,
      session,
      binding,
      close: async () => {
        binding.dispose();
        session.close();
        await opened.shutdown();
      },
    };
  }

  async function settle(...devices: Device[]): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3));
      await Promise.all(devices.map((device) => device.binding.idle()));
    }
  }

  /** Device A pushes the workspace into an empty account; device B has the same documents. */
  async function twoDevices() {
    const base = await baseStore();
    const relay = new FakeRelay();
    const a = await connect(copyOf(base), relay);
    await settle(a);
    const b = await connect(copyOf(base), relay);
    await settle(a, b);
    expect([...relay.docs.keys()].sort()).toEqual(["notebook:notebook-1", "page:page-1", "page:page-2"]);
    return { relay, a, b };
  }

  async function reopenedTitle(store: MemoryWorkspaceStore, pageId: string): Promise<string | undefined> {
    const reopened = await startRuntime(store);
    try {
      expect(reopened.isPageLoaded(pageId)).toBe(false);
      expect(reopened.getPageSummary(pageId)?.title).toBe(await reopened.readPage(pageId, (doc) => doc.title));
      return await reopened.readPage(pageId, (doc) => doc.title);
    } finally {
      await reopened.shutdown();
    }
  }

  it("a change another device makes to a page that is not open here is merged and persisted without loading the page", async () => {
    const { a, b } = await twoDevices();
    try {
      expect(b.runtime.isPageLoaded("page-2")).toBe(false);

      await a.runtime.changePage("page-2", { message: "Rename on A" }, (draft) => { draft.title = "Forces, edited on A"; });
      await settle(a, b);

      // Merged while the page stayed out of memory on B...
      expect(b.runtime.isPageLoaded("page-2")).toBe(false);
      expect(b.runtime.getPageSummary("page-2")?.title).toBe("Forces, edited on A");
      // ...and persisted: a fresh start of B reads it from storage.
      await b.close();
      expect(await reopenedTitle(b.store, "page-2")).toBe("Forces, edited on A");
    } finally {
      await a.close();
    }
  });

  it("sends changes made to a page that is not open: a topology commit and a change from another sync channel", async () => {
    const { relay, a, b } = await twoDevices();
    try {
      expect(a.runtime.isPageLoaded("page-2")).toBe(false);
      const state = a.runtime.getState();
      if (state.schemaVersion === 1) throw new Error("Expected schema v3.");
      await a.runtime.commitWorkspaceGraphRevision({
        operationId: "rename-unloaded-page",
        expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
        message: "Rename a page that is not open",
        changes: [{
          documentId: "page:page-2",
          change: (document) => {
            if (document.kind !== "page") throw new Error("Expected page.");
            document.title = "Renamed by a commit";
          },
        }],
      });
      expect(a.runtime.isPageLoaded("page-2")).toBe(false);
      await settle(a, b);
      expect(b.runtime.getPageSummary("page-2")?.title).toBe("Renamed by a commit");
      expect(b.runtime.isPageLoaded("page-2")).toBe(false);

      // The shared room (another source) changes the page on A; the personal room gets it once.
      const current = await a.runtime.readDocument("page:page-2", (doc) => Automerge.save(doc as Automerge.Doc<PageDocV3>));
      const fromSharing = Automerge.change(Automerge.load<PageDocV3>(current), (doc) => { doc.title = "Changed in the shared room"; });
      const pageChangesBefore = relay.docs.get("page:page-2")?.changes.length ?? 0;
      expect(await a.runtime.applyRemoteDocumentChanges("page:page-2", Automerge.save(fromSharing), { source: "collab:notebook-1" }))
        .toBe("applied");
      expect(a.runtime.isPageLoaded("page-2")).toBe(false);
      await settle(a, b);
      expect(relay.docs.get("page:page-2")?.changes.length).toBe(pageChangesBefore + 1);
      expect(b.runtime.getPageSummary("page-2")?.title).toBe("Changed in the shared room");
      expect(b.runtime.isPageLoaded("page-2")).toBe(false);
      const hashes = relay.storedChangeHashes("page:page-2");
      expect(new Set(hashes).size).toBe(hashes.length);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("sends edits made while the session was closed once it connects, without re-sending unchanged pages", async () => {
    const { relay, a, b } = await twoDevices();
    await b.close();
    const offline = await startRuntime(b.store);
    await offline.changePage("page-1", { message: "Offline edit" }, (draft) => { draft.title = "Vectors, edited offline"; });
    const appendsBefore = [...relay.docs.values()].reduce((sum, doc) => sum + doc.changes.length, 0);

    const back = await connect(b.store, relay, offline);
    try {
      await settle(a, back);
      expect(await a.runtime.readPage("page-1", (doc) => doc.title)).toBe("Vectors, edited offline");
      const appendsAfter = [...relay.docs.values()].reduce((sum, doc) => sum + doc.changes.length, 0);
      expect(appendsAfter - appendsBefore).toBe(1);
    } finally {
      await Promise.all([a.close(), back.close()]);
    }
  });

  it("keeps the room's copies as bytes, not as live documents", async () => {
    const { a, b } = await twoDevices();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(b.session.getMemoryDiagnostics().liveDocs).toBe(0);
      expect(b.session.getMemoryDiagnostics().storedBytes).toBeGreaterThan(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

});
