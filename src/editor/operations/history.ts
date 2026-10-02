import { withStoredPrecision, type StrokeStorageFormat } from '../../crdt/strokeStorage';
import type { PageElementV3 as PageElementV2 } from '../../domain/v3';

export interface ElementPatch {
  elementId: string;
  before: Partial<PageElementV2> | null;
  after: Partial<PageElementV2> | null;
}

export interface LocalCommand {
  commandId: string;
  deviceId: string;
  patches: readonly ElementPatch[];
  /**
   * Optional page ordering owned by the same atomic command as `patches`.
   * Both snapshots are required together. Undo/redo preserves a concurrent
   * remote order while inserting restored local elements beside their nearest
   * surviving target-order neighbour.
   */
  zOrderBefore?: readonly string[];
  zOrderAfter?: readonly string[];
  /**
   * For elements this command deletes or creates: the element directly below
   * each one when the command ran, so undo and redo put it back at the same
   * depth. Cheaper than zOrder snapshots on pages with thousands of strokes.
   */
  anchors?: Readonly<Record<string, string | null>>;
}

export interface LocalHistoryState {
  deviceId: string;
  past: readonly LocalCommand[];
  future: readonly LocalCommand[];
}

export interface LocalCommandState {
  elements: Record<string, PageElementV2>;
  zOrder: string[];
}

export interface LocalHistoryApplication {
  history: LocalHistoryState;
  elements: Record<string, PageElementV2>;
}

export interface OrderedLocalHistoryApplication extends LocalHistoryApplication {
  zOrder: string[];
}

export function createLocalHistory(deviceId: string): LocalHistoryState {
  if (!deviceId) throw new Error('deviceId must not be empty');
  return { deviceId, past: [], future: [] };
}

/**
 * Records a command. Stroke samples in its patches are rounded to what the
 * document will store (see `withStoredPrecision`), because undo and redo
 * match patches against the stored elements exactly.
 */
export function recordLocalCommand(
  history: LocalHistoryState,
  command: LocalCommand,
  strokeFormat?: StrokeStorageFormat,
): LocalHistoryState {
  validateLocalCommand(history, command);
  const recorded = structuredClone({
    ...command,
    patches: command.patches.map((patch) => ({
      ...patch,
      before: withStoredPrecision(patch.before, strokeFormat),
      after: withStoredPrecision(patch.after, strokeFormat),
    })),
  });
  return { ...history, past: [...history.past, recorded], future: [] };
}

/**
 * Runs a commit and records its command only after the caller explicitly
 * confirms success. Existing callers can keep using `recordLocalCommand`;
 * integrations with fallible persistence should use this helper instead.
 */
export function recordLocalCommandAfterCommit(
  history: LocalHistoryState,
  command: LocalCommand,
  commit: () => Promise<boolean>,
): Promise<LocalHistoryState>;
export function recordLocalCommandAfterCommit(
  history: LocalHistoryState,
  command: LocalCommand,
  commit: () => boolean,
): LocalHistoryState;
export function recordLocalCommandAfterCommit(
  history: LocalHistoryState,
  command: LocalCommand,
  commit: () => boolean | Promise<boolean>,
): LocalHistoryState | Promise<LocalHistoryState> {
  validateLocalCommand(history, command);
  const confirmation = commit();
  if (isPromiseLike(confirmation)) {
    return confirmation.then((committed) => {
      assertCommitConfirmation(committed);
      return committed ? recordLocalCommand(history, command) : history;
    });
  }
  assertCommitConfirmation(confirmation);
  return confirmation ? recordLocalCommand(history, command) : history;
}

