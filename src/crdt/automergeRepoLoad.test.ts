import * as Automerge from '@automerge/automerge';
import { Repo, type DocHandleChangePayload } from '@automerge/automerge-repo';
import { describe, expect, it } from 'vitest';
import { CanvinkStorageAdapter, MemoryCanvinkStorageBridge } from './canvinkStorageAdapter';

/**
 * Canvink patches automerge-repo (patches/@automerge__automerge-repo@2.5.6.patch)
 * so that a large page loads without computing a patch for every value:
 * storage loads use `Automerge.load`, and the change event of a document that
 * arrives from nothing computes its patches only when a listener reads them.
 * These tests pin the behaviour that must survive the patch.
 */
interface Page {
  title: string;
  points: Array<{ x: number; y: number }>;
}

async function storedDocument(
  bridge: MemoryCanvinkStorageBridge,
  extraBytes?: Uint8Array,
): Promise<{ url: string; heads: string[] }> {
  const writer = new Repo({ storage: new CanvinkStorageAdapter({ bridge }) });
  const handle = writer.create<Page>({ title: 'Algebra', points: [{ x: 1, y: 2 }] });
  handle.change((doc) => {
    doc.points.push({ x: 3, y: 4 });
  });
  await writer.flush();
  const heads = [...Automerge.getHeads(handle.doc())];
  if (extraBytes) {
    const storage = new CanvinkStorageAdapter({ bridge });
    await storage.save([handle.documentId, 'incremental', 'truncated'], extraBytes);
  }
  await writer.shutdown();
  return { url: handle.url, heads };
}

describe('automerge-repo loading (Canvink patch)', () => {
  it('loads a stored document with its content and heads', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const { url, heads } = await storedDocument(bridge);
    const reader = new Repo({ storage: new CanvinkStorageAdapter({ bridge }) });
    const handle = await reader.find<Page>(url as never);
    expect(handle.doc()).toEqual({ title: 'Algebra', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
    expect([...Automerge.getHeads(handle.doc())]).toEqual(heads);
    await reader.shutdown();
  });

  it('still loads what is readable when a stored chunk is truncated', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const partial = Automerge.save(Automerge.from({ other: true })).slice(0, 12);
    const { url } = await storedDocument(bridge, partial);
    const reader = new Repo({ storage: new CanvinkStorageAdapter({ bridge }) });
    const handle = await reader.find<Page>(url as never);
    expect(handle.doc().title).toBe('Algebra');
    await reader.shutdown();
  });

  it('gives a change listener correct patches for a document loaded from storage', async () => {
    const bridge = new MemoryCanvinkStorageBridge();
    const { url } = await storedDocument(bridge);
    const reader = new Repo({ storage: new CanvinkStorageAdapter({ bridge }) });
    const progress = reader.findWithProgress<Page>(url as never);
    const events: Array<DocHandleChangePayload<Page>> = [];
    const paths: string[] = [];
    progress.handle.on('change', (event) => {
      events.push(event);
      // Read synchronously, as the patch requires for a lazy event.
      paths.push(...event.patches.map((patch) => patch.path.join('/')));
    });
    const handle = await reader.find<Page>(url as never);
    expect(handle.doc().points).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(paths).toContain('title');
    expect(paths.some((path) => path.startsWith('points'))).toBe(true);

    // Later changes still carry eager patches.
    handle.change((doc) => {
      doc.title = 'Geometrie';
    });
    expect(events).toHaveLength(2);
    expect(events[1].patches.length).toBeGreaterThan(0);
    expect(events[1].patches.every((patch) => patch.path[0] === 'title')).toBe(true);
    await reader.shutdown();
  });
});
