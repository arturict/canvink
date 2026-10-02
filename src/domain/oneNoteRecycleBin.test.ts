import { describe, expect, it } from 'vitest';
import { trashImportedOneNoteRecycleBin } from './oneNoteRecycleBin';
import { createDefaultWorkspace } from './sample';
import type { WorkspaceState } from './types';

function withRecycleBin(): WorkspaceState {
  const workspace = createDefaultWorkspace('de');
  const [notebook] = workspace.notebooks;
  const template = notebook.sections[0];
  const bin = { ...template, id: 'bin-section', title: 'Gelöschte Seiten', groupId: 'inner' };
  return {
    ...workspace,
    notebooks: [{
      ...notebook,
      sections: [...notebook.sections, bin],
      sectionGroups: [
        { id: 'bin', title: 'OneNote_RecycleBin 2' },
        { id: 'inner', title: 'Alt', parentGroupId: 'bin' },
        { id: 'keep', title: 'Semester 1' },
      ],
    }, ...workspace.notebooks.slice(1)],
  };
}

describe('imported OneNote recycle bin cleanup', () => {
  it('moves its sections to the trash, drops its groups and is idempotent', () => {
    const cleaned = trashImportedOneNoteRecycleBin(withRecycleBin());
    const [notebook] = cleaned.notebooks;
    expect(notebook.sections.some((section) => section.id === 'bin-section')).toBe(false);
    expect(notebook.sectionGroups?.map((group) => group.id)).toEqual(['keep']);
    expect(cleaned.trash.map((entry) => [entry.kind, entry.item.id])).toEqual([['section', 'bin-section']]);
    expect(trashImportedOneNoteRecycleBin(cleaned)).toBe(cleaned);
  });

  it('leaves workspaces without a recycle bin untouched', () => {
    const workspace = createDefaultWorkspace('de');
    expect(trashImportedOneNoteRecycleBin(workspace)).toBe(workspace);
  });
});
