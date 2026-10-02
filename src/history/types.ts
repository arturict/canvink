import type { Sha256Checksum } from '../domain/v2';

export type HistorySnapshotKind = 'manual' | 'automatic' | 'trash';

export interface HistorySnapshotMetadata {
  version: 1;
  snapshotId: string;
  documentId: string;
  pageId: string;
  name?: string;
  deviceId: string;
  kind: HistorySnapshotKind;
  heads: string[];
  checksum: Sha256Checksum;
  size: number;
  createdAt: string;
}

export interface HistorySnapshot extends HistorySnapshotMetadata {
  bytes: Uint8Array;
}

export interface HistorySnapshotStore {
  put(snapshot: HistorySnapshot): Promise<HistorySnapshotMetadata>;
  get(snapshotId: string): Promise<HistorySnapshot | undefined>;
  list(documentId: string, limit?: number): Promise<HistorySnapshotMetadata[]>;
  deleteGuarded(snapshotId: string, expectedChecksum: Sha256Checksum): Promise<boolean>;
}

export interface HistoryRetentionPolicy {
  automaticIntervalMs: number;
  automaticChangeThreshold: number;
  maxAutomaticPerPage: number;
  maxManualPerPage: number;
  maxTrashPerPage: number;
}

export const DEFAULT_HISTORY_RETENTION: Readonly<HistoryRetentionPolicy> = Object.freeze({
  automaticIntervalMs: 5 * 60 * 1000,
  automaticChangeThreshold: 20,
  maxAutomaticPerPage: 30,
  maxManualPerPage: 50,
  maxTrashPerPage: 20,
});

export interface HistoryChangePreview {
  snapshot: HistorySnapshotMetadata;
  sourceTitle: string;
  currentTitle?: string;
  changesAfterSnapshot: number;
  changeMessages: Array<{
    actor: string;
    message: string;
    time?: string;
  }>;
  snapshotConflicts: number;
  currentConflicts: number;
  elementDelta: number;
}

export interface RestoreHistoryCopyResult {
  pageId: string;
  documentId: string;
  title: string;
}
