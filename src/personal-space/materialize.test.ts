import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "../domain/v3";
import type { V2RuntimeState, WorkspaceGraphRevisionRequest, WorkspaceV2Runtime } from "../storage/workspaceV2Runtime";
import { applySpacePlan, batchAdoptedDocuments, createSpacePlanMaterializer } from "./materialize";
import type { SpacePlan } from "./contract";

function emptyPlan(): SpacePlan {
  return {
    adoptedDocuments: [],
    placeholderPages: [],
    removedDocumentIds: [],
    notebookDocumentIds: [],
    pageDocumentIds: [],
    trashAdditions: [],
    trashRemovals: [],
  };
}

function samplePlan(): SpacePlan {
  return {
    adoptedDocuments: [{ documentId: "page:1", kind: "page", bytes: new Uint8Array([1]) }],
    placeholderPages: [],
    removedDocumentIds: ["notebook:gone"],
    notebookDocumentIds: ["notebook:a"],
    pageDocumentIds: ["page:1"],
    trashAdditions: [{ documentId: "notebook:trashed", kind: "notebook", deletedAt: "2026-09-02T10:00:00.000Z" }],
    trashRemovals: ["notebook:restored"],
  };
}

function sampleManifest(): WorkspaceManifest {
  return {
    schemaVersion: 3,
    format: "canvink-schema-v3",
    migration: {
      name: "workspace-v1-to-v2",
      version: 1,
      migrationId: "migration-1",
      sourceFingerprint: "sha256:source",
      preparedAt: "2026-09-02T08:00:00.000Z",
    },
    upgrade: {
      name: "workspace-v2-to-v3",
      version: 1,
      upgradeId: "upgrade-1",
      sourceArtifactFingerprint: "sha256:source",
      preparedAt: "2026-09-02T08:00:00.000Z",
    },
    active: { notebookId: "local", sectionId: "local-section", pageId: "local-page" },
    notebookDocumentIds: ["notebook:old"],
    pageDocumentIds: [],
    assetIds: [],
    trash: [{
      id: "notebook:restored",
      kind: "notebook",
      deletedAt: "2026-09-02T07:00:00.000Z",
      origin: {},
      notebookDocumentId: "notebook:restored",
    }],
  };
}

/** A minimal fake `WorkspaceV2Runtime`: only `getState` and `commitWorkspaceGraphRevision`
 * are used by `materialize.ts`. */
