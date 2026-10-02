/// <reference lib="webworker" />
/**
 * Runs whole-workspace Automerge jobs (see automergeTaskCore.ts) off the main thread. The handler is
 * registered before the core (and with it Automerge's WebAssembly module, which initialises with a
 * top-level await) is imported: a module worker drops messages that arrive before it has a handler.
 */
import type { AutomergeTaskRequest } from './automergeTaskCore';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const core = import('./automergeTaskCore');

/** The buffers a result owns, so that they move to the page instead of being copied. */
function transferables(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (value instanceof Uint8Array) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
  } else if (Array.isArray(value)) {
    for (const item of value) transferables(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) transferables(item, found);
  }
  return [...found];
}

scope.onmessage = (event: MessageEvent<AutomergeTaskRequest & { id: number }>) => {
  const request = event.data;
  void core.then(
    async ({ runAutomergeTask }) => {
      try {
        const result = await runAutomergeTask(request);
        scope.postMessage({ id: request.id, ok: true, result }, transferables(result));
      } catch (error) {
        scope.postMessage({
          id: request.id,
          ok: false,
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    (error: unknown) => scope.postMessage({
      id: request.id,
      ok: false,
      name: 'Error',
      message: `The Automerge task worker could not start: ${error instanceof Error ? error.message : String(error)}`,
      unavailable: true,
    }),
  );
};
