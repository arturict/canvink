import { describe, expect, it } from 'vitest';
import {
  buildSectionTree,
  canMoveGroupInto,
  groupInsertionIndex,
  groupPathTitle,
  sectionsInDisplayOrder,
  sectionsInGroup,
} from './sectionGroups';

const groups = [
  { id: 'math', title: 'Mathematik' },
  { id: 'done', title: 'z_Abgeschlossen' },
  { id: 'sem1', title: '1. Semester', parentGroupId: 'done' },
];
const sections = [
  { id: 'husi' },
  { id: 'algebra', groupId: 'math' },
  { id: 'deutsch1', groupId: 'sem1' },
  { id: 'nw', groupId: 'done' },
  { id: 'deutsch' },
];

describe('section groups', () => {
  it('lists sections before groups at every level, like OneNote', () => {
    const tree = buildSectionTree(sections, groups);
    expect(tree.sections.map((section) => section.id)).toEqual(['husi', 'deutsch']);
    expect(tree.groups.map((node) => node.group.id)).toEqual(['math', 'done']);
    const done = tree.groups[1];
    expect(done.sections.map((section) => section.id)).toEqual(['nw']);
    expect(done.groups.map((node) => [node.group.id, node.depth])).toEqual([['sem1', 1]]);
    expect(sectionsInDisplayOrder(tree).map((section) => section.id))
      .toEqual(['husi', 'deutsch', 'algebra', 'nw', 'deutsch1']);
  });

  it('reads dangling references and parent cycles as the top level instead of hiding sections', () => {
    const tree = buildSectionTree(
      [{ id: 'lost', groupId: 'gone' }, { id: 'inner', groupId: 'a' }],
      [{ id: 'a', title: 'A', parentGroupId: 'b' }, { id: 'b', title: 'B', parentGroupId: 'a' }, { id: 'c', title: 'C', parentGroupId: 'gone' }],
    );
    expect(tree.sections.map((section) => section.id)).toEqual(['lost']);
    expect(tree.groups.map((node) => node.group.id)).toEqual(['a', 'b', 'c']);
    expect(sectionsInDisplayOrder(tree).map((section) => section.id)).toEqual(['lost', 'inner']);
  });

  it('collects nested sections, paths and forbidden move targets', () => {
    expect(sectionsInGroup(sections, groups, 'done').map((section) => section.id)).toEqual(['deutsch1', 'nw']);
    expect(groupPathTitle(groups, 'sem1')).toBe('z_Abgeschlossen › 1. Semester');
    expect(canMoveGroupInto(groups, 'done', 'sem1')).toBe(false);
    expect(canMoveGroupInto(groups, 'done', 'done')).toBe(false);
    expect(canMoveGroupInto(groups, 'sem1', 'math')).toBe(true);
    expect(canMoveGroupInto(groups, 'sem1', undefined)).toBe(true);
  });

  it('inserts a moved group after its last new sibling or next to an anchor', () => {
    const remaining = groups.filter((group) => group.id !== 'math');
    expect(groupInsertionIndex(remaining, 'done')).toBe(2);
    expect(groupInsertionIndex(remaining, undefined)).toBe(1);
    expect(groupInsertionIndex(remaining, undefined, { groupId: 'done', placement: 'before' })).toBe(0);
    expect(groupInsertionIndex(remaining, 'nowhere')).toBe(2);
  });
});
