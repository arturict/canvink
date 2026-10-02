import type { GraphOneNoteImportInput, OneNoteImportPreviewPlan } from '../types';
import type { OneNoteImportPreviewOptions } from '../preview';

export type GraphAccessTokenProvider = (signal: AbortSignal) => Promise<string>;
export type GraphFetch = (input: string, init: RequestInit) => Promise<Response>;
export type GraphDelay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export type GraphSha256 = (bytes: Uint8Array) => Promise<string>;

export interface OneNoteGraphLimits {
  maxNotebooks: number;
  maxSections: number;
  maxSectionGroups: number;
  maxSectionGroupDepth: number;
  maxPages: number;
  maxResources: number;
  maxPaginationPages: number;
  maxRequests: number;
  maxMetadataResponseBytes: number;
  maxTotalMetadataBytes: number;
  maxPageHtmlBytes: number;
  maxTotalPageHtmlBytes: number;
  maxResourceBytes: number;
  maxTotalResourceBytes: number;
}

export interface OneNoteGraphRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface MicrosoftGraphOneNoteClientOptions {
  getAccessToken: GraphAccessTokenProvider;
  fetch: GraphFetch;
  delay?: GraphDelay;
  sha256?: GraphSha256;
  requestTimeoutMs?: number;
  limits?: Partial<OneNoteGraphLimits>;
  retry?: Partial<OneNoteGraphRetryPolicy>;
}

export interface OneNoteGraphAcquireOptions {
  signal?: AbortSignal;
  /** When omitted, every enumerated personal notebook is acquired. */
  notebookIds?: readonly string[];
}

export interface AcquiredGraphResource {
  id: string;
  bytes: Uint8Array;
  mediaType: string;
  fileName?: string;
  sha256: string;
}

export interface OneNoteGraphAcquisitionStats {
  requests: number;
  retries: number;
  metadataBytes: number;
  pageHtmlBytes: number;
  resourceBytes: number;
}

export interface OneNoteGraphAcquisition {
  input: GraphOneNoteImportInput;
  resourceBodies: AcquiredGraphResource[];
  stats: OneNoteGraphAcquisitionStats;
}

export interface OneNoteGraphPreviewOptions extends OneNoteGraphAcquireOptions {
  preview: OneNoteImportPreviewOptions;
}

export interface OneNoteGraphPreviewResult extends OneNoteGraphAcquisition {
  preview: OneNoteImportPreviewPlan;
}

export interface MicrosoftGraphOneNoteClient {
  acquire(options?: OneNoteGraphAcquireOptions): Promise<OneNoteGraphAcquisition>;
  acquirePreview(options: OneNoteGraphPreviewOptions): Promise<OneNoteGraphPreviewResult>;
}
