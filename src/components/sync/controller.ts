import type { DocHandle } from '@automerge/automerge-repo';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import type { NotebookPresence, NotebookRole, SyncAccount, SyncConfiguration } from '../../sync/client';
import {
  AppwriteNotebookSecurityUi,
  BrowserDurableSyncState,
  BrowserSessionSecretStore,
  createAppwriteSyncServices,
  createNotebookDeviceResolver,
  createOptionalSyncClient,
  initializeOwnerNotebookKeys,
  loadNotebookKeysFromEnvelopes,
  loadOrCreateProtectedDeviceIdentity,
  NotebookSyncRuntime,
  SyncClientError,
  TauriDpapiSecretStore,
  TauriDurableSyncState,
  type DeviceSeedSecretStore,
  type ProtectedNotebookKeyring,
  type SyncWorkspaceDocumentsPort,
} from '../../sync/client';
import type { AppwriteSyncServices, SyncTeamMember } from '../../sync/client';
import type { DeviceSecretIdentity } from '../../sync/crypto';
import { AppwriteDeviceApprovalUi } from './deviceApproval';
import { SYNC_CONFIGURATION_KEY } from './configurationKey';
import type { SyncPanelController, SyncPanelSnapshot } from './types';

const CONFIG_KEY = SYNC_CONFIGURATION_KEY;

export interface SyncSecurityUiPort {
  requestExistingDeviceApproval(notebookId: string): Promise<void>;
  recoverWithCode(notebookId: string, code: string): Promise<void>;
  acknowledgeRecoveryCode(): Promise<void>;
  rotateEpoch(notebookId: string): Promise<{ recoveryCode?: string }>;
  markDeviceLost(notebookId: string, deviceId: string): Promise<void>;
}

export interface SyncDeviceApprovalUiPort {
  createRequest(notebookId: string): Promise<{ requestCode: string }>;
  approveRequest(notebookId: string, requestCode: string): Promise<void>;
}

/** The part of the workspace runtime the encrypted sync needs for pages that are not open. */
export type SyncWorkspaceSource = Pick<
  WorkspaceV2Runtime,
  'getState' | 'getDocumentHeads' | 'applyRemoteDocumentChanges' | 'subscribeToDocumentChanges'
>;

/** The workspace documents of one notebook (its root and every page its sections list). */
export function notebookWorkspaceDocuments(workspace: SyncWorkspaceSource, notebookId: string): SyncWorkspaceDocumentsPort {
  let cachedState: unknown;
  let cachedIds = new Set<string>();
  const documentIds = (): ReadonlySet<string> => {
    const state = workspace.getState();
    if (state === cachedState) return cachedIds;
    cachedState = state;
    cachedIds = new Set();
    if (state.schemaVersion !== 1) {
      const notebook = state.notebooks.find((candidate) => candidate.notebookId === notebookId);
      if (notebook) {
        cachedIds.add(notebook.documentId);
        for (const section of notebook.sections) for (const documentId of section.pageDocumentIds) cachedIds.add(documentId);
      }
    }
    return cachedIds;
  };
  return {
    includes: (documentId) => documentIds().has(documentId),
    listDocuments: () => [...documentIds()],
    getDocumentHeads: (documentId) => workspace.getDocumentHeads(documentId),
    applyRemoteDocumentChanges: (documentId, change, options) => workspace.applyRemoteDocumentChanges(documentId, change, options),
    subscribeToDocumentChanges: (listener) => workspace.subscribeToDocumentChanges(listener),
  };
}

export interface SyncPanelControllerOptions {
  storage?: Storage | null;
  /**
   * The workspace runtime. With it, the notebook's pages that are not open
   * sync too: remote changes are merged through the runtime instead of
   * aborting the catch-up, and local changes of those pages are sent.
   */
  workspace?: SyncWorkspaceSource;
  browserSessionOnly?: boolean;
  servicesFactory?: typeof createAppwriteSyncServices;
  security?: SyncSecurityUiPort;
  approval?: SyncDeviceApprovalUiPort;
  currentDeviceId?: string;
  secretStore?: DeviceSeedSecretStore;
}

