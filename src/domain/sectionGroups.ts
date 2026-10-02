/**
 * Section groups ("Abschnittsgruppen") as OneNote shows them: a notebook
 * holds sections and groups, a group holds sections and further groups. At
 * each level OneNote lists the sections first and the groups after them, so
 * the tree is derived from two flat lists without a separate order list:
 * sections keep their order in `sections`, groups theirs in `sectionGroups`.
 *
 * Documents can carry references that name no group, or parents that form a
 * cycle after concurrent moves on two devices. Readers place such entries at
 * the top level instead of failing or hiding them.
 */

export interface GroupLike {
  id: string;
  title: string;
  parentGroupId?: string;
}

export interface SectionLike {
  id: string;
  groupId?: string;
}

export interface SectionGroupNode<S extends SectionLike, G extends GroupLike> {
  group: G;
  /** Nesting level: 0 for a group at the notebook's top level. */
  depth: number;
  sections: S[];
  groups: SectionGroupNode<S, G>[];
}

export interface SectionTree<S extends SectionLike, G extends GroupLike> {
  sections: S[];
  groups: SectionGroupNode<S, G>[];
}

/**
 * The parent of every group after repairing dangling parents and cycles;
 * `undefined` means the top level.
 */
export function effectiveGroupParents(groups: readonly GroupLike[]): Map<string, string | undefined> {
  const declared = new Map(groups.map((group) => [group.id, group.parentGroupId]));
  const parents = new Map<string, string | undefined>();
  for (const group of groups) {
    let parent = group.parentGroupId;
    if (parent !== undefined && !declared.has(parent)) parent = undefined;
    // A group whose ancestor chain returns to itself sits at the top level.
    const seen = new Set([group.id]);
    for (let current = parent; current !== undefined; current = declared.get(current)) {
      if (!declared.has(current)) break;
      if (seen.has(current)) {
        parent = undefined;
        break;
      }
      seen.add(current);
    }
    parents.set(group.id, parent);
  }
  return parents;
}

/** The group a section effectively sits in (`undefined`: the top level). */
export function effectiveSectionGroupId(
  section: SectionLike,
  groups: readonly GroupLike[],
): string | undefined {
  return section.groupId && groups.some((group) => group.id === section.groupId)
    ? section.groupId
    : undefined;
}

export function buildSectionTree<S extends SectionLike, G extends GroupLike>(
  sections: readonly S[],
  groups: readonly G[] = [],
): SectionTree<S, G> {
  const parents = effectiveGroupParents(groups);
  const known = new Set(groups.map((group) => group.id));
  const build = (parentId: string | undefined, depth: number): SectionGroupNode<S, G>[] => groups
    .filter((group) => parents.get(group.id) === parentId)
    .map((group) => ({
      group,
      depth,
      sections: sections.filter((section) => section.groupId === group.id),
      groups: build(group.id, depth + 1),
    }));
  return {
    sections: sections.filter((section) => !section.groupId || !known.has(section.groupId)),
    groups: build(undefined, 0),
  };
}

/** The group and every group nested in it, at any depth. */
export function groupSubtreeIds(groups: readonly GroupLike[], groupId: string): Set<string> {
  const parents = effectiveGroupParents(groups);
  const ids = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      const parent = parents.get(group.id);
      if (parent !== undefined && ids.has(parent) && !ids.has(group.id)) {
        ids.add(group.id);
        changed = true;
      }
    }
  }
  return ids;
}

/** Sections inside a group or any group nested in it, in notebook order. */
export function sectionsInGroup<S extends SectionLike>(
  sections: readonly S[],
  groups: readonly GroupLike[],
  groupId: string,
): S[] {
  const ids = groupSubtreeIds(groups, groupId);
  return sections.filter((section) => section.groupId !== undefined && ids.has(section.groupId));
}

/** Enclosing groups of a group or section, outermost first. */
export function groupAncestry(groups: readonly GroupLike[], groupId: string | undefined): string[] {
  const parents = effectiveGroupParents(groups);
  const chain: string[] = [];
  for (let current = groupId; current !== undefined && parents.has(current); current = parents.get(current)) {
    chain.unshift(current);
  }
  return chain;
}

/** "Mathematik › Algebra": the path shown where a group has to be named in a flat list. */
export function groupPathTitle(groups: readonly GroupLike[], groupId: string): string {
  return groupAncestry(groups, groupId)
    .map((id) => groups.find((group) => group.id === id)?.title ?? '')
    .join(' › ');
}

/**
 * Sections in the order the navigation shows them (depth-first, sections
 * before groups at each level); keyboard stepping and "move up/down" follow it.
 */
export function sectionsInDisplayOrder<S extends SectionLike, G extends GroupLike>(
  tree: SectionTree<S, G>,
): S[] {
  const walk = (node: { sections: S[]; groups: SectionGroupNode<S, G>[] }): S[] => [
    ...node.sections,
    ...node.groups.flatMap(walk),
  ];
  return walk(tree);
}

/**
 * Whether moving `groupId` into `targetParentId` is allowed: a group cannot
 * move into itself or into one of its own descendants.
 */
export function canMoveGroupInto(
  groups: readonly GroupLike[],
  groupId: string,
  targetParentId: string | undefined,
): boolean {
  return targetParentId === undefined || !groupSubtreeIds(groups, groupId).has(targetParentId);
}

/**
 * Where a moved group goes in the flat `sectionGroups` list so that it lands
 * before or after `anchorId` among its new siblings, or last among them.
 * Returns an index into the list with the moved group already removed.
 */
export function groupInsertionIndex(
  remaining: readonly GroupLike[],
  targetParentId: string | undefined,
  anchor?: { groupId: string; placement: 'before' | 'after' },
): number {
  const parents = effectiveGroupParents(remaining);
  if (anchor) {
    const index = remaining.findIndex((group) => group.id === anchor.groupId);
    if (index >= 0) return anchor.placement === 'before' ? index : index + 1;
  }
  let last = -1;
  remaining.forEach((group, index) => {
    if (parents.get(group.id) === targetParentId) last = index;
  });
  return last >= 0 ? last + 1 : remaining.length;
}
