import { describe, expect, it } from 'vitest';
import { SampleDeduper } from './inkSampleFilter';

const at = (time: number, x: number, y = 0) => ({ time, x, y });

describe('SampleDeduper', () => {
  it('passes a sample once, however often it is delivered', () => {
    const filter = new SampleDeduper();
    expect(filter.fresh([at(1, 10), at(2, 12)])).toHaveLength(2);
    // The frame's pointermove lists the same two and one more.
    expect(filter.fresh([at(1, 10), at(2, 12), at(3, 15)])).toEqual([at(3, 15)]);
  });

  it('keeps samples that share a timestamp but not a position', () => {
    const filter = new SampleDeduper();
    expect(filter.fresh([at(5, 1), at(5, 2), at(5, 3)])).toHaveLength(3);
    expect(filter.fresh([at(5, 1), at(5, 2), at(5, 3)])).toHaveLength(0);
  });

  it('keeps the order and forgets old samples so memory stays flat', () => {
    const filter = new SampleDeduper();
    const first = Array.from({ length: 1_000 }, (_, index) => at(index, index));
    expect(filter.fresh(first)).toHaveLength(1_000);
    // The newest are still remembered, the oldest long gone.
    expect(filter.fresh([at(999, 999)])).toHaveLength(0);
    expect(filter.fresh([at(0, 0)])).toHaveLength(1);
  });
});
