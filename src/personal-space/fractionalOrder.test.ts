import { describe, expect, it } from "vitest";
import { compareOrderedEntries, keyBetween } from "./fractionalOrder";

describe("keyBetween", () => {
  it("returns the canonical first key when both bounds are absent", () => {
    expect(keyBetween()).toBe("a0");
  });

  it("matches the worked example from PERSONAL-SYNC.md §4.3: a0, a0V, a1", () => {
    const first = keyBetween();
    expect(first).toBe("a0");
    const second = keyBetween(first, undefined);
    expect(second).toBe("a1");
    const between = keyBetween(first, second);
    expect(between).toBe("a0V");
    expect(first < between).toBe(true);
    expect(between < second).toBe(true);
  });

  it("generates a strictly increasing sequence when always inserting after the last key", () => {
    let key: string | undefined;
    const sequence: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      key = keyBetween(key, undefined);
      sequence.push(key);
    }
    const sorted = [...sequence].sort();
    expect(sequence).toEqual(sorted);
    expect(new Set(sequence).size).toBe(sequence.length);
  });

  it("generates a strictly decreasing sequence when always inserting before the first key", () => {
    let key: string | undefined;
    const sequence: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      key = keyBetween(undefined, key);
      sequence.push(key);
    }
    const sorted = [...sequence].sort().reverse();
    expect(sequence).toEqual(sorted);
    expect(new Set(sequence).size).toBe(sequence.length);
  });

  it("can subdivide indefinitely between two adjacent keys without ever colliding", () => {
    let lower = keyBetween();
    const upper = keyBetween(lower, undefined);
    const seen = new Set([lower, upper]);
    for (let i = 0; i < 200; i += 1) {
      const middle = keyBetween(lower, upper);
      expect(middle > lower).toBe(true);
      expect(middle < upper).toBe(true);
      expect(seen.has(middle)).toBe(false);
      seen.add(middle);
      lower = middle;
    }
  });

  it("is deterministic for the same inputs", () => {
    const a = keyBetween();
    const b = keyBetween(a, undefined);
    expect(keyBetween(a, b)).toBe(keyBetween(a, b));
  });

  it("rejects inputs that are already out of order", () => {
    const a = keyBetween();
    const b = keyBetween(a, undefined);
    expect(() => keyBetween(b, a)).toThrow(/requires a < b/);
    expect(() => keyBetween(a, a)).toThrow(/requires a < b/);
  });

  it("rejects malformed keys", () => {
    expect(() => keyBetween("not-a-key", undefined)).toThrow();
    expect(() => keyBetween(undefined, "")).toThrow();
    expect(() => keyBetween("a00", undefined)).toThrow(/trailing zero/);
  });

  it("produces many keys after the last one without ever needing a rebalance in practice", () => {
    let key = keyBetween();
    for (let i = 0; i < 1000; i += 1) {
      const next = keyBetween(key, undefined);
      expect(next > key).toBe(true);
      key = next;
    }
  });
});

describe("compareOrderedEntries", () => {
  it("sorts by order ascending", () => {
    const a = { order: "a0", documentId: "notebook:z" };
    const b = { order: "a1", documentId: "notebook:a" };
    expect(compareOrderedEntries(a, b)).toBeLessThan(0);
    expect(compareOrderedEntries(b, a)).toBeGreaterThan(0);
  });

  it("tie-breaks equal order by documentId", () => {
    const a = { order: "a0", documentId: "notebook:a" };
    const b = { order: "a0", documentId: "notebook:b" };
    expect(compareOrderedEntries(a, b)).toBeLessThan(0);
    expect(compareOrderedEntries(b, a)).toBeGreaterThan(0);
    expect(compareOrderedEntries(a, a)).toBe(0);
  });

  it("sorts a shuffled list back into order/id order", () => {
    const entries = [
      { order: "a1", documentId: "notebook:2" },
      { order: "a0", documentId: "notebook:9" },
      { order: "a0", documentId: "notebook:1" },
      { order: "a0V", documentId: "notebook:5" },
    ];
    const sorted = [...entries].sort(compareOrderedEntries);
    expect(sorted.map((entry) => entry.documentId)).toEqual([
      "notebook:1",
      "notebook:9",
      "notebook:5",
      "notebook:2",
    ]);
  });
});
