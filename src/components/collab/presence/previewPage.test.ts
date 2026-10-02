import * as Automerge from '@automerge/automerge';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAutomergeSnapshot, type LivePageDocV2, type PageAutomergeDoc } from '../../../crdt';
import type { StrokeElementV2 } from '../../../domain/v2';
import { referencedInkSegments } from '../../../ink/projection';
import { sealPageInk, type InkPageTarget } from '../../../ink/seal';
import { sharedPlainSnapshot } from '../../../crdt/sharedSnapshot';
import { MemorySegmentBackend, inkSegments, resetInkSegments, type SegmentRemote } from '../../../ink/segmentStore';
import { loadPreviewContent, type ReadDocument } from './previewPage';

const TIME = '2026-09-24T00:00:00.000Z';

function stroke(id: string, x: number): StrokeElementV2 {
  const points = Array.from({ length: 12 }, (_, index) => ({
    x: x + index * 4, y: 40 + (index % 3) * 4, pressure: 0.5, tiltX: 0, tiltY: 0, time: 0, pointerType: 'pen' as const,
  }));
  return {
    id, kind: 'stroke', frame: { x, y: 40, width: 44, height: 8, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', points, color: '#1d4ed8', size: 3, opacity: 1,
  };
}

function page(count: number): Automerge.Doc<LivePageDocV2> {
  const elementsById: Record<string, StrokeElementV2> = {};
  const zOrder: string[] = [];
  for (let index = 0; index < count; index += 1) {
    elementsById[`s${index}`] = stroke(`s${index}`, index * 60);
    zOrder.push(`s${index}`);
  }
  return Automerge.from<LivePageDocV2>({
    schemaVersion: 3, documentId: 'page:1', kind: 'page', notebookId: 'n', sectionId: 's', pageId: 'p',
    title: 'Physik', tags: [], pageType: 'free', background: { type: 'plain', color: '#ffffff' },
    createdAt: TIME, updatedAt: TIME, elementsById, zOrder,
  } as unknown as LivePageDocV2);
}

describe('presence preview content', () => {
  beforeEach(() => {
    resetInkSegments(new MemorySegmentBackend());
  });

  it('fetches the ink segments a page references before painting it', async () => {
    // The author's device seals the strokes into a segment and uploads it to the room.
    const author = resetInkSegments(new MemorySegmentBackend());
    const holder = { doc: page(6) };
    const target: InkPageTarget = {
      read: () => ({ page: sharedPlainSnapshot(holder.doc) as never, version: Automerge.getHeads(holder.doc).join() }),
      change: (message, change) => {
        holder.doc = Automerge.change(holder.doc, { message }, (draft) => change(draft as never));
        return true;
      },
    };
    await sealPageInk(target, author, { minRun: 4, maxStrokes: 1000 });
    const hashes = referencedInkSegments(holder.doc);
    expect(hashes.length).toBeGreaterThan(0);
    const room = new Map<string, Uint8Array>();
    for (const hash of hashes) room.set(hash, (await author.read(hash))!);

    // Another device holds the page document but none of the segments, as a page it never opened.
    resetInkSegments(new MemorySegmentBackend());
    const remote: SegmentRemote = { fetch: async (hash) => room.get(hash) };
    inkSegments().setRemote('room:test', remote);
    const read: ReadDocument = (_id, reader) => Promise.resolve(reader(holder.doc as unknown as PageAutomergeDoc));
    const strokesOf = (value: LivePageDocV2): number => Object.values(value.elementsById).filter((element) => element.kind === 'stroke').length;

    // Before the fix a preview read the page as it stood: no ink at all.
    expect(strokesOf(getAutomergeSnapshot<LivePageDocV2>(holder.doc as unknown as PageAutomergeDoc))).toBe(0);

    const content = await loadPreviewContent('page:1', read, async () => undefined);
    expect(strokesOf(content.page)).toBe(6);
  });
});
