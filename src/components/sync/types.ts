import type { SyncConfiguration, SyncTeamMember, NotebookPresence, NotebookRole } from '../../sync/client';
import type { DocHandle } from '@automerge/automerge-repo';

export type SyncPanelStatus =
  | 'local'
  | 'signed-out'
  | 'approval-required'
  | 'online'
  | 'offline'
  | 'reconnecting'
  | 'removed'
  | 'error';

export interface SyncDeviceSummary {
  deviceId: string;
  name: string;
  current: boolean;
  status: 'pending' | 'active' | 'lost' | 'revoked';
  lastSeenAt?: string;
}

export interface SyncPanelSnapshot {
  status: SyncPanelStatus;
  role: NotebookRole | null;
  accountName?: string;
  accountEmail?: string;
  pendingChanges: number;
  browserSessionOnly: boolean;
  message?: string;
  otp?: { userId: string; phrase?: string; expire: string };
  recoveryCode?: string;
  approvalRequestCode?: string;
  recoveryAcknowledged: boolean;
  members: readonly SyncTeamMember[];
  devices: readonly SyncDeviceSummary[];
  presences: readonly NotebookPresence[];
}

export interface SyncPanelController {
  snapshot(): SyncPanelSnapshot;
  subscribe(listener: () => void): () => void;
  connectDocument(documentId: string, handle: DocHandle<object>): () => void;
  openNotebook(notebookId: string): Promise<void>;
  configure(config: SyncConfiguration): Promise<void>;
  signInMicrosoft(success: string, failure: string): Promise<void>;
  startEmailOtp(email: string): Promise<void>;
  completeEmailOtp(secret: string): Promise<void>;
  enableNotebookTeam(notebookId: string): Promise<void>;
  requestExistingDeviceApproval(notebookId: string): Promise<void>;
  approveDeviceRequest(notebookId: string, requestCode: string): Promise<void>;
  recoverWithCode(notebookId: string, code: string): Promise<void>;
  acknowledgeRecoveryCode(): Promise<void>;
  invite(input: { notebookId: string; email: string; role: NotebookRole; redirectUrl: string }): Promise<void>;
  updateMemberRole(notebookId: string, membershipId: string, role: NotebookRole): Promise<void>;
  removeMember(notebookId: string, membershipId: string): Promise<void>;
  rotateEpoch(notebookId: string): Promise<void>;
  markDeviceLost(notebookId: string, deviceId: string): Promise<void>;
  publishPresence(presence: NotebookPresence): Promise<void>;
  disable(): Promise<void>;
  logout(): Promise<void>;
}
