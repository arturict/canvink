import { describe, expect, it } from "vitest";
import {
  commitAppliedEnvelopes,
  createInboundSyncState,
  getReadyEnvelopes,
  ingestSyncEnvelope,
} from "./inbox";
import { syncEnvelope } from "./testFixtures";

describe("inbound sync sequencing", () => {
  it("buffers out-of-order envelopes and exposes only a contiguous prefix", () => {
    const initial = createInboundSyncState("notebook-1");
    const second = ingestSyncEnvelope(initial, syncEnvelope(2));
    expect(second.accepted).toBe(true);
    if (!second.accepted) throw new Error("expected acceptance");
    expect(second.ready).toEqual([]);

    const first = ingestSyncEnvelope(second.state, syncEnvelope(1));
    expect(first.accepted).toBe(true);
    if (!first.accepted) throw new Error("expected acceptance");
    expect(first.ready.map((envelope) => envelope.sequence)).toEqual([1, 2]);
  });

  it("does not advance the cursor until the applied prefix is committed", () => {
    const ingested = ingestSyncEnvelope(
      createInboundSyncState("notebook-1"),
      syncEnvelope(1),
    );
    if (!ingested.accepted) throw new Error("expected acceptance");

    expect(ingested.state.contiguousSequence).toBe(0);
    const committed = commitAppliedEnvelopes(ingested.state, ingested.ready);
    expect(committed.contiguousSequence).toBe(1);
    expect(committed.buffered).toEqual([]);
  });

  it("rejects duplicates, hash replays, and sequence conflicts", () => {
    const first = ingestSyncEnvelope(
      createInboundSyncState("notebook-1"),
      syncEnvelope(1, 11),
    );
    if (!first.accepted) throw new Error("expected acceptance");

    expect(ingestSyncEnvelope(first.state, syncEnvelope(1, 11))).toMatchObject({
      accepted: false,
      reason: "duplicate",
    });
    expect(ingestSyncEnvelope(first.state, syncEnvelope(2, 11))).toMatchObject({
      accepted: false,
      reason: "replay",
    });
    expect(ingestSyncEnvelope(first.state, syncEnvelope(1, 12))).toMatchObject({
      accepted: false,
      reason: "sequence-conflict",
    });
  });

  it("rejects old unknown envelopes as replay after cursor advancement", () => {
    const first = ingestSyncEnvelope(
      createInboundSyncState("notebook-1"),
      syncEnvelope(1, 11),
    );
    if (!first.accepted) throw new Error("expected acceptance");
    const committed = commitAppliedEnvelopes(first.state, first.ready);

    expect(ingestSyncEnvelope(committed, syncEnvelope(1, 99))).toMatchObject({
      accepted: false,
      reason: "sequence-conflict",
    });
    expect(ingestSyncEnvelope(committed, syncEnvelope(1, 11))).toMatchObject({
      accepted: false,
      reason: "duplicate",
    });
  });

  it("keeps the ready prefix unchanged when a buffer limit rejects input", () => {
    const first = ingestSyncEnvelope(
      createInboundSyncState("notebook-1"),
      syncEnvelope(3),
      1,
    );
    if (!first.accepted) throw new Error("expected acceptance");
    const rejected = ingestSyncEnvelope(first.state, syncEnvelope(1), 1);

    expect(rejected).toMatchObject({ accepted: false, reason: "buffer-full" });
    expect(getReadyEnvelopes(rejected.state)).toEqual([]);
  });

  it("will not commit a same-hash envelope whose opaque payload differs", () => {
    const ingested = ingestSyncEnvelope(
      createInboundSyncState("notebook-1"),
      syncEnvelope(1),
    );
    if (!ingested.accepted) throw new Error("expected acceptance");

    expect(() =>
      commitAppliedEnvelopes(ingested.state, [
        syncEnvelope(1, 1, { ciphertext: new Uint8Array([99]) }),
      ]),
    ).toThrow(/do not match/);
  });
});
