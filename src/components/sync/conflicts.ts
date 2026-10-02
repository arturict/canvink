import * as Automerge from '@automerge/automerge';

export interface ObjectConflict {
  path: string;
  alternatives: number;
}

/**
 * Whether the document's history ever branched. Conflicts come from
 * concurrent changes, which leave several heads or a change with several
 * dependencies (the merge); a history in which every change follows the one
 * before cannot hold one. Only change metadata is read, which is cheap even
 * for a page that is one change of several megabytes.
 */
export function mayHaveConflicts(document: Automerge.Doc<unknown>): boolean {
  if (Automerge.getHeads(document).length > 1) return true;
  return Automerge.getChangesMetaSince(document, []).some((change) => change.deps.length > 1);
}

export function enumerateAutomergeConflicts(document: Automerge.Doc<unknown>): ObjectConflict[] {
  // Scanning a page of 7,000 strokes takes over a second; a page that only
  // this device wrote (the usual case) has nothing to find.
  if (!mayHaveConflicts(document)) return [];
  const conflicts: ObjectConflict[] = [];
  const visited = new Set<object>();
  visit(document as object, '$', conflicts, visited);
  return conflicts.sort((left, right) => left.path.localeCompare(right.path));
}

function visit(value: object, path: string, output: ObjectConflict[], visited: Set<object>): void {
  if (visited.has(value)) return;
  visited.add(value);
  const entries: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.map((child, index) => [index, child])
    : Object.entries(value);
  for (const [key, child] of entries) {
    const alternatives = Automerge.getConflicts(value, key);
    if (alternatives && Object.keys(alternatives).length > 1) {
      output.push({ path: `${path}.${key}`, alternatives: Object.keys(alternatives).length });
    }
    // Ink point lists are written as a whole and never edited point by
    // point (erasing replaces strokes), so a conflict can only occur on the
    // list itself, which the check above covers. Descending would make the
    // scan cost grow with every sampled point of a handwritten page. Packed
    // samples are one byte string, which has nothing to descend into.
    if (key === 'points' && Array.isArray(child)) continue;
    if (child instanceof Uint8Array) continue;
    if (typeof child === 'object' && child !== null) visit(child, `${path}.${key}`, output, visited);
  }
}