export class BrowserSyncPanelController implements SyncPanelController {
  private readonly listeners = new Set<() => void>();
  private readonly storage: Storage | null;
  private readonly servicesFactory: typeof createAppwriteSyncServices;
  private readonly security?: SyncSecurityUiPort;
  private readonly approval?: SyncDeviceApprovalUiPort;
  private readonly currentDeviceId?: string;
  private readonly suppliedSecretStore?: DeviceSeedSecretStore;
  private readonly workspace?: SyncWorkspaceSource;
  private resolvedSecretStore?: DeviceSeedSecretStore;
  private services?: AppwriteSyncServices;
  private notebookId?: string;
  private identity?: DeviceSecretIdentity;
  private keyring?: ProtectedNotebookKeyring;
  private runtimeSecurity?: AppwriteNotebookSecurityUi;
  private runtimeApproval?: AppwriteDeviceApprovalUi;
  private runtime?: NotebookSyncRuntime;
  private readonly documents = new Map<string, { handle: DocHandle<object>; disconnect?: () => void }>();
  private state: SyncPanelSnapshot;

  constructor(options: SyncPanelControllerOptions = {}) {
    this.storage = options.storage ?? safeLocalStorage();
    this.servicesFactory = options.servicesFactory ?? createAppwriteSyncServices;
    this.security = options.security;
    this.approval = options.approval;
    const browserSessionOnly = options.browserSessionOnly ?? !isTauri();
    this.currentDeviceId = browserSessionOnly && options.currentDeviceId
      ? `${options.currentDeviceId}.session.${sessionSuffix()}`
      : options.currentDeviceId;
    this.suppliedSecretStore = options.secretStore;
    this.workspace = options.workspace;
    this.state = {
      status: 'local', role: null, pendingChanges: 0,
      browserSessionOnly,
      recoveryAcknowledged: false, members: [], devices: [], presences: [],
    };
    const saved = readConfiguration(this.storage);
    if (saved?.enabled) {
      try {
        this.services = this.servicesFactory(saved);
        this.state.status = 'signed-out';
      } catch {
        this.storage?.removeItem(CONFIG_KEY);
        this.state.message = 'Die gespeicherte Sync-Konfiguration ist ungültig.';
      }
    }
  }

