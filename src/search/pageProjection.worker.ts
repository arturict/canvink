/// <reference lib="webworker" />
/**
 * Loads page documents that are not open from their stored bytes and returns
 * their searchable part, off the main thread. Loading a page is a single
 * Automerge call that takes about two seconds for a page with 7,000 strokes;
 * on the main thread that froze the app while search indexed an imported
 * notebook. The worker has its own Automerge instance.
 *
 * The handler is registered before Automerge is imported: Automerge's
 * WebAssembly module initialises with a top-level await, and a module worker
 * drops messages that arrive while it has no handler yet.
 */
import type { PageProjectionRequest } from './pageProjector';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const core = import('./pageProjectionCore');

scope.onmessage = (event: MessageEvent<PageProjectionRequest>) => {
  const request = event.data;
  void core.then(
    ({ projectStoredPage }) => scope.postMessage(projectStoredPage(request)),
    (error: unknown) => scope.postMessage({
      id: request.id,
      ok: false,
      message: `The page projection worker could not start: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
};
