import type * as Automerge from '@automerge/automerge';
import type {
  CanvinkDocumentV2,
  NotebookDoc,
  PageDoc,
  RichTextElementV2,
  StoredDocumentV2,
} from '../domain/v2';
import type { CanvinkDocumentV3, PageDocV3, PageElementV3 } from '../domain/v3';
import type { InkRefFields } from '../ink/projection';
import type { StrokeStorageFormat } from './strokeStorage';

/**
 * Canonical rich text inside Automerge is the string at
 * `elementsById[elementId].text`. `content` only exists on portable projections.
 */
export interface LiveRichTextElementV2 extends Omit<RichTextElementV2, 'content'> {
  text: string;
}

export type LivePageElementV2 =
  | LiveRichTextElementV2
  | Exclude<PageElementV3, RichTextElementV2>;

/** Heads are transport metadata and must never be written into the CRDT root. */
export type LiveNotebookDocV2 = Omit<NotebookDoc, 'version' | 'schemaVersion'> & {
  schemaVersion: NotebookDoc['schemaVersion'] | CanvinkDocumentV3['schemaVersion'];
};

/** Heads and portable rich-text projections are deliberately absent. */
export type LivePageDocV2 = Omit<PageDocV3, 'version' | 'elementsById' | 'schemaVersion'> & {
  schemaVersion: PageDoc['schemaVersion'] | PageDocV3['schemaVersion'];
  elementsById: Record<string, LivePageElementV2>;
} & InkRefFields;

export type LiveCanvinkDocumentV2 = LiveNotebookDocV2 | LivePageDocV2;

export type CanvinkAutomergeDoc<
  T extends LiveCanvinkDocumentV2 = LiveCanvinkDocumentV2,
> =
  Automerge.Doc<T>;

export interface CreateAutomergeDocumentOptions {
  /** A 64-character hexadecimal Automerge actor ID. Random when omitted. */
  actorId?: string;
  /** How the samples of ink strokes are stored; `STROKE_WRITE_FORMAT` when omitted. */
  strokeFormat?: StrokeStorageFormat;
}

export interface LoadAutomergeDocumentOptions extends Omit<CreateAutomergeDocumentOptions, 'strokeFormat'> {
  expectedDocumentId?: string;
  expectedKind?: CanvinkDocumentV2['kind'];
  expectedSchemaVersion?: 2 | 3;
}

export interface ChangeAutomergeDocumentOptions {
  message: string;
  /** Unix seconds. Omit to keep the change independent from wall-clock time. */
  time?: number;
  /** Optional optimistic-concurrency guard. */
  expectedHeads?: readonly string[];
}

export interface AutomergeHistoryEntry<T extends LiveCanvinkDocumentV2> {
  actor: string;
  hash: string;
  sequence: number;
  dependencies: string[];
  message: string | null;
  time: number;
  snapshot: T;
}

export type AutomergeConflictPath = Array<string | number>;

export interface AutomergeConflictValue {
  operationId: string;
  value: unknown;
}

export interface AutomergeConflict {
  path: AutomergeConflictPath;
  values: AutomergeConflictValue[];
}

export interface MaterializedAutomergeMigration {
  documents: StoredDocumentV2[];
}

export type NotebookAutomergeDoc = CanvinkAutomergeDoc<LiveNotebookDocV2>;
export type PageAutomergeDoc = CanvinkAutomergeDoc<LivePageDocV2>;
