/**
 * A pen's samples reach the page twice: first one by one as `pointerrawupdate`
 * events, then again in the coalesced list of the frame's `pointermove`.
 * Whichever arrives first is used; the second delivery of the same sample is
 * dropped here, so a stroke never holds a point twice and never loses one.
 */
export interface TimedPoint {
  x: number;
  y: number;
  time: number;
}

/** How many recent samples are remembered; a frame carries a handful, a burst a few dozen. */
const WINDOW = 256;

export class SampleDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  private key(sample: TimedPoint): string {
    return `${sample.time}|${sample.x}|${sample.y}`;
  }

  /** The samples not seen before, in their order; they count as seen afterwards. */
  fresh<T extends TimedPoint>(samples: readonly T[]): T[] {
    const kept: T[] = [];
    for (const sample of samples) {
      const key = this.key(sample);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.order.push(key);
      if (this.order.length > WINDOW) this.seen.delete(this.order.shift() as string);
      kept.push(sample);
    }
    return kept;
  }
}
