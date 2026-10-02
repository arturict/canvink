import { describe, expect, it } from 'vitest';
import {
  applyLocalCommand,
  applyLocalCommandWithOrder,
  createLocalHistory,
  recordLocalCommand,
  recordLocalCommandAfterCommit,
  redoLocalCommand,
  undoLocalCommand,
  type LocalCommand,
} from './history';
import { richText, stroke } from './testFixtures';
import type { MathElementV3 } from '../../domain/v3';
import { packStrokePoints, unpackStrokePoints } from '../../crdt/packedStrokePoints';

describe('device-local immutable command history', () => {
  it('undoes and redoes only the local patch', () => {
    const element = richText();
    const movedFrame = { ...element.frame, x: 50 };
    const command: LocalCommand = {
      commandId: 'move-1',
      deviceId: 'device-a',
      patches: [{ elementId: element.id, before: { frame: element.frame }, after: { frame: movedFrame } }],
    };
    const applied = applyLocalCommand({ [element.id]: element }, command);
    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const undone = undoLocalCommand(history, applied);
    const redone = redoLocalCommand(undone.history, undone.elements);
    expect(undone.elements[element.id].frame.x).toBe(10);
    expect(redone.elements[element.id].frame.x).toBe(50);
  });

  it('rejects a patch that would delete updatedAt on undo', () => {
    const element = richText();
    const command: LocalCommand = {
      commandId: 'move-1',
      deviceId: 'device-a',
      patches: [{
        elementId: element.id,
        before: { frame: element.frame },
        after: { frame: { ...element.frame, x: 50 }, updatedAt: 'later' },
      }],
    };
    expect(() => recordLocalCommand(createLocalHistory('device-a'), command)).toThrow(/updatedAt/);
  });

  it('preserves remote fields and skips a locally changed field modified remotely', () => {
    const element = richText();
    const localFrame = { ...element.frame, x: 50 };
    const command: LocalCommand = {
      commandId: 'move-1',
      deviceId: 'device-a',
      patches: [{ elementId: element.id, before: { frame: element.frame }, after: { frame: localFrame } }],
    };
    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const remotelyChanged = richText({ frame: { ...localFrame, x: 75 }, style: { ...element.style, color: '#f00' } });
    const undone = undoLocalCommand(history, { [element.id]: remotelyChanged });

    expect(undone.elements[element.id].frame.x).toBe(75);
    const undoneElement = undone.elements[element.id];
    expect(undoneElement.kind === 'richText' && undoneElement.style.color).toBe('#f00');
  });

  it('undoes and redoes a stroke against the samples the document stores, not the pointer values', () => {
    const drawn = stroke({ points: stroke().points.map((point) => ({ ...point, x: point.x + 0.123456789, pressure: 0.3333 })) });
    // What the document holds after a packed write, and so what local history sees later.
    const stored = { ...drawn, points: unpackStrokePoints(packStrokePoints(drawn.points) ?? new Uint8Array()) };
    const command: LocalCommand = {
      commandId: 'draw-1',
      deviceId: 'device-a',
      patches: [{ elementId: drawn.id, before: null, after: drawn }],
    };

    const packedHistory = recordLocalCommand(createLocalHistory('device-a'), command, 'packed');
    const listedHistory = recordLocalCommand(createLocalHistory('device-a'), command, 'points');

    expect(undoLocalCommand(packedHistory, { [drawn.id]: stored }).elements).toEqual({});
    // Kept as drawn, the command no longer matches the stored element and would not undo.
    expect(undoLocalCommand(listedHistory, { [drawn.id]: stored }).elements[drawn.id]).toEqual(stored);
  });

  it('rejects commands from another device', () => {
    expect(() =>
      recordLocalCommand(createLocalHistory('device-a'), {
        commandId: 'remote',
        deviceId: 'device-b',
        patches: [{ elementId: 'x', before: null, after: { id: 'x' } }],
      }),
    ).toThrow(/this device/);
  });

  it('applies, undoes, and redoes an atomic multi-patch with stable z-order', () => {
    const firstStroke = stroke({ id: 'stroke-a' });
    const secondStroke = stroke({ id: 'stroke-b' });
    const trailingText = richText({ id: 'tail' });
    const replacement = richText({ id: 'math-block' });
    const beforeOrder = [firstStroke.id, secondStroke.id, trailingText.id];
    const afterOrder = [replacement.id, trailingText.id];
    const before = {
      [firstStroke.id]: firstStroke,
      [secondStroke.id]: secondStroke,
      [trailingText.id]: trailingText,
    };
    const command: LocalCommand = {
      commandId: 'convert-strokes-to-math',
      deviceId: 'device-a',
      patches: [
        { elementId: firstStroke.id, before: firstStroke, after: null },
        { elementId: secondStroke.id, before: secondStroke, after: null },
        { elementId: replacement.id, before: null, after: replacement },
      ],
      zOrderBefore: beforeOrder,
      zOrderAfter: afterOrder,
    };

    const applied = applyLocalCommandWithOrder(
      before,
      beforeOrder,
      command,
    );
    expect(Object.keys(applied.elements).sort()).toEqual(['math-block', 'tail']);
    expect(applied.zOrder).toEqual(['math-block', 'tail']);

    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const undone = undoLocalCommand(history, applied.elements, applied.zOrder);
    expect(Object.keys(undone.elements).sort()).toEqual(['stroke-a', 'stroke-b', 'tail']);
    expect(undone.zOrder).toEqual(['stroke-a', 'stroke-b', 'tail']);

    const redone = redoLocalCommand(undone.history, undone.elements, undone.zOrder);
    expect(Object.keys(redone.elements).sort()).toEqual(['math-block', 'tail']);
    expect(redone.zOrder).toEqual(['math-block', 'tail']);
  });

  it('preserves concurrent order and elements while restoring missing local elements', () => {
    const firstStroke = stroke({ id: 'stroke-a' });
    const secondStroke = stroke({ id: 'stroke-b' });
    const trailingText = richText({ id: 'tail' });
    const remoteText = richText({ id: 'remote' });
    const replacement = richText({ id: 'math-block' });
    const command: LocalCommand = {
      commandId: 'convert-strokes-to-math',
      deviceId: 'device-a',
      patches: [
        { elementId: firstStroke.id, before: firstStroke, after: null },
        { elementId: secondStroke.id, before: secondStroke, after: null },
        { elementId: replacement.id, before: null, after: replacement },
      ],
      zOrderBefore: [firstStroke.id, secondStroke.id, trailingText.id],
      zOrderAfter: [replacement.id, trailingText.id],
    };
    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const current = {
      [replacement.id]: replacement,
      [trailingText.id]: trailingText,
      [remoteText.id]: remoteText,
    };

    const undone = undoLocalCommand(
      history,
      current,
      [remoteText.id, trailingText.id, replacement.id],
    );

    expect(undone.zOrder).toEqual(['remote', 'stroke-a', 'stroke-b', 'tail']);
    expect(new Set(undone.zOrder)).toEqual(new Set(Object.keys(undone.elements)));
  });

  it('keeps a conflicting remote element edit and returns a valid order', () => {
    const original = richText({ id: 'source' });
    const replacement = richText({ id: 'replacement' });
    const locallyApplied = richText({
      id: original.id,
      frame: { ...original.frame, x: 40 },
    });
    const remotelyChanged = richText({
      id: original.id,
      frame: { ...locallyApplied.frame, x: 75 },
    });
    const command: LocalCommand = {
      commandId: 'replace-source',
      deviceId: 'device-a',
      patches: [
        { elementId: original.id, before: original, after: locallyApplied },
        { elementId: replacement.id, before: null, after: replacement },
      ],
      zOrderBefore: [original.id],
      zOrderAfter: [original.id, replacement.id],
    };
    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const undone = undoLocalCommand(
      history,
      { [original.id]: remotelyChanged, [replacement.id]: replacement },
      [replacement.id, original.id],
    );

    expect(undone.elements).toEqual({
      [original.id]: remotelyChanged,
      [replacement.id]: replacement,
    });
    expect(undone.zOrder).toEqual(['replacement', 'source']);
    expect(undone.history).toBe(history);
  });

  it('makes a compound undo a complete no-op when any one element conflicts', () => {
    const first = stroke({ id: 'first' });
    const second = stroke({ id: 'second' });
    const replacement = richText({ id: 'replacement' });
    const command: LocalCommand = {
      commandId: 'atomic-conversion',
      deviceId: 'device-a',
      patches: [
        { elementId: first.id, before: first, after: null },
        { elementId: second.id, before: second, after: null },
        { elementId: replacement.id, before: null, after: replacement },
      ],
      zOrderBefore: [first.id, second.id],
      zOrderAfter: [replacement.id],
    };
    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const remotelyEditedReplacement = richText({
      ...replacement,
      frame: { ...replacement.frame, x: replacement.frame.x + 10 },
    });
    const current = { [replacement.id]: remotelyEditedReplacement };
    const undone = undoLocalCommand(history, current, [replacement.id]);

    expect(undone.elements).toEqual(current);
    expect(undone.zOrder).toEqual([replacement.id]);
    expect(undone.history).toBe(history);
    expect(undone.elements[first.id]).toBeUndefined();
    expect(undone.elements[second.id]).toBeUndefined();
  });

  it('requires paired, unique z-order snapshots', () => {
    const element = richText();
    const base = {
      commandId: 'bad-order',
      deviceId: 'device-a',
      patches: [{ elementId: element.id, before: null, after: element }],
    } satisfies LocalCommand;

    expect(() => recordLocalCommand(createLocalHistory('device-a'), {
      ...base,
      zOrderBefore: [],
    })).toThrow(/provided together/);
    expect(() => recordLocalCommand(createLocalHistory('device-a'), {
      ...base,
      zOrderBefore: [],
      zOrderAfter: [element.id, element.id],
    })).toThrow(/unique/);
  });

  it('records history only after a successful synchronous commit', () => {
    const element = richText();
    const command: LocalCommand = {
      commandId: 'create-text',
      deviceId: 'device-a',
      patches: [{ elementId: element.id, before: null, after: element }],
    };
    const history = createLocalHistory('device-a');

    const rejected = recordLocalCommandAfterCommit(history, command, () => false);
    expect(rejected).toBe(history);
    expect(rejected.past).toHaveLength(0);

    const committed = recordLocalCommandAfterCommit(history, command, () => true);
    expect(committed.past).toHaveLength(1);
    expect(history.past).toHaveLength(0);

    expect(() => recordLocalCommandAfterCommit(history, command, () => {
      throw new Error('commit failed');
    })).toThrow('commit failed');
    expect(history.past).toHaveLength(0);
  });

  it('records history only after a successful asynchronous commit', async () => {
    const element = richText();
    const command: LocalCommand = {
      commandId: 'create-text',
      deviceId: 'device-a',
      patches: [{ elementId: element.id, before: null, after: element }],
    };
    const history = createLocalHistory('device-a');

    await expect(recordLocalCommandAfterCommit(
      history,
      command,
      async () => false,
    )).resolves.toBe(history);
    await expect(recordLocalCommandAfterCommit(
      history,
      command,
      async () => true,
    )).resolves.toMatchObject({ past: [{ commandId: command.commandId }] });
    await expect(recordLocalCommandAfterCommit(
      history,
      command,
      async () => { throw new Error('async commit failed'); },
    )).rejects.toThrow('async commit failed');
    expect(history.past).toHaveLength(0);
  });

  it('immediately undoes an async committed stroke conversion after recognition becomes pending', async () => {
    const source = stroke({ id: 'source-stroke' });
    const replacement: MathElementV3 = {
      id: 'math-block', kind: 'math', inputKind: 'ink',
      frame: { ...source.frame }, createdAt: source.createdAt, updatedAt: source.updatedAt,
      locked: false, autoRecognition: 'inherit',
      rawInk: {
        captureFrame: { ...source.frame },
        sourceStrokes: [{ ...source, locked: true }],
      },
      recognition: { state: 'idle', alternatives: [], warnings: [] },
      result: { state: 'none', diagnostics: [] },
      dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
    };
    const command: LocalCommand = {
      commandId: 'async-convert', deviceId: 'device-a',
      patches: [
        { elementId: source.id, before: source, after: null },
        { elementId: replacement.id, before: null, after: replacement },
      ],
      zOrderBefore: [source.id], zOrderAfter: [replacement.id],
    };
    let confirm: (committed: boolean) => void = () => undefined;
    const confirmation = new Promise<boolean>((resolve) => { confirm = resolve; });
    const recorded = recordLocalCommandAfterCommit(
      createLocalHistory('device-a'), command, () => confirmation,
    );
    confirm(true);
    const history = await recorded;
    const pending: MathElementV3 = {
      ...replacement,
      updatedAt: '2026-08-03T01:00:00.000Z',
      recognition: { state: 'pending', alternatives: [], warnings: ['provider-error:provider-unavailable'] },
      result: { state: 'error', diagnostics: ['Expression is empty.'] },
      dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'undefined' },
    };

    const undone = undoLocalCommand(history, { [pending.id]: pending }, [pending.id]);
    expect(undone.elements[pending.id]).toBeUndefined();
    expect(undone.elements[source.id]).toEqual(source);
    expect(undone.zOrder).toEqual([source.id]);
    expect(undone.history.past).toHaveLength(0);
  });

  it('immediately undoes recomputed typed Math but preserves an authoritative formula edit', async () => {
    const typed: MathElementV3 = {
      id: 'palette-math', kind: 'math', inputKind: 'typed', typedLatex: '+',
      frame: { x: 80, y: 80, width: 320, height: 140, rotation: 0 },
      createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
      locked: false, autoRecognition: 'inherit',
      recognition: { state: 'idle', alternatives: [], warnings: [] },
      result: { state: 'none', diagnostics: [] },
      dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
    };
    const command: LocalCommand = {
      commandId: 'palette-create', deviceId: 'device-a',
      patches: [{ elementId: typed.id, before: null, after: typed }],
    };
    const history = await recordLocalCommandAfterCommit(
      createLocalHistory('device-a'), command, async () => true,
    );
    const recomputed: MathElementV3 = {
      ...typed,
      updatedAt: '2026-08-03T01:00:00.000Z',
      result: { state: 'error', diagnostics: ['Unexpected operator.'] },
      dependencies: { defines: [], references: ['x'], dependsOnElementIds: [], state: 'undefined' },
    };
    const undone = undoLocalCommand(history, { [typed.id]: recomputed });
    expect(undone.elements[typed.id]).toBeUndefined();
    expect(undone.history.past).toHaveLength(0);

    const userEdited = { ...recomputed, typedLatex: '2+3' };
    const conflicted = undoLocalCommand(history, { [typed.id]: userEdited });
    expect(conflicted.elements[typed.id]).toEqual(userEdited);
    expect(conflicted.history).toBe(history);
  });

  it('keeps legacy commands and calls without z-order fully compatible', () => {
    const element = richText();
    const command: LocalCommand = {
      commandId: 'legacy-create',
      deviceId: 'device-a',
      patches: [{ elementId: element.id, before: null, after: element }],
    };
    const applied = applyLocalCommand({}, command);
    const history = recordLocalCommand(createLocalHistory('device-a'), command);
    const undone = undoLocalCommand(history, applied);
    const redone = redoLocalCommand(undone.history, undone.elements);

    expect('zOrder' in undone).toBe(false);
    expect('zOrder' in redone).toBe(false);
    expect(undone.elements).toEqual({});
    expect(redone.elements).toEqual({ [element.id]: element });
  });
});
