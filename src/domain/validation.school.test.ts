import { describe, expect, it } from 'vitest';
import { createDefaultWorkspace } from './sample';
import { getActiveContext } from './workspace';
import { assertWorkspaceShape } from './validation';

describe('school page validation', () => {
  it('accepts paper backgrounds and shape elements', () => {
    const workspace = createDefaultWorkspace();
    const page = getActiveContext(workspace)!.page;
    page.background = 'millimeter';
    page.elements.push({
      id: 'shape-validation',
      kind: 'shape',
      shapeType: 'axes',
      x: 20,
      y: 30,
      width: 300,
      height: 240,
      rotation: 0,
      color: '#1e2925',
      strokeWidth: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(() => assertWorkspaceShape(workspace)).not.toThrow();
  });

  it('rejects unsupported paper and shape values', () => {
    const workspace = createDefaultWorkspace();
    const page = getActiveContext(workspace)!.page;
    Object.assign(page, { background: 'music' });

    expect(() => assertWorkspaceShape(workspace)).toThrow(/background is unsupported/);

    delete (page as { background?: string }).background;
    page.elements.push({
      id: 'bad-shape',
      kind: 'shape',
      shapeType: 'hexagon',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      color: '#000000',
      strokeWidth: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);

    expect(() => assertWorkspaceShape(workspace)).toThrow(/shapeType is unsupported/);
  });
});
