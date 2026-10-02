import { describe, expect, it } from 'vitest';
import { UnavailableWebUnitConversionPort } from './numbatPort';

describe('UnavailableWebUnitConversionPort', () => {
  it('never pretends to perform dimension-safe conversion in the browser', async () => {
    const port = new UnavailableWebUnitConversionPort();
    expect(port.availability).toBe('unavailable');
    await expect(port.convert({ expression: '10 m', targetUnit: 'cm' })).rejects.toMatchObject({
      code: 'unit-engine-unavailable',
    });
  });
});