  snapshot(): SyncPanelSnapshot { return this.state; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  connectDocument(documentId: string, handle: DocHandle<object>): () => void {
    this.documents.get(documentId)?.disconnect?.();
    const entry = { handle, ...(this.runtime ? { disconnect: this.runtime.registerDocument(documentId, handle) } : {}) };
    this.documents.set(documentId, entry);
    return () => {
      if (this.documents.get(documentId) !== entry) return;
      entry.disconnect?.();
      this.documents.delete(documentId);
    };
  }

  async openNotebook(notebookId: string): Promise<void> {
    this.notebookId = notebookId;
    if (!this.services) return;
    await this.refreshCurrentNotebook();
  }

  async configure(config: SyncConfiguration): Promise<void> {
    const services = createOptionalSyncClient(config, this.servicesFactory);
    if (!services) {
      await this.disable();
      return;
    }
    this.services = services;
    this.storage?.setItem(CONFIG_KEY, JSON.stringify(config));
    await this.refreshCurrentNotebook();
  }

  async signInMicrosoft(success: string, failure: string): Promise<void> {
    await this.requireServices().auth.startMicrosoftOAuth({ success, failure, open: (url) => { window.location.assign(url); } });
  }

  async startEmailOtp(email: string): Promise<void> {
    const otp = await this.requireServices().auth.startEmailOtp(email);
    this.update({ otp, message: 'Der Einmalcode wurde gesendet.' });
  }

  async completeEmailOtp(secret: string): Promise<void> {
    if (!this.state.otp) throw new SyncClientError('protocol-error', 'Fordere zuerst einen E-Mail-Code an.');
    await this.requireServices().auth.completeEmailOtp(this.state.otp.userId, secret);
    await this.refreshCurrentNotebook();
  }

  async enableNotebookTeam(notebookId: string): Promise<void> {
    const services = this.requireServices();
    await services.teamAdmin.enableNotebookTeam(notebookId, 'Canvink Notizbuch');
    await this.refreshCurrentNotebook();
    if (this.state.role === 'owner' && !this.keyring && this.identity) {
      const initialized = await initializeOwnerNotebookKeys({
        notebookId,
        identity: this.identity,
        services,
        store: this.requireSecretStore(),
      });
      this.keyring = initialized.keyring;
      this.runtimeSecurity?.setKeyring(initialized.keyring);
      this.update({ recoveryCode: initialized.recoveryCode, recoveryAcknowledged: false });
      await this.startRuntime();
    }
  }

  async requestExistingDeviceApproval(notebookId: string): Promise<void> {
    const approval = this.effectiveApproval();
    if (approval) {
      const request = await approval.createRequest(notebookId);
      this.update({ approvalRequestCode: request.requestCode, message: 'Freigabeanfrage erstellt. Übertrage den Code auf ein aktives Gerät.' });
      return;
    }
    const security = this.effectiveSecurity();
    if (!security) throw new SyncClientError('key-epoch-unavailable', 'Die Gerätefreigabe ist in dieser Laufzeit noch nicht verbunden.');
    await security.requestExistingDeviceApproval(notebookId);
    this.update({ message: 'Freigabeanfrage erstellt. Bestätige sie auf einem vorhandenen Gerät.' });
  }

  async approveDeviceRequest(notebookId: string, requestCode: string): Promise<void> {
    const approval = this.effectiveApproval();
    if (!approval) throw new SyncClientError('key-epoch-unavailable', 'Die Gerätefreigabe ist in dieser Laufzeit noch nicht verbunden.');
    await approval.approveRequest(notebookId, requestCode);
    this.update({ message: 'Das neue Gerät wurde kryptografisch bestätigt und serverseitig aktiviert.' });
  }

  async recoverWithCode(notebookId: string, code: string): Promise<void> {
    const security = this.effectiveSecurity();
    if (!security) throw new SyncClientError('key-epoch-unavailable', 'Die Wiederherstellung ist in dieser Laufzeit noch nicht verbunden.');
    await security.recoverWithCode(notebookId, code.trim());
    if (this.runtimeSecurity) this.keyring = this.runtimeSecurity.getKeyring();
    await this.refreshCurrentNotebook();
    this.update({ message: 'Wiederherstellungsschlüssel wurde geöffnet und dieses Gerät aktiviert.' });
  }

  async acknowledgeRecoveryCode(): Promise<void> {
    await this.effectiveSecurity()?.acknowledgeRecoveryCode();
    this.update({ recoveryAcknowledged: true, recoveryCode: undefined });
  }

  async invite(input: { notebookId: string; email: string; role: NotebookRole; redirectUrl: string }): Promise<void> {
    await this.requireServices().teamAdmin.inviteMember(input);
    await this.refreshMembers(input.notebookId);
  }

  async updateMemberRole(notebookId: string, membershipId: string, role: NotebookRole): Promise<void> {
    await this.requireServices().teamAdmin.updateMemberRole(notebookId, membershipId, role);
    await this.refreshMembers(notebookId);
  }

  async removeMember(notebookId: string, membershipId: string): Promise<void> {
    const security = this.effectiveSecurity();
    if (!security) throw new SyncClientError('key-epoch-unavailable', 'Mitglieder können erst entfernt werden, wenn die Schlüsselrotation verbunden ist.');
    await this.requireServices().teamAdmin.removeMember(notebookId, membershipId);
    const result = await security.rotateEpoch(notebookId);
    await this.refreshMembers(notebookId);
    this.update({ ...result, recoveryAcknowledged: !result.recoveryCode, message: 'Mitglied entfernt. Neue Änderungen werden mit einer neuen Schlüsselepoche geschützt.' });
  }

  async rotateEpoch(notebookId: string): Promise<void> {
    const security = this.effectiveSecurity();
    if (!security) throw new SyncClientError('key-epoch-unavailable', 'Die Schlüsselrotation ist in dieser Laufzeit noch nicht verbunden.');
    const result = await security.rotateEpoch(notebookId);
    this.update({ ...result, recoveryAcknowledged: !result.recoveryCode, message: 'Neue Änderungen verwenden jetzt die neue Schlüsselepoche.' });
  }

  async markDeviceLost(notebookId: string, deviceId: string): Promise<void> {
    const security = this.effectiveSecurity();
    if (!security) throw new SyncClientError('key-epoch-unavailable', 'Die Geräteverwaltung ist in dieser Laufzeit noch nicht verbunden.');
    await security.markDeviceLost(notebookId, deviceId);
    this.update({ message: 'Gerät gesperrt. Rotiere jetzt den Schlüssel für zukünftige Änderungen.' });
  }

  async publishPresence(presence: NotebookPresence): Promise<void> {
    await this.requireServices().realtime.publishPresence({
      ...presence,
      deviceId: this.currentDeviceId ?? presence.deviceId,
    });
  }

  async disable(): Promise<void> {
    await this.runtime?.stop().catch(() => undefined);
    this.runtime = undefined;
    await this.services?.realtime.disconnect().catch(() => undefined);
    this.services = undefined;
    this.storage?.removeItem(CONFIG_KEY);
    this.state = { ...this.state, status: 'local', role: null, members: [], presences: [], message: 'Sync deaktiviert. Lokale Notizen wurden nicht gelöscht.' };
    this.emit();
  }

  async logout(): Promise<void> {
    await this.runtime?.stop().catch(() => undefined);
    this.runtime = undefined;
    await this.requireServices().auth.logout();
    this.update({ status: 'signed-out', role: null, accountName: undefined, accountEmail: undefined, message: 'Abgemeldet. Lokale Notizen bleiben erhalten.' });
  }

  private async refreshAccount(): Promise<SyncAccount | null> {
    const account = await this.requireServices().auth.currentAccount();
    if (!account) {
      this.update({ status: 'signed-out', role: null, accountName: undefined, accountEmail: undefined });
      return null;
    }
    this.update({ status: 'approval-required', accountName: account.name, accountEmail: account.email });
    return account;
  }

  private async refreshCurrentNotebook(): Promise<void> {
    const account = await this.refreshAccount();
    if (!account || !this.notebookId) return;
    await this.prepareDevice(account);
    await this.refreshDevices();
    await this.refreshRole(this.notebookId);
    const current = this.state.devices.find((device) => device.current);
    if (current?.status !== 'active' || !this.state.role || !this.identity) return;
    this.keyring = await loadNotebookKeysFromEnvelopes({
      notebookId: this.notebookId,
      identity: this.identity,
      services: this.requireServices(),
      store: this.requireSecretStore(),
    });
    if (this.keyring) {
      this.runtimeSecurity?.setKeyring(this.keyring);
      await this.startRuntime();
    } else {
      this.update({ status: 'approval-required', message: 'Dieses Konto ist Mitglied, aber für dieses Gerät fehlt noch ein Notizbuchschlüssel.' });
    }
  }

  private async refreshRole(notebookId: string): Promise<void> {
    const services = this.requireServices();
    const account = await services.auth.currentAccount();
    if (!account) return this.update({ status: 'signed-out', role: null });
    const role = await services.auth.roleForNotebook(notebookId, account.userId);
    await this.refreshMembers(notebookId);
    const currentDevice = this.state.devices.find((device) => device.current);
    const status = currentDevice?.status === 'pending'
      ? 'approval-required'
      : currentDevice?.status === 'revoked'
        ? 'removed'
        : role ? 'online' : 'approval-required';
    this.update({ status, role });
  }

  private async refreshMembers(notebookId: string): Promise<void> {
    const members: readonly SyncTeamMember[] = await this.requireServices().teamAdmin.listMembers(notebookId);
    this.update({ members });
  }

  private async refreshDevices(): Promise<void> {
    const devices = [];
    let cursor: string | undefined;
    do {
      const page = await this.requireServices().directory.listMyDevices({ ...(cursor ? { cursor } : {}), limit: 50 });
      devices.push(...page.devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.deviceId,
        current: device.deviceId === this.currentDeviceId,
        status: device.status,
        lastSeenAt: device.updatedAt,
      })));
      cursor = page.nextCursor;
    } while (cursor && devices.length < 500);
    const current = devices.find((device) => device.current);
    this.update({
      devices,
      ...(current?.status === 'pending' ? { status: 'approval-required' as const } : {}),
      ...(current?.status === 'revoked' ? { status: 'removed' as const } : {}),
    });
  }

  private async prepareDevice(account: SyncAccount): Promise<void> {
    if (!this.currentDeviceId) throw new SyncClientError('key-epoch-unavailable', 'Dieses Gerät hat keine stabile Geräte-ID.');
    if (!this.identity || this.identity.publicIdentity.accountId !== account.userId) {
      const loaded = await loadOrCreateProtectedDeviceIdentity({
        accountId: account.userId,
        deviceId: this.currentDeviceId,
        store: this.requireSecretStore(),
      });
      this.identity = loaded.identity;
    }
    const services = this.requireServices();
    const registration = await services.directory.registerDevice(this.identity.publicIdentity);
    this.runtimeApproval = new AppwriteDeviceApprovalUi(services.directory, this.identity);
    this.runtimeSecurity = new AppwriteNotebookSecurityUi({
      notebookId: this.notebookId as string,
      identity: this.identity,
      services,
      store: this.requireSecretStore(),
    });
    if (this.keyring) this.runtimeSecurity.setKeyring(this.keyring);
    if (registration.device.status === 'pending') this.update({ status: 'approval-required' });
    if (registration.device.status === 'revoked') this.update({ status: 'removed' });
  }

  private requireSecretStore(): DeviceSeedSecretStore {
    if (this.suppliedSecretStore) return this.suppliedSecretStore;
    if (this.resolvedSecretStore) return this.resolvedSecretStore;
    if (isTauri()) {
      if (!this.storage) throw new SyncClientError('key-epoch-unavailable', 'Geschützter Desktop-Schlüsselspeicher ist nicht verfügbar.');
      this.resolvedSecretStore = new TauriDpapiSecretStore(this.storage);
    } else this.resolvedSecretStore = new BrowserSessionSecretStore();
    return this.resolvedSecretStore;
  }

  private effectiveSecurity(): SyncSecurityUiPort | undefined { return this.security ?? this.runtimeSecurity; }
  private effectiveApproval(): SyncDeviceApprovalUiPort | undefined { return this.approval ?? this.runtimeApproval; }

  private async startRuntime(): Promise<void> {
    if (this.runtime || !this.services || !this.notebookId || !this.identity || !this.keyring) return;
    const runtime = new NotebookSyncRuntime({
      notebookId: this.notebookId,
      identity: this.identity,
      keyring: this.keyring,
      services: this.services,
      durable: isTauri() ? new TauriDurableSyncState() : new BrowserDurableSyncState(),
      resolveSender: createNotebookDeviceResolver(this.services.directory, this.notebookId),
      ...(this.workspace ? { workspace: notebookWorkspaceDocuments(this.workspace, this.notebookId) } : {}),
      loadKeyEpoch: async (epoch) => {
        if (!this.identity || !this.notebookId || !this.services) return undefined;
        const loaded = await loadNotebookKeysFromEnvelopes({
          notebookId: this.notebookId,
          identity: this.identity,
          services: this.services,
          store: this.requireSecretStore(),
        });
        this.keyring = loaded;
        return loaded?.keyForEpoch(epoch);
      },
      onPresence: (presence) => {
        const presences = this.state.presences.filter((entry) => entry.deviceId !== presence.deviceId);
        presences.push(presence);
        this.update({ presences });
      },
      onError: (error) => this.update({ status: error instanceof SyncClientError && error.code === 'removed-member' ? 'removed' : 'error', message: error.message }),
    });
    for (const [documentId, entry] of this.documents) entry.disconnect = runtime.registerDocument(documentId, entry.handle);
    this.runtime = runtime;
    try {
      await runtime.start();
      this.update({ role: runtime.coordinator.role, pendingChanges: runtime.coordinator.pendingCount, status: 'online' });
    } catch (error) {
      this.runtime = undefined;
      for (const entry of this.documents.values()) { entry.disconnect?.(); delete entry.disconnect; }
      throw error;
    }
  }

  private requireServices(): AppwriteSyncServices {
    if (!this.services) throw new SyncClientError('disabled', 'Aktiviere zuerst die Synchronisation.');
    return this.services;
  }

  private update(patch: Partial<SyncPanelSnapshot>): void { this.state = { ...this.state, ...patch }; this.emit(); }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

function safeLocalStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function sessionSuffix(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  if (!bytes) throw new SyncClientError('key-epoch-unavailable', 'Sichere Browser-Sitzungs-ID ist nicht verfügbar.');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readConfiguration(storage: Storage | null): SyncConfiguration | undefined {
  try {
    const raw = storage?.getItem(CONFIG_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<Extract<SyncConfiguration, { enabled: true }>>;
    if (
      value.enabled !== true ||
      !['endpoint', 'projectId', 'functionId', 'databaseId', 'changesTableId', 'assetBucketId']
        .every((key) => typeof value[key as keyof typeof value] === 'string')
    ) return undefined;
    return value as Extract<SyncConfiguration, { enabled: true }>;
  } catch {
    return undefined;
  }
}
