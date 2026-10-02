import { describe, expect, it } from 'vitest';
import { pageDrawOrder } from './document';

describe('pageDrawOrder', () => {
  const elements = { a: {}, b: {}, c: {} };

  it('returns a consistent order unchanged, as the same array', () => {
    const order = ['a', 'b', 'c'];
    expect(pageDrawOrder(order, elements)).toBe(order);
  });

  it('repairs what concurrent edits leave behind', () => {
    // 'x' was erased on one device while another moved it; 'a' was moved by
    // two devices at once; 'c' is missing from the order.
    expect(pageDrawOrder(['a', 'x', 'b', 'a'], elements)).toEqual(['a', 'b', 'c']);
  });
});
