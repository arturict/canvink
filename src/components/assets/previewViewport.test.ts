import { describe, expect, it, vi } from 'vitest';
import { DecodedBudget } from './previewViewport';

describe('decoded picture budget', () => {
  it('evicts the least recently used unpinned pictures first and never a pinned one', () => {
    const budget = new DecodedBudget(100);
    const evicted: string[] = [];
    const add = (key: string, bytes: number) => budget.add(key, bytes, () => evicted.push(key));
    add('a', 40);
    add('b', 40);
    budget.pin('a', false);
    budget.pin('b', false);
    add('c', 40);
    // a and b are free to go, c is looked at: over budget by 20, so the oldest goes.
    expect(evicted).toEqual(['a']);
    expect(budget.stats()).toEqual({ bytes: 80, pictures: 2 });
  });

  it('counts touching a picture as use and keeps pinned pictures even over budget', () => {
    const budget = new DecodedBudget(50);
    const evict = vi.fn();
    budget.add('a', 40, evict);
    budget.add('b', 40, evict);
    expect(evict).not.toHaveBeenCalled();
    budget.pin('a', false);
    budget.pin('b', false);
    budget.pin('a', false);
    budget.add('c', 10, evict);
    budget.pin('c', false);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(budget.stats().pictures).toBe(2);
  });

  it('forgets a removed picture without calling its eviction', () => {
    const budget = new DecodedBudget(10);
    const evict = vi.fn();
    budget.add('a', 8, evict);
    budget.remove('a');
    expect(budget.stats()).toEqual({ bytes: 0, pictures: 0 });
    expect(evict).not.toHaveBeenCalled();
  });
});
