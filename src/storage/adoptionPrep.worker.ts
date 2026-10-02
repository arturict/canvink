/// <reference lib="webworker" />
/**
 * Validates and summarises adopted documents off the main thread. The handler
 * is registered before the core (and with it Automerge's WebAssembly module,
 * which initialises with a top-level await) is imported: a module worker drops
 * messages that arrive before it has a handler.
 */
import type { AdoptionPrepRequest } from './adoptionPrepCore';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const core = import('./adoptionPrepCore');

scope.onmessage = (event: MessageEvent<AdoptionPrepRequest>) => {
  const request = event.data;
  void core.then(
    ({ prepareAdoptedDocument }) => {
      try {
        scope.postMessage({ id: request.id, ok: true, prepared: prepareAdoptedDocument(request) });
      } catch (error) {
        scope.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    },
    (error: unknown) => scope.postMessage({
      id: request.id,
      ok: false,
      message: `The adoption worker could not start: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
};