function validateLocalCommand(history: LocalHistoryState, command: LocalCommand): void {
  if (command.deviceId !== history.deviceId) {
    throw new Error('Only commands created by this device belong in local history');
  }
  if (!command.commandId || command.patches.length === 0) {
    throw new Error('Local commands require an ID and at least one patch');
  }
  if (command.patches.some((patch) => patch.before === null && patch.after === null)) {
    throw new Error('A local patch must create, update, or delete an element');
  }
  const dropsTimestamp = command.patches.find((patch) => patch.before !== null && patch.after !== null
    && Object.hasOwn(patch.after, 'updatedAt') && !Object.hasOwn(patch.before, 'updatedAt'));
  if (dropsTimestamp) {
    // Undo would delete the required updatedAt of the element instead of restoring it.
    throw new Error(`Patch for ${dropsTimestamp.elementId} writes updatedAt but does not record the previous one`);
  }
  const hasBeforeOrder = command.zOrderBefore !== undefined;
  const hasAfterOrder = command.zOrderAfter !== undefined;
  if (hasBeforeOrder !== hasAfterOrder) {
    throw new Error('Local command zOrder snapshots must be provided together');
  }
  if (command.zOrderBefore) validateZOrder(command.zOrderBefore, 'before');
  if (command.zOrderAfter) validateZOrder(command.zOrderAfter, 'after');
}

export function applyLocalCommand(
  elements: Readonly<Record<string, PageElementV2>>,
  command: LocalCommand,
): Record<string, PageElementV2> {
  return applyPatches(elements, command.patches, 'forward');
}

export function applyLocalCommandWithOrder(
  elements: Readonly<Record<string, PageElementV2>>,
  zOrder: readonly string[],
  command: LocalCommand,
): LocalCommandState {
  const nextElements = applyLocalCommand(elements, command);
  return {
    elements: nextElements,
    zOrder: applyZOrder(zOrder, command, 'forward', nextElements),
  };
}

export function undoLocalCommand(
  history: LocalHistoryState,
  elements: Readonly<Record<string, PageElementV2>>,
): LocalHistoryApplication;
export function undoLocalCommand(
  history: LocalHistoryState,
  elements: Readonly<Record<string, PageElementV2>>,
  zOrder: readonly string[],
): OrderedLocalHistoryApplication;
export function undoLocalCommand(
  history: LocalHistoryState,
  elements: Readonly<Record<string, PageElementV2>>,
  zOrder?: readonly string[],
): LocalHistoryApplication | OrderedLocalHistoryApplication {
  const command = history.past.at(-1);
  if (!command) {
    return zOrder === undefined
      ? { history, elements: { ...elements } }
      : { history, elements: { ...elements }, zOrder: [...zOrder] };
  }
  if (hasAtomicMultiElementConflict(elements, command, 'backward')) {
    return zOrder === undefined
      ? { history, elements: { ...elements } }
      : { history, elements: { ...elements }, zOrder: [...zOrder] };
  }
  const result: LocalHistoryApplication | OrderedLocalHistoryApplication = {
    elements: applyPatches(elements, [...command.patches].reverse(), 'backward'),
    history: {
      ...history,
      past: history.past.slice(0, -1),
      future: [command, ...history.future],
    },
  };
  if (zOrder !== undefined) {
    return {
      ...result,
      zOrder: applyZOrder(zOrder, command, 'backward', result.elements),
    };
  }
  return result;
}

export function redoLocalCommand(
  history: LocalHistoryState,
  elements: Readonly<Record<string, PageElementV2>>,
): LocalHistoryApplication;
export function redoLocalCommand(
  history: LocalHistoryState,
  elements: Readonly<Record<string, PageElementV2>>,
  zOrder: readonly string[],
): OrderedLocalHistoryApplication;
export function redoLocalCommand(
  history: LocalHistoryState,
  elements: Readonly<Record<string, PageElementV2>>,
  zOrder?: readonly string[],
): LocalHistoryApplication | OrderedLocalHistoryApplication {
  const command = history.future[0];
  if (!command) {
    return zOrder === undefined
      ? { history, elements: { ...elements } }
      : { history, elements: { ...elements }, zOrder: [...zOrder] };
  }
  if (hasAtomicMultiElementConflict(elements, command, 'forward')) {
    return zOrder === undefined
      ? { history, elements: { ...elements } }
      : { history, elements: { ...elements }, zOrder: [...zOrder] };
  }
  const result: LocalHistoryApplication | OrderedLocalHistoryApplication = {
    elements: applyPatches(elements, command.patches, 'forward'),
    history: {
      ...history,
      past: [...history.past, command],
      future: history.future.slice(1),
    },
  };
  if (zOrder !== undefined) {
    return {
      ...result,
      zOrder: applyZOrder(zOrder, command, 'forward', result.elements),
    };
  }
  return result;
}