function fakeRuntime(options: {
  fingerprints: string[];
  commitImpl: (request: WorkspaceGraphRevisionRequest, callIndex: number) => Promise<V2RuntimeState>;
}): { runtime: WorkspaceV2Runtime; commit: ReturnType<typeof vi.fn> } {
  let stateCallIndex = 0;
  let commitCallIndex = 0;
  const commit = vi.fn(async (request: WorkspaceGraphRevisionRequest) => {
    const callIndex = commitCallIndex;
    commitCallIndex += 1;
    return options.commitImpl(request, callIndex);
  });
  const runtime = {
    getState: () => ({
      schemaVersion: 3,
      activation: { artifactFingerprint: options.fingerprints[Math.min(stateCallIndex++, options.fingerprints.length - 1)] },
    }),
    commitWorkspaceGraphRevision: commit,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as WorkspaceV2Runtime;
  return { runtime, commit };
}

describe("adoption in bounded commits", () => {
  const doc = (documentId: string, kind: "page" | "notebook", size: number) => ({
    documentId, kind, bytes: new Uint8Array(size),
  });

  it("puts pages before notebooks and splits by bytes, a large document alone", () => {
    const batches = batchAdoptedDocuments([
      doc("notebook:n", "notebook", 10),
      doc("page:a", "page", 600),
      doc("page:b", "page", 600),
      doc("page:huge", "page", 5_000),
      doc("page:c", "page", 100),
    ], 1_000);
    expect(batches.map((batch) => batch.map((entry) => entry.documentId))).toEqual([
      ["page:a"], ["page:b"], ["page:huge"], ["page:c", "notebook:n"],
    ]);
  });

  it("commits interim batches that only add, then the whole plan with the last one", async () => {
    const manifests: WorkspaceManifest[] = [];
    const requests: WorkspaceGraphRevisionRequest[] = [];
    let generation = 0;
    const runtime = {
      getState: () => ({
        schemaVersion: 3,
        activation: { artifactFingerprint: `sha256:${generation}`, manifest: manifests.at(-1) ?? sampleManifest() },
      }),
      commitWorkspaceGraphRevision: vi.fn(async (request: WorkspaceGraphRevisionRequest) => {
        const manifest = structuredClone(manifests.at(-1) ?? sampleManifest());
        request.updateManifest?.(manifest);
        manifests.push(manifest);
        requests.push(request);
        generation += 1;
        return { schemaVersion: 3 } as unknown as V2RuntimeState;
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as WorkspaceV2Runtime;
    const plan: SpacePlan = {
      adoptedDocuments: [doc("page:a", "page", 800), doc("page:b", "page", 800), doc("notebook:new", "notebook", 300)],
      placeholderPages: [],
      removedDocumentIds: ["page:starter", "page:b"],
      notebookDocumentIds: ["notebook:new"],
      pageDocumentIds: ["page:a", "page:b", "page:listed"],
      trashAdditions: [],
      trashRemovals: ["notebook:restored"],
    };
    let finalized = 0;
    await applySpacePlan(runtime, plan, {
      operationId: "op",
      message: "Adopt",
      maxCommitBytes: 1_000,
      finalizeManifest: () => { finalized += 1; },
    });
    expect(requests.map((request) => request.adoptedDocuments?.map((entry) => entry.documentId))).toEqual([
      ["page:a"], ["page:b"], ["notebook:new"],
    ]);
    // A replaced placeholder leaves with the commit that adopts it; the rest of the removals wait for the last commit.
    expect(requests.map((request) => request.removedDocumentIds)).toEqual([[], ["page:b"], ["page:starter"]]);
    expect(requests.map((request) => request.operationId)).toEqual(["op-0", "op-1", "op-2"]);
    // Interim manifests keep what the workspace had and add the batch; the last one is the plan's.
    expect(manifests[0]?.pageDocumentIds).toEqual(["page:a"]);
    expect(manifests[0]?.notebookDocumentIds).toEqual(["notebook:old"]);
    expect(manifests[0]?.trash.map((record) => record.id)).toEqual(["notebook:restored"]);
    expect(manifests[2]?.notebookDocumentIds).toEqual(["notebook:new"]);
    expect(manifests[2]?.pageDocumentIds).toEqual(["page:a", "page:b", "page:listed"]);
    expect(manifests[2]?.trash.map((record) => record.id)).toEqual([]);
    expect(finalized).toBe(1);
  });

  it("lists placeholder pages with the first commit", async () => {
    const requests: WorkspaceGraphRevisionRequest[] = [];
    const runtime = {
      getState: () => ({ schemaVersion: 3, activation: { artifactFingerprint: "sha256:x", manifest: sampleManifest() } }),
      commitWorkspaceGraphRevision: vi.fn(async (request: WorkspaceGraphRevisionRequest) => {
        requests.push(request);
        return { schemaVersion: 3 } as unknown as V2RuntimeState;
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as WorkspaceV2Runtime;
    const placeholder = { documentId: "page:listed", summary: { documentId: "page:listed" } as never };
    await applySpacePlan(runtime, {
      ...emptyPlan(),
      adoptedDocuments: [doc("page:a", "page", 800), doc("page:b", "page", 800)],
      placeholderPages: [placeholder],
      pageDocumentIds: ["page:a", "page:b", "page:listed"],
    }, { operationId: "op", message: "Adopt", maxCommitBytes: 1_000 });
    expect(requests.map((request) => request.placeholderPages?.length ?? 0)).toEqual([1, 0]);
  });
});

const CONFLICT_MESSAGE = "The active workspace changed before the topology transaction.";

describe("applySpacePlan", () => {
  it("returns null and never calls the runtime when the plan is empty in every field", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1"],
      commitImpl: async () => ({ schemaVersion: 3 }) as unknown as V2RuntimeState,
    });
    const result = await applySpacePlan(runtime, emptyPlan(), { operationId: "op-1", message: "noop" });
    expect(result).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits once, forwarding adoptedDocuments/removedDocumentIds and applying the manifest delta", async () => {
    let capturedManifest: WorkspaceManifest | undefined;
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1"],
      commitImpl: async (request) => {
        const manifest = sampleManifest();
        request.updateManifest?.(manifest);
        capturedManifest = manifest;
        return { schemaVersion: 3, activation: { artifactFingerprint: "sha256:v2" } } as unknown as V2RuntimeState;
      },
    });
    const result = await applySpacePlan(runtime, samplePlan(), { operationId: "op-1", message: "Adopt" });
    expect(commit).toHaveBeenCalledTimes(1);
    const request = commit.mock.calls[0][0] as WorkspaceGraphRevisionRequest;
    expect(request.expectedActivationArtifactFingerprint).toBe("sha256:v1");
    expect(request.adoptedDocuments).toEqual(samplePlan().adoptedDocuments);
    expect(request.removedDocumentIds).toEqual(["notebook:gone"]);
    expect(result).not.toBeNull();

    expect(capturedManifest?.notebookDocumentIds).toEqual(["notebook:a"]);
    expect(capturedManifest?.pageDocumentIds).toEqual(["page:1"]);
    const trashIds = capturedManifest?.trash.map((record) => record.id);
    expect(trashIds).toContain("notebook:trashed");
    expect(trashIds).not.toContain("notebook:restored"); // cleared by trashRemovals
  });

  it("retries exactly once after an activation-changed conflict, using a fresh fingerprint", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1", "sha256:v2"],
      commitImpl: async (_request, callIndex) => {
        if (callIndex === 0) throw new Error(CONFLICT_MESSAGE);
        return { schemaVersion: 3 } as unknown as V2RuntimeState;
      },
    });
    const result = await applySpacePlan(runtime, samplePlan(), { operationId: "op-1", message: "Adopt" });
    expect(commit).toHaveBeenCalledTimes(2);
    expect((commit.mock.calls[0][0] as WorkspaceGraphRevisionRequest).expectedActivationArtifactFingerprint).toBe("sha256:v1");
    expect((commit.mock.calls[1][0] as WorkspaceGraphRevisionRequest).expectedActivationArtifactFingerprint).toBe("sha256:v2");
    expect(result).not.toBeNull();
  });

  it("uses reprojectPlan for the retry attempt when provided", async () => {
    const reprojected = { ...samplePlan(), notebookDocumentIds: ["notebook:reprojected"] };
    const reprojectPlan = vi.fn(() => reprojected);
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1", "sha256:v2"],
      commitImpl: async (_request, callIndex) => {
        if (callIndex === 0) throw new Error(CONFLICT_MESSAGE);
        return { schemaVersion: 3 } as unknown as V2RuntimeState;
      },
    });
    await applySpacePlan(runtime, samplePlan(), { operationId: "op-1", message: "Adopt", reprojectPlan });
    expect(reprojectPlan).toHaveBeenCalledTimes(1);
    const secondRequest = commit.mock.calls[1][0] as WorkspaceGraphRevisionRequest;
    expect(secondRequest.adoptedDocuments).toEqual(reprojected.adoptedDocuments);
  });

  it("defers (returns null) if reprojectPlan yields an empty plan on retry", async () => {
    const reprojectPlan = vi.fn(() => emptyPlan());
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1", "sha256:v2"],
      commitImpl: async () => { throw new Error(CONFLICT_MESSAGE); },
    });
    const result = await applySpacePlan(runtime, samplePlan(), { operationId: "op-1", message: "Adopt", reprojectPlan });
    expect(result).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1); // the retry never reaches the runtime once the plan is empty
  });

  it("commits against the activation the plan was projected from, so a local commit that landed meanwhile fails it", async () => {
    const { runtime, commit } = fakeRuntime({
      // The runtime already moved on to v2 (a local create) while the plan from v1 was being built.
      fingerprints: ["sha256:v2", "sha256:v3"],
      commitImpl: async (request) => {
        if (request.expectedActivationArtifactFingerprint !== "sha256:v2") throw new Error(CONFLICT_MESSAGE);
        return { schemaVersion: 3 } as unknown as V2RuntimeState;
      },
    });
    await expect(applySpacePlan(runtime, samplePlan(), {
      operationId: "op-1", message: "Adopt", plannedFromFingerprint: "sha256:v1" as never,
    })).rejects.toThrow(/changed before the topology transaction/i);
    // The stale plan is not resubmitted on top of the newer activation.
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0][0] as WorkspaceGraphRevisionRequest).expectedActivationArtifactFingerprint).toBe("sha256:v1");
    expect((commit.mock.calls[0][0] as WorkspaceGraphRevisionRequest).onConflict).toBe("fail");
  });

  it("never loops: a second conflict propagates instead of retrying again", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1", "sha256:v2"],
      commitImpl: async () => { throw new Error(CONFLICT_MESSAGE); },
    });
    await expect(applySpacePlan(runtime, samplePlan(), { operationId: "op-1", message: "Adopt" }))
      .rejects.toThrow(CONFLICT_MESSAGE);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-conflict error immediately, without retrying", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1"],
      commitImpl: async () => { throw new Error("validateWorkspaceGraph: dangling reference"); },
    });
    await expect(applySpacePlan(runtime, samplePlan(), { operationId: "op-1", message: "Adopt" }))
      .rejects.toThrow(/dangling reference/);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("createSpacePlanMaterializer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of schedule() calls into exactly one commit, using the latest plan", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1", "sha256:v1", "sha256:v1"],
      commitImpl: async () => ({ schemaVersion: 3 }) as unknown as V2RuntimeState,
    });
    const materializer = createSpacePlanMaterializer(runtime, { debounceMs: 2_000 });
    const planA = { ...samplePlan(), notebookDocumentIds: ["notebook:a"] };
    const planB = { ...samplePlan(), notebookDocumentIds: ["notebook:b"] };
    const planC = { ...samplePlan(), notebookDocumentIds: ["notebook:c"] };

    materializer.schedule(() => planA, () => ({ operationId: "op-a", message: "a" }));
    materializer.schedule(() => planB, () => ({ operationId: "op-b", message: "b" }));
    materializer.schedule(() => planC, () => ({ operationId: "op-c", message: "c" }));

    await vi.advanceTimersByTimeAsync(2_000);

    expect(commit).toHaveBeenCalledTimes(1);
    const request = commit.mock.calls[0][0] as WorkspaceGraphRevisionRequest;
    expect(request.operationId).toBe("op-c");
  });

  it("flushNow applies the pending plan immediately and cancels the timer", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1"],
      commitImpl: async () => ({ schemaVersion: 3 }) as unknown as V2RuntimeState,
    });
    const materializer = createSpacePlanMaterializer(runtime, { debounceMs: 60_000 });
    materializer.schedule(() => samplePlan(), () => ({ operationId: "op-1", message: "flush" }));
    await materializer.flushNow();
    expect(commit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(commit).toHaveBeenCalledTimes(1); // the flushed schedule does not fire again later
  });

  it("flushNow is a no-op when nothing is scheduled", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1"],
      commitImpl: async () => ({ schemaVersion: 3 }) as unknown as V2RuntimeState,
    });
    const materializer = createSpacePlanMaterializer(runtime);
    expect(await materializer.flushNow()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending scheduled application", async () => {
    const { runtime, commit } = fakeRuntime({
      fingerprints: ["sha256:v1"],
      commitImpl: async () => ({ schemaVersion: 3 }) as unknown as V2RuntimeState,
    });
    const materializer = createSpacePlanMaterializer(runtime, { debounceMs: 1_000 });
    materializer.schedule(() => samplePlan(), () => ({ operationId: "op-1", message: "disposed" }));
    materializer.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(commit).not.toHaveBeenCalled();
  });
});
