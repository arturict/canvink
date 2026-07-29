import { describe, expect, it } from 'vitest';
import { canAutosave } from './persistencePolicy';

describe('autosave safety gate', () => {
  it('stays closed before storage hydration', () => {
    expect(canAutosave({ storageReady: false, loadFailed: false })).toBe(false);
  });

  it('stays closed after a load failure so defaults cannot overwrite stored data', () => {
    expect(canAutosave({ storageReady: false, loadFailed: true })).toBe(false);
    expect(canAutosave({ storageReady: true, loadFailed: true })).toBe(false);
  });

  it('opens only after a successful load', () => {
    expect(canAutosave({ storageReady: true, loadFailed: false })).toBe(true);
  });
});
