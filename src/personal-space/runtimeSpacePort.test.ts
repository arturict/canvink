import * as Automerge from "@automerge/automerge";
import { describe, expect, it, vi } from "vitest";
import { FakeDocumentRuntime } from "../collab/testDocumentRuntime";
import { createRuntimeSpacePort, PERSONAL_SPACE_SOURCE } from "./runtimeSpacePort";

type FakeDoc = { value: string; other?: string };

function setUp(pageValue = "page") {
  const runtime = new FakeDocumentRuntime([
    { documentId: "notebook:nb-1", kind: "notebook", doc: Automerge.from<FakeDoc>({ value: "notebook" }) },
    { documentId: "page:pg-1", kind: "page", doc: Automerge.from<FakeDoc>({ value: pageValue }) },
  ]);
  const onRemoteDocAdded = vi.fn();
  const port = createRuntimeSpacePort(runtime, { onRemoteDocAdded });
  return { runtime, port, onRemoteDocAdded };
}

const page = (runtime: FakeDocumentRuntime) => runtime.doc<FakeDoc>("page:pg-1");

describe("createRuntimeSpacePort", () => {
  it("listDocs reports every workspace document without reading any", async () => {
    const { runtime, port } = setUp();
    const docs = await port.listDocs();
    expect(docs.map((d) => d.docId).sort()).toEqual(["notebook:nb-1", "page:pg-1"]);
    expect(docs.find((d) => d.docId === "notebook:nb-1")?.kind).toBe("notebook");
    expect(docs.find((d) => d.docId === "page:pg-1")?.kind).toBe("page");
    expect(runtime.reads.size).toBe(0);
    expect(port.hasDoc?.("page:pg-1")).toBe(true);
    expect(port.hasDoc?.("page:elsewhere")).toBe(false);
  });

  it("subscribe forwards incremental local changes and can be unsubscribed", async () => {
    const { runtime, port } = setUp();
    await port.listDocs();
    const callback = vi.fn();
    const unsubscribe = port.subscribe("page:pg-1", callback);

    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.value = "changed"; });
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.value = "changed again"; });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("forwards a topology commit and a remote change of another source, but not its own applies", async () => {
    const { runtime, port } = setUp();
    await port.listDocs();
    const callback = vi.fn();
    port.subscribe("page:pg-1", callback);

    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.value = "renamed by a commit"; }, { kind: "topology" });
    expect(callback).toHaveBeenCalledTimes(1);

    const fromSharing = Automerge.change(Automerge.clone(page(runtime)), (doc) => { doc.other = "from the shared room"; });
    await runtime.applyRemoteDocumentChanges("page:pg-1", Automerge.save(fromSharing), { source: "collab:nb-1" });
    expect(callback).toHaveBeenCalledTimes(2);

    const fromAccount = Automerge.change(Automerge.clone(page(runtime)), (doc) => { doc.value = "from the account"; });
    await port.applyRemote("page:pg-1", Automerge.save(fromAccount));
    expect(page(runtime).value).toBe("from the account");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("subscribe on an unknown docId returns a no-op unsubscribe", () => {
    const { port } = setUp();
    expect(() => port.subscribe("page:unknown", vi.fn())()).not.toThrow();
  });

  it("applyRemote refuses a copy of the document with an unrelated history", async () => {
    const { runtime, port } = setUp("this device");
    // Another install created the same document id on its own, like the bundled start page.
    const foreign = Automerge.save(Automerge.from<FakeDoc>({ value: "other device" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await port.listDocs();
    await port.applyRemote("page:pg-1", foreign);

    expect(page(runtime).value).toBe("this device");
    expect(Automerge.getConflicts(page(runtime), "value")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("applyRemote still merges a related copy when both sides changed", async () => {
    const { runtime, port } = setUp("base");
    const remote = Automerge.change(Automerge.clone(page(runtime), { actor: "abcd" }), (doc) => {
      doc.other = "from-remote";
    });
    await port.listDocs();
    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.value = "local edit"; });

    await port.applyRemote("page:pg-1", Automerge.save(remote));

    expect(page(runtime).value).toBe("local edit");
    expect(page(runtime).other).toBe("from-remote");
  });

  it("does not skip unsent local work when its own remote apply lands", async () => {
    const { runtime, port } = setUp();
    await port.listDocs();
    const roomCopy = Automerge.clone(page(runtime));
    // Edited while nothing was subscribed (before the session bound).
    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.value = "unsent"; });
    const remote = Automerge.change(Automerge.clone(roomCopy, { actor: "abcd" }), (doc) => { doc.other = "remote"; });
    await port.applyRemote("page:pg-1", Automerge.save(remote));

    const callback = vi.fn();
    port.subscribe("page:pg-1", callback);
    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.other = "next"; });
    expect(callback).toHaveBeenCalledTimes(1);
    const [bytes] = callback.mock.calls[0] as [Uint8Array];
    // The room (which has the remote change) catches up completely: the unsent edit came along.
    const room = Automerge.loadIncremental(remote, bytes);
    expect([...Automerge.getHeads(room)].sort()).toEqual([...Automerge.getHeads(page(runtime))].sort());
    expect(room.value).toBe("unsent");
  });

  it("getSnapshotBytes never perturbs the subscribe baseline", async () => {
    const { runtime, port } = setUp();
    await port.listDocs();
    const callback = vi.fn();
    port.subscribe("page:pg-1", callback);

    // Reading a snapshot between two real changes must not affect what the next diff computes.
    expect(await port.getSnapshotBytes("page:pg-1")).toBeInstanceOf(Uint8Array);
    runtime.change<FakeDoc>("page:pg-1", (doc) => { doc.value = "changed"; });
    expect(callback).toHaveBeenCalledTimes(1);
    const [bytes] = callback.mock.calls[0] as [Uint8Array];
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("getSnapshotBytes returns undefined for an unknown docId", async () => {
    const { port } = setUp();
    expect(await port.getSnapshotBytes("notebook:unknown")).toBeUndefined();
  });

  it("onRemoteDocAdded forwards notebook/page docs and ignores the workspace doc", () => {
    const { port, onRemoteDocAdded } = setUp();
    const bytes = new Uint8Array([1, 2, 3]);
    port.onRemoteDocAdded("notebook:new", "notebook", bytes);
    port.onRemoteDocAdded("workspace:root", "workspace", bytes);

    expect(onRemoteDocAdded).toHaveBeenCalledTimes(1);
    expect(onRemoteDocAdded).toHaveBeenCalledWith("notebook:new", "notebook", bytes);
  });

  it("uses its own source for remote applies", async () => {
    const { runtime, port } = setUp();
    const events: string[] = [];
    runtime.subscribeToDocumentChanges((event) => {
      if (event.origin.kind === "remote") events.push(event.origin.source);
    });
    const remote = Automerge.change(Automerge.clone(page(runtime)), (doc) => { doc.value = "remote"; });
    await port.applyRemote("page:pg-1", Automerge.save(remote));
    expect(events).toEqual([PERSONAL_SPACE_SOURCE]);
  });
});
