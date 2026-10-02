import { createOneNoteImportPreview } from '../preview';
import type {
  GraphNotebookInput,
  GraphOneNoteImportInput,
  GraphPageInput,
  GraphResourceInput,
  GraphSectionInput,
} from '../types';
import { graphError, OneNoteGraphAcquisitionError } from './errors';
import {
  canonicalGraphResourceUrl,
  extractGraphResourceReferences,
  validateGraphUrl,
  type GraphHtmlResourceReference,
} from './resourceReferences';
import type {
  GraphDelay,
  GraphSha256,
  MicrosoftGraphOneNoteClient,
  MicrosoftGraphOneNoteClientOptions,
  OneNoteGraphAcquisition,
  OneNoteGraphAcquisitionStats,
  OneNoteGraphAcquireOptions,
  OneNoteGraphLimits,
  OneNoteGraphPreviewOptions,
  OneNoteGraphRetryPolicy,
} from './types';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/me/onenote/';
const DEFAULT_LIMITS: OneNoteGraphLimits = {
  maxNotebooks: 100,
  maxSections: 1_000,
  maxSectionGroups: 500,
  maxSectionGroupDepth: 16,
  maxPages: 10_000,
  maxResources: 20_000,
  maxPaginationPages: 100,
  maxRequests: 25_000,
  maxMetadataResponseBytes: 2 * 1024 * 1024,
  maxTotalMetadataBytes: 50 * 1024 * 1024,
  maxPageHtmlBytes: 5 * 1024 * 1024,
  maxTotalPageHtmlBytes: 100 * 1024 * 1024,
  maxResourceBytes: 50 * 1024 * 1024,
  maxTotalResourceBytes: 500 * 1024 * 1024,
};
const DEFAULT_RETRY: OneNoteGraphRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
};
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface JsonCollection<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

interface GraphNotebookJson {
  id: string;
  displayName: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

type GraphSectionJson = GraphNotebookJson;

type GraphSectionGroupJson = GraphNotebookJson;

interface GraphPageJson {
  id: string;
  title: string;
  order?: number;
  level?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

interface RequestState {
  signal: AbortSignal;
  stats: OneNoteGraphAcquisitionStats;
}

interface BoundedResponse {
  bytes: Uint8Array;
  contentType?: string;
}

interface PendingSection {
  metadata: GraphSectionJson;
  order: number;
  /** Names of the enclosing section groups, outermost first. */
  groupPath: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredString(value: unknown, operation: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw graphError({ code: 'invalid-response', operation });
  }
  return value;
}

function parseNotebook(value: unknown, operation: string): GraphNotebookJson {
  if (!isRecord(value)) throw graphError({ code: 'invalid-response', operation });
  return {
    id: requiredString(value.id, operation),
    displayName: requiredString(value.displayName, operation),
    createdDateTime: optionalString(value.createdDateTime),
    lastModifiedDateTime: optionalString(value.lastModifiedDateTime),
  };
}

function parsePage(value: unknown, operation: string): GraphPageJson {
  if (!isRecord(value)) throw graphError({ code: 'invalid-response', operation });
  const order = Number.isSafeInteger(value.order) ? value.order as number : undefined;
  const level = Number.isSafeInteger(value.level) && (value.level as number) >= 0 ? value.level as number : undefined;
  return {
    id: requiredString(value.id, operation),
    title: typeof value.title === 'string' && value.title.trim() ? value.title : 'Untitled page',
    order,
    level,
    createdDateTime: optionalString(value.createdDateTime),
    lastModifiedDateTime: optionalString(value.lastModifiedDateTime),
  };
}

function abortError(operation: string): OneNoteGraphAcquisitionError {
  return graphError({ code: 'aborted', operation });
}

function throwIfAborted(signal: AbortSignal, operation: string): void {
  if (signal.aborted) throw abortError(operation);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, operation: string): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(operation));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(operation));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const defaultDelay: GraphDelay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(abortError('retry-delay'));
    return;
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, milliseconds);
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError('retry-delay'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
});

async function defaultSha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw graphError({ code: 'invalid-response', operation: 'hash-resource' });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function retryDelay(response: Response | undefined, attempt: number, policy: OneNoteGraphRetryPolicy): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(policy.maxDelayMs, Math.ceil(seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(policy.maxDelayMs, Math.max(0, date - Date.now()));
  }
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** attempt));
}

