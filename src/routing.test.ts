import { describe, expect, it } from 'vitest';
import { shouldRenderNotebook } from './routing';

describe('application routing', () => {
  it('opens the notebook at the public demo route', () => {
    expect(shouldRenderNotebook('/app', false)).toBe(true);
    expect(shouldRenderNotebook('/app/import', false)).toBe(true);
  });

  it('keeps the web root as the landing page', () => {
    expect(shouldRenderNotebook('/', false)).toBe(false);
  });

  it('opens the notebook at the Tauri root route', () => {
    expect(shouldRenderNotebook('/', true)).toBe(true);
  });
});
