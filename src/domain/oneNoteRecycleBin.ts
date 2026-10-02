import type { WorkspaceState } from './types';
import { trashSection } from './workspace';

/**
 * OneNote keeps deleted pages in a hidden section group named
 * "OneNote_RecycleBin" (sections such as "Gelöschte Seiten"). Older imports
 * brought it in as an ordinary group; a second import of the same notebook
 * adds a numeric suffix.
 */
const RECYCLE_BIN_GROUP = /^OneNote_RecycleBin(?: \d+)?$/i;

export function isOneNoteRecycleBinGroupName(title: string): boolean {
  return RECYCLE_BIN_GROUP.test(title.trim());
}

/**
 * Moves the sections of every imported OneNote recycle bin group into
 * Canvink's trash and removes the emptied groups. Idempotent: without such a
 * group the workspace is returned unchanged. A notebook whose only sections
 * sit in the recycle bin is left alone, because a notebook needs a section.
 */
export function trashImportedOneNoteRecycleBin(workspace: WorkspaceState): WorkspaceState {
  let next = workspace;
  for (const notebook of workspace.notebooks) {
    const groups = notebook.sectionGroups ?? [];
    const doomed = new Set(groups.filter((group) => isOneNoteRecycleBinGroupName(group.title)).map((group) => group.id));
    if (doomed.size === 0) continue;
    // Descendants of a recycle bin group belong to it, however deep.
    for (let grew = true; grew;) {
      grew = false;
      for (const group of groups) {
        if (!doomed.has(group.id) && group.parentGroupId && doomed.has(group.parentGroupId)) {
          doomed.add(group.id);
          grew = true;
        }
      }
    }
    const inBin = notebook.sections.filter((section) => section.groupId && doomed.has(section.groupId));
    if (inBin.length === notebook.sections.length) continue;
    for (const section of inBin) next = trashSection(next, notebook.id, section.id);
    next = {
      ...next,
      notebooks: next.notebooks.map((item) =>
        item.id === notebook.id
          ? { ...item, sectionGroups: (item.sectionGroups ?? []).filter((group) => !doomed.has(group.id)) }
          : item,
      ),
    };
  }
  return next;
}