function mediaType(value: string | null | undefined): string | undefined {
  const normalized = value?.split(';', 1)[0].trim().toLowerCase();
  return normalized && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized) ? normalized : undefined;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  operation: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    void response.body?.cancel();
    throw graphError({ code: 'limit-exceeded', operation });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await abortable(reader.read(), signal, operation);
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw graphError({ code: 'limit-exceeded', operation });
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeText(bytes: Uint8Array, operation: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw graphError({ code: 'invalid-response', operation });
  }
}

function collection(value: unknown, operation: string): JsonCollection<unknown> {
  if (!isRecord(value) || !Array.isArray(value.value)) throw graphError({ code: 'invalid-response', operation });
  const nextLink = value['@odata.nextLink'];
  if (nextLink !== undefined && typeof nextLink !== 'string') throw graphError({ code: 'invalid-response', operation });
  return { value: value.value, '@odata.nextLink': nextLink };
}

function safePositiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function mergeLimits(overrides: Partial<OneNoteGraphLimits> | undefined): OneNoteGraphLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive safe integer.`);
  }
  return limits;
}

function mergeRetry(overrides: Partial<OneNoteGraphRetryPolicy> | undefined): OneNoteGraphRetryPolicy {
  const retry = { ...DEFAULT_RETRY, ...overrides };
  if (!Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < 0) throw new TypeError('maxRetries must be a non-negative safe integer.');
  retry.baseDelayMs = safePositiveInteger(retry.baseDelayMs, DEFAULT_RETRY.baseDelayMs);
  retry.maxDelayMs = safePositiveInteger(retry.maxDelayMs, DEFAULT_RETRY.maxDelayMs);
  return retry;
}

export function createMicrosoftGraphOneNoteClient(
  options: MicrosoftGraphOneNoteClientOptions,
): MicrosoftGraphOneNoteClient {
  const limits = mergeLimits(options.limits);
  const retry = mergeRetry(options.retry);
  const delay = options.delay ?? defaultDelay;
  const sha256: GraphSha256 = options.sha256 ?? defaultSha256;
  const requestTimeoutMs = safePositiveInteger(options.requestTimeoutMs ?? 15_000, 15_000);

  const request = async (
    urlValue: string,
    accept: string,
    maxBytes: number,
    operation: string,
    state: RequestState,
  ): Promise<BoundedResponse> => {
    const url = validateGraphUrl(urlValue, operation);
    for (let attempt = 0; attempt <= retry.maxRetries; attempt += 1) {
      throwIfAborted(state.signal, operation);
      if (state.stats.requests >= limits.maxRequests) throw graphError({ code: 'limit-exceeded', operation: 'request-count' });
      state.stats.requests += 1;
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      state.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, requestTimeoutMs);
      let response: Response | undefined;
      let retryableFailure: boolean;
      try {
        let token: string;
        try {
          token = await abortable(options.getAccessToken(controller.signal), controller.signal, operation);
        } catch (error) {
          if (timedOut) throw graphError({ code: 'timeout', operation, retryable: true });
          if (state.signal.aborted || (error instanceof OneNoteGraphAcquisitionError && error.code === 'aborted')) throw abortError(operation);
          throw graphError({ code: 'token-unavailable', operation });
        }
        if (!token || token.length > 16_384 || /\s/.test(token)) throw graphError({ code: 'token-unavailable', operation });
        response = await abortable(options.fetch(url, {
          method: 'GET',
          headers: { Accept: accept, Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: controller.signal,
        }), controller.signal, operation);
        if (RETRYABLE_STATUS.has(response.status)) {
          retryableFailure = true;
        } else if (!response.ok) {
          void response.body?.cancel();
          throw graphError({
            code: 'http-error',
            operation,
            status: response.status,
            requestId: response.headers.get('request-id') ?? undefined,
          });
        } else {
          const bytes = await readBoundedBytes(response, maxBytes, controller.signal, operation);
          return { bytes, contentType: response.headers.get('content-type') ?? undefined };
        }
      } catch (error) {
        if (timedOut) retryableFailure = true;
        else if (state.signal.aborted) throw abortError(operation);
        else if (error instanceof OneNoteGraphAcquisitionError) {
          if (error.code === 'timeout' || error.code === 'network-error') retryableFailure = error.retryable;
          else throw error;
        } else retryableFailure = true;
      } finally {
        clearTimeout(timer);
        state.signal.removeEventListener('abort', onAbort);
      }
      if (!retryableFailure || attempt >= retry.maxRetries) {
        if (timedOut) throw graphError({ code: 'timeout', operation, retryable: true });
        if (response && RETRYABLE_STATUS.has(response.status)) {
          void response.body?.cancel();
          throw graphError({
            code: 'http-error',
            operation,
            retryable: RETRYABLE_STATUS.has(response.status),
            status: response.status,
            requestId: response.headers.get('request-id') ?? undefined,
          });
        }
        throw graphError({ code: 'network-error', operation, retryable: true });
      }
      state.stats.retries += 1;
      void response?.body?.cancel();
      try {
        await delay(retryDelay(response, attempt, retry), state.signal);
      } catch {
        if (state.signal.aborted) throw abortError(operation);
        throw graphError({ code: 'network-error', operation: 'retry-delay' });
      }
    }
    throw graphError({ code: 'network-error', operation });
  };

  const requestJson = async (url: string, operation: string, state: RequestState): Promise<unknown> => {
    const remaining = limits.maxTotalMetadataBytes - state.stats.metadataBytes;
    if (remaining <= 0) throw graphError({ code: 'limit-exceeded', operation: 'total-metadata-bytes' });
    const response = await request(url, 'application/json', Math.min(limits.maxMetadataResponseBytes, remaining), operation, state);
    state.stats.metadataBytes += response.bytes.byteLength;
    try {
      return JSON.parse(decodeText(response.bytes, operation)) as unknown;
    } catch (error) {
      if (error instanceof OneNoteGraphAcquisitionError) throw error;
      throw graphError({ code: 'invalid-response', operation });
    }
  };

  const paged = async <T>(
    initialUrl: string,
    operation: string,
    parse: (value: unknown, operation: string) => T,
    maxItems: number,
    state: RequestState,
  ): Promise<T[]> => {
    const result: T[] = [];
    const seen = new Set<string>();
    let next: string | undefined = initialUrl;
    const expectedPathname = new URL(validateGraphUrl(initialUrl, operation)).pathname;
    let pageCount = 0;
    while (next) {
      const validated = validateGraphUrl(next, operation);
      if (new URL(validated).pathname !== expectedPathname) throw graphError({ code: 'unsafe-url', operation });
      if (seen.has(validated)) throw graphError({ code: 'invalid-response', operation });
      seen.add(validated);
      pageCount += 1;
      if (pageCount > limits.maxPaginationPages) throw graphError({ code: 'limit-exceeded', operation });
      const payload = collection(await requestJson(validated, operation, state), operation);
      if (result.length + payload.value.length > maxItems) throw graphError({ code: 'limit-exceeded', operation });
      result.push(...payload.value.map((item) => parse(item, operation)));
      next = payload['@odata.nextLink'];
    }
    return result;
  };

  const acquire = async (acquireOptions: OneNoteGraphAcquireOptions = {}): Promise<OneNoteGraphAcquisition> => {
    const signal = acquireOptions.signal ?? new AbortController().signal;
    const stats: OneNoteGraphAcquisitionStats = { requests: 0, retries: 0, metadataBytes: 0, pageHtmlBytes: 0, resourceBytes: 0 };
    const state: RequestState = { signal, stats };
    throwIfAborted(signal, 'acquire');
    const notebooks = await paged(
      `${GRAPH_ROOT}notebooks?$select=id,displayName,createdDateTime,lastModifiedDateTime&$top=100`,
      'list-notebooks',
      parseNotebook,
      limits.maxNotebooks,
      state,
    );
    const selectedIds = acquireOptions.notebookIds ? new Set(acquireOptions.notebookIds) : undefined;
    if (selectedIds?.size !== acquireOptions.notebookIds?.length) throw graphError({ code: 'invalid-response', operation: 'select-notebooks' });
    const selected = selectedIds ? notebooks.filter((notebook) => selectedIds.has(notebook.id)) : notebooks;
    if (selectedIds && selected.length !== selectedIds.size) throw graphError({ code: 'invalid-response', operation: 'select-notebooks' });

    const seenNotebookIds = new Set<string>();
    const seenSectionIds = new Set<string>();
    const seenSectionGroupIds = new Set<string>();
    const seenPageIds = new Set<string>();
    const resourceReferences = new Map<string, GraphHtmlResourceReference>();
    let sectionCount = 0;
    let sectionGroupCount = 0;
    let pageCount = 0;
    const importedNotebooks: GraphNotebookInput[] = [];

    for (const notebook of selected) {
      if (seenNotebookIds.has(notebook.id)) throw graphError({ code: 'invalid-response', operation: 'list-notebooks' });
      seenNotebookIds.add(notebook.id);
      const pendingSections: PendingSection[] = [];
      const addSections = (sections: GraphSectionJson[], groupPath: string[]) => {
        for (const section of sections) {
          if (seenSectionIds.has(section.id)) throw graphError({ code: 'invalid-response', operation: 'list-sections' });
          seenSectionIds.add(section.id);
          sectionCount += 1;
          if (sectionCount > limits.maxSections) throw graphError({ code: 'limit-exceeded', operation: 'section-count' });
          pendingSections.push({ metadata: section, order: pendingSections.length, groupPath });
        }
      };
      addSections(await paged(
        `${GRAPH_ROOT}notebooks/${encodeURIComponent(notebook.id)}/sections?$select=id,displayName,createdDateTime,lastModifiedDateTime&$top=100`,
        'list-sections',
        parseNotebook,
        limits.maxSections - sectionCount,
        state,
      ), []);

      const walkGroups = async (groups: GraphSectionGroupJson[], parentPath: string[]): Promise<void> => {
        const depth = parentPath.length + 1;
        if (groups.length > 0 && depth > limits.maxSectionGroupDepth) throw graphError({ code: 'limit-exceeded', operation: 'section-group-depth' });
        for (const group of groups) {
          if (seenSectionGroupIds.has(group.id)) throw graphError({ code: 'invalid-response', operation: 'list-section-groups' });
          seenSectionGroupIds.add(group.id);
          sectionGroupCount += 1;
          if (sectionGroupCount > limits.maxSectionGroups) throw graphError({ code: 'limit-exceeded', operation: 'section-group-count' });
          const groupPath = [...parentPath, group.displayName];
          addSections(await paged(
            `${GRAPH_ROOT}sectionGroups/${encodeURIComponent(group.id)}/sections?$select=id,displayName,createdDateTime,lastModifiedDateTime&$top=100`,
            'list-sections',
            parseNotebook,
            limits.maxSections - sectionCount,
            state,
          ), groupPath);
          const children = await paged(
            `${GRAPH_ROOT}sectionGroups/${encodeURIComponent(group.id)}/sectionGroups?$select=id,displayName,createdDateTime,lastModifiedDateTime&$top=100`,
            'list-section-groups',
            parseNotebook,
            limits.maxSectionGroups - sectionGroupCount,
            state,
          );
          await walkGroups(children, groupPath);
        }
      };
      const rootGroups = await paged(
        `${GRAPH_ROOT}notebooks/${encodeURIComponent(notebook.id)}/sectionGroups?$select=id,displayName,createdDateTime,lastModifiedDateTime&$top=100`,
        'list-section-groups',
        parseNotebook,
        limits.maxSectionGroups - sectionGroupCount,
        state,
      );
      await walkGroups(rootGroups, []);

      const importedSections: GraphSectionInput[] = [];
      for (const pending of pendingSections) {
        const pages = await paged(
          `${GRAPH_ROOT}sections/${encodeURIComponent(pending.metadata.id)}/pages?pagelevel=true&$select=id,title,order,level,createdDateTime,lastModifiedDateTime&$top=100`,
          'list-pages',
          parsePage,
          limits.maxPages - pageCount,
          state,
        );
        pageCount += pages.length;
        const importedPages: GraphPageInput[] = [];
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
          const page = pages[pageIndex];
          if (seenPageIds.has(page.id)) throw graphError({ code: 'invalid-response', operation: 'list-pages' });
          seenPageIds.add(page.id);
          const remainingHtmlBytes = limits.maxTotalPageHtmlBytes - stats.pageHtmlBytes;
          if (remainingHtmlBytes <= 0) throw graphError({ code: 'limit-exceeded', operation: 'total-page-html-bytes' });
          const response = await request(
            `${GRAPH_ROOT}pages/${encodeURIComponent(page.id)}/content?includeIDs=true`,
            'text/html',
            Math.min(limits.maxPageHtmlBytes, remainingHtmlBytes),
            'get-page-content',
            state,
          );
          const responseType = mediaType(response.contentType);
          if (responseType && responseType !== 'text/html') throw graphError({ code: 'invalid-response', operation: 'get-page-content' });
          stats.pageHtmlBytes += response.bytes.byteLength;
          const html = decodeText(response.bytes, 'get-page-content');
          for (const reference of extractGraphResourceReferences(html)) {
            const current = resourceReferences.get(reference.id);
            if (!current) resourceReferences.set(reference.id, reference);
            else if (!current.fileName && reference.fileName) resourceReferences.set(reference.id, { ...current, fileName: reference.fileName });
          }
          importedPages.push({
            id: page.id,
            title: page.title,
            order: page.order ?? pageIndex,
            level: page.level,
            createdDateTime: page.createdDateTime,
            lastModifiedDateTime: page.lastModifiedDateTime,
            html,
          });
        }
        importedSections.push({
          id: pending.metadata.id,
          displayName: pending.metadata.displayName,
          ...(pending.groupPath.length > 0 ? { groupPath: pending.groupPath } : {}),
          order: pending.order,
          createdDateTime: pending.metadata.createdDateTime,
          lastModifiedDateTime: pending.metadata.lastModifiedDateTime,
          pages: importedPages,
        });
      }
      importedNotebooks.push({
        id: notebook.id,
        displayName: notebook.displayName,
        createdDateTime: notebook.createdDateTime,
        lastModifiedDateTime: notebook.lastModifiedDateTime,
        sections: importedSections,
      });
    }

    if (resourceReferences.size > limits.maxResources) throw graphError({ code: 'limit-exceeded', operation: 'resource-count' });
    const graphResources: GraphResourceInput[] = [];
    const resourceBodies: OneNoteGraphAcquisition['resourceBodies'] = [];
    for (const reference of resourceReferences.values()) {
      const remaining = limits.maxTotalResourceBytes - stats.resourceBytes;
      if (remaining <= 0) throw graphError({ code: 'limit-exceeded', operation: 'total-resource-bytes' });
      const response = await request(
        canonicalGraphResourceUrl(reference.id),
        '*/*',
        Math.min(limits.maxResourceBytes, remaining),
        'get-resource-content',
        state,
      );
      stats.resourceBytes += response.bytes.byteLength;
      const type = mediaType(response.contentType) ?? mediaType(reference.mediaTypeHint) ?? 'application/octet-stream';
      let hash: string;
      try {
        hash = await sha256(response.bytes);
      } catch (error) {
        if (error instanceof OneNoteGraphAcquisitionError) throw error;
        throw graphError({ code: 'invalid-response', operation: 'hash-resource' });
      }
      if (!/^[a-f0-9]{64}$/i.test(hash)) throw graphError({ code: 'invalid-response', operation: 'hash-resource' });
      const contentUrl = canonicalGraphResourceUrl(reference.id);
      graphResources.push({
        id: reference.id,
        contentUrl,
        mediaType: type,
        fileName: reference.fileName,
        byteLength: response.bytes.byteLength,
        sha256: hash.toLowerCase(),
      });
      resourceBodies.push({
        id: reference.id,
        bytes: response.bytes,
        mediaType: type,
        fileName: reference.fileName,
        sha256: hash.toLowerCase(),
      });
    }
    const input: GraphOneNoteImportInput = { notebooks: importedNotebooks, resources: graphResources };
    return { input, resourceBodies, stats: { ...stats } };
  };

  const acquirePreview = async (previewOptions: OneNoteGraphPreviewOptions) => {
    const acquisition = await acquire(previewOptions);
    throwIfAborted(previewOptions.signal ?? new AbortController().signal, 'create-preview');
    return {
      ...acquisition,
      preview: createOneNoteImportPreview(acquisition.input, previewOptions.preview),
    };
  };

  return { acquire, acquirePreview };
}
