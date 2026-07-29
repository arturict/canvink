import { describe, expect, it } from 'vitest';
import { truncateUtf8, utf8ByteLength } from './strings';

describe('UTF-8 string limits', () => {
  it('counts ASCII and multibyte characters like the Rust storage boundary', () => {
    expect(utf8ByteLength('Canvink')).toBe(7);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('🖋️')).toBe(7);
  });

  it('truncates only at complete Unicode code points', () => {
    expect(truncateUtf8('ab😀c', 6)).toBe('ab😀');
    expect(utf8ByteLength(truncateUtf8('😀😀', 7))).toBeLessThanOrEqual(7);
  });
});
