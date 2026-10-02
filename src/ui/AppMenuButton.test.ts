import { describe, expect, it } from 'vitest';
import { menuGroups } from './AppMenuButton';

const item = (id: string) => ({ id, label: id });

describe('menuGroups', () => {
  it('puts one separator between groups', () => {
    const entries = menuGroups([[item('a'), item('b')], [item('c')]], 'm');
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b', 'm-separator-1', 'c']);
    expect(entries[2]).toMatchObject({ kind: 'separator' });
  });

  it('drops unavailable commands and leaves no divider for an empty group', () => {
    const entries = menuGroups([[false, item('a')], [null, false], [item('b')]], 'm');
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'm-separator-2', 'b']);
  });

  it('starts without a separator when the first group is empty', () => {
    expect(menuGroups([[false], [item('a')]], 'm').map((entry) => entry.id)).toEqual(['a']);
  });
});
