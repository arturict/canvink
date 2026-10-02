import { describe, expect, it } from 'vitest';
import { checkAndroidUpdate, openAndroidUpdate } from './androidUpdate';

describe('Android update notice', () => {
  it('passes on the newer version the app reports', async () => {
    const invoke = (async (command: string) => (command === 'android_update_check' ? { version: '0.4.0' } : null)) as never;
    await expect(checkAndroidUpdate(invoke)).resolves.toEqual({ version: '0.4.0' });
  });

  it('stays silent when the check or the browser fails', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as never;
    await expect(checkAndroidUpdate(failing)).resolves.toBeNull();
    await expect(openAndroidUpdate(failing)).resolves.toBe(false);
  });

  it('asks the app to open the download without naming an address', async () => {
    const calls: unknown[][] = [];
    const invoke = (async (...args: unknown[]) => {
      calls.push(args);
      return true;
    }) as never;
    await expect(openAndroidUpdate(invoke)).resolves.toBe(true);
    expect(calls).toEqual([['android_update_open']]);
  });
});