function applyZOrder(
  current: readonly string[],
  command: LocalCommand,
  direction: 'forward' | 'backward',
  elements: Readonly<Record<string, PageElementV2>>,
): string[] {
  if (!command.zOrderBefore || !command.zOrderAfter) {
    return completeZOrder(current, [], elements);
  }
  const expected = direction === 'forward' ? command.zOrderBefore : command.zOrderAfter;
  const replacement = direction === 'forward' ? command.zOrderAfter : command.zOrderBefore;
  const base = deepEqual(current, expected) ? replacement : current;
  return completeZOrder(base, [replacement, current], elements);
}

function completeZOrder(
  base: readonly string[],
  references: readonly (readonly string[])[],
  elements: Readonly<Record<string, PageElementV2>>,
): string[] {
  const available = new Set(Object.keys(elements));
  const result = base.filter((id, index) => available.has(id) && base.indexOf(id) === index);
  for (const reference of references) insertMissingByReference(result, reference, available);
  for (const id of available) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function insertMissingByReference(
  order: string[],
  reference: readonly string[],
  available: ReadonlySet<string>,
): void {
  for (let referenceIndex = 0; referenceIndex < reference.length; referenceIndex += 1) {
    const id = reference[referenceIndex];
    if (!available.has(id) || order.includes(id)) continue;
    const previous = [...reference.slice(0, referenceIndex)]
      .reverse()
      .find((candidate) => order.includes(candidate));
    if (previous) {
      order.splice(order.indexOf(previous) + 1, 0, id);
      continue;
    }
    const next = reference.slice(referenceIndex + 1)
      .find((candidate) => order.includes(candidate));
    if (next) order.splice(order.indexOf(next), 0, id);
    else order.push(id);
  }
}

function validateZOrder(zOrder: readonly string[], phase: 'before' | 'after'): void {
  if (zOrder.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error(`Local command ${phase} zOrder must contain non-empty element IDs`);
  }
  if (new Set(zOrder).size !== zOrder.length) {
    throw new Error(`Local command ${phase} zOrder must contain unique element IDs`);
  }
}

function assertCommitConfirmation(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error('A local command commit must explicitly confirm success or failure');
  }
}

function isPromiseLike(value: unknown): value is Promise<boolean> {
  return typeof value === 'object' && value !== null && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}

function applyPatches(
  source: Readonly<Record<string, PageElementV2>>,
  patches: readonly ElementPatch[],
  direction: 'forward' | 'backward',
): Record<string, PageElementV2> {
  const result = { ...source };
  for (const patch of patches) {
    const expected = direction === 'forward' ? patch.before : patch.after;
    const replacement = direction === 'forward' ? patch.after : patch.before;
    const current = result[patch.elementId];
    if (expected === null) {
      if (!current && replacement) result[patch.elementId] = structuredClone(replacement) as PageElementV2;
      continue;
    }
    if (replacement === null) {
      if (current && (
        patchMatches(current, expected)
        || mathDerivedFieldsMatch(current, expected)
      )) delete result[patch.elementId];
      continue;
    }
    if (!current) continue;
    const next = { ...current } as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const replacementRecord = replacement as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(replacementRecord)]);
    for (const key of keys) {
      const expectedHasKey = Object.hasOwn(expectedRecord, key);
      if (
        expectedHasKey
          ? !deepEqual(next[key], expectedRecord[key])
          : Object.hasOwn(next, key)
      ) {
        continue;
      }
      if (Object.hasOwn(replacementRecord, key)) {
        next[key] = structuredClone(replacementRecord[key]);
      } else {
        delete next[key];
      }
    }
    result[patch.elementId] = next as unknown as PageElementV2;
  }
  return result;
}

/**
 * Compound commands spanning multiple elements are an atomic unit. A remote
 * conflict in any owned field keeps the whole command on its current history
 * stack so a later retry cannot expose a half-restored conversion/grouping.
 * Single-element commands intentionally retain the field-level three-way merge.
 */
function hasAtomicMultiElementConflict(
  source: Readonly<Record<string, PageElementV2>>,
  command: LocalCommand,
  direction: 'forward' | 'backward',
): boolean {
  if (new Set(command.patches.map((patch) => patch.elementId)).size <= 1) {
    const patch = command.patches[0];
    if (direction !== 'backward' || patch?.before !== null || patch.after?.kind !== 'math') return false;
    const current = source[patch.elementId];
    return current === undefined
      || (!patchMatches(current, patch.after) && !mathDerivedFieldsMatch(current, patch.after));
  }
  return command.patches.some((patch) => {
    const expected = direction === 'forward' ? patch.before : patch.after;
    const replacement = direction === 'forward' ? patch.after : patch.before;
    const current = source[patch.elementId];
    if (expected === null) return current !== undefined;
    if (replacement === null) return current === undefined
      || (!patchMatches(current, expected) && !mathDerivedFieldsMatch(current, expected));
    if (!current) return true;
    const currentRecord = current as unknown as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const replacementRecord = replacement as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(replacementRecord)]);
    return [...keys].some((key) => Object.hasOwn(expectedRecord, key)
      ? !deepEqual(currentRecord[key], expectedRecord[key])
      : Object.hasOwn(currentRecord, key));
  });
}

const MATH_DERIVED_KEYS = new Set(['result', 'dependencies', 'updatedAt']);
const COMPLETE_MATH_PATCH_KEYS = [
  'id', 'kind', 'frame', 'createdAt', 'updatedAt', 'locked', 'inputKind',
  'autoRecognition', 'recognition', 'result', 'dependencies',
] as const;

/**
 * Local page results/dependencies are derived and are deliberately not separate
 * history commands. Scheduled/pending recognition is likewise derived from an
 * explicit ink block. Neither may make structural Math creation/conversion
 * impossible to undo. The normalized full objects still compare every
 * authoritative field and optional key, so formula/raw-ink/layout/settings
 * edits remain conflicts.
 */
function mathDerivedFieldsMatch(
  current: PageElementV2,
  expected: Partial<PageElementV2>,
): boolean {
  if (current.kind !== 'math' || expected.kind !== 'math') return false;
  const expectedRecord = expected as Record<string, unknown>;
  if (COMPLETE_MATH_PATCH_KEYS.some((key) => !Object.hasOwn(expectedRecord, key))) return false;
  const currentComparable = structuredClone(current) as unknown as Record<string, unknown>;
  const expectedComparable = structuredClone(expectedRecord);
  for (const key of MATH_DERIVED_KEYS) {
    delete currentComparable[key];
    delete expectedComparable[key];
  }
  if (current.recognition.state === 'scheduled' || current.recognition.state === 'pending') {
    delete currentComparable.recognition;
    delete expectedComparable.recognition;
  }
  return deepEqual(currentComparable, expectedComparable);
}

function patchMatches(element: PageElementV2, patch: Partial<PageElementV2>): boolean {
  return Object.entries(patch).every(([key, value]) =>
    deepEqual((element as unknown as Record<string, unknown>)[key], value),
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
