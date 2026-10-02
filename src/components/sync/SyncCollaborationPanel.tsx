import type { DocHandle, DocHandleChangePayload } from '@automerge/automerge-repo';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Check, Cloud, CloudOff, Copy, KeyRound, ShieldAlert, Users, X } from 'lucide-react';
import type { LivePageDocV2 } from '../../crdt';
import type { ReadonlyDocHandle } from '../../storage/workspaceV2Runtime';
import { useI18n, type TranslationKey, type TranslationParameters } from '../../i18n';
import { useConfirm } from '../../ui/ConfirmDialog';
import type { NotebookPresence, NotebookRole } from '../../sync/client';
import { BrowserSyncPanelController, type SyncWorkspaceSource } from './controller';
import { enumerateAutomergeConflicts, type ObjectConflict } from './conflicts';
import type { SyncPanelController, SyncPanelSnapshot } from './types';
import './sync.css';

export interface SyncCollaborationPanelProps {
  notebookId: string;
  pageId: string;
  pageHandle: ReadonlyDocHandle<LivePageDocV2>;
  /**
   * The workspace runtime, so the notebook's pages that are not open sync
   * too (see `SyncPanelControllerOptions.workspace`). Without it only the
   * open page syncs.
   */
  workspaceRuntime?: SyncWorkspaceSource;
  controller?: SyncPanelController;
  deviceId?: string;
  presenceName?: string;
  presenceColor?: string;
  presenceCursor?: NotebookPresence['cursor'];
  presenceSelection?: NotebookPresence['selection'];
  initiallyOpen?: boolean;
  compact?: boolean;
  onViewerModeChange?(viewer: boolean): void;
}

const STATUS_KEY: Record<SyncPanelSnapshot['status'], TranslationKey> = {
  local: 'sync.status.local',
  'signed-out': 'sync.status.signedOut',
  'approval-required': 'sync.status.approvalRequired',
  online: 'sync.status.online',
  offline: 'sync.status.offline',
  reconnecting: 'sync.status.reconnecting',
  removed: 'sync.status.removed',
  error: 'sync.status.error',
};

const MESSAGE_KEYS: Readonly<Record<string, TranslationKey>> = {
  'Der Einmalcode wurde gesendet.': 'sync.message.otpSent',
  'Freigabeanfrage erstellt. Übertrage den Code auf ein aktives Gerät.': 'sync.message.approvalCode',
  'Freigabeanfrage erstellt. Bestätige sie auf einem vorhandenen Gerät.': 'sync.message.approvalExisting',
  'Das neue Gerät wurde kryptografisch bestätigt und serverseitig aktiviert.': 'sync.message.deviceActivated',
  'Wiederherstellungsschlüssel wurde geöffnet und dieses Gerät aktiviert.': 'sync.message.recovered',
  'Mitglied entfernt. Neue Änderungen werden mit einer neuen Schlüsselepoche geschützt.': 'sync.message.memberRemoved',
  'Neue Änderungen verwenden jetzt die neue Schlüsselepoche.': 'sync.message.epochRotated',
  'Gerät gesperrt. Rotiere jetzt den Schlüssel für zukünftige Änderungen.': 'sync.message.deviceLocked',
  'Sync deaktiviert. Lokale Notizen wurden nicht gelöscht.': 'sync.message.disabled',
  'Abgemeldet. Lokale Notizen bleiben erhalten.': 'sync.message.signedOut',
  'Dieses Konto ist Mitglied, aber für dieses Gerät fehlt noch ein Notizbuchschlüssel.': 'sync.message.keyMissing',
};

export default function SyncCollaborationPanel({
  notebookId,
  pageId,
  pageHandle,
  workspaceRuntime,
  controller: suppliedController,
  deviceId = 'local-device',
  presenceName = 'Ich',
  presenceColor = '#6d5efc',
  presenceCursor,
  presenceSelection,
  initiallyOpen = false,
  compact = false,
  onViewerModeChange,
}: SyncCollaborationPanelProps) {
  const { t } = useI18n();
  const controller = useMemo(
    () => suppliedController ?? new BrowserSyncPanelController({
      currentDeviceId: deviceId,
      ...(workspaceRuntime ? { workspace: workspaceRuntime } : {}),
    }),
    [deviceId, suppliedController, workspaceRuntime],
  );
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.snapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [open, setOpen] = useState(initiallyOpen);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [conflicts, setConflicts] = useState<ObjectConflict[]>(() => enumerateAutomergeConflicts(pageHandle.doc()));

  useEffect(() => {
    void runAction('open', () => controller.openNotebook(notebookId), setBusy, setError, t('sync.action.error'));
  }, [controller, notebookId, t]);

  useEffect(() => controller.connectDocument(
    pageHandle.doc().documentId,
    pageHandle as unknown as DocHandle<object>,
  ), [controller, pageHandle]);

  useEffect(() => onViewerModeChange?.(snapshot.role === 'viewer'), [onViewerModeChange, snapshot.role]);

  useEffect(() => {
    const update = ({ doc, patchInfo }: DocHandleChangePayload<LivePageDocV2>) => {
      // A local edit cannot create a conflict (it can only resolve one), and a
      // full scan walks every point of every stroke: skip it for local edits
      // while there is nothing to resolve.
      setConflicts((current) => (patchInfo.source === 'change' && current.length === 0
        ? current
        : enumerateAutomergeConflicts(doc)));
    };
    pageHandle.on('change', update);
    return () => { pageHandle.off('change', update); };
  }, [pageHandle]);

  useEffect(() => {
    if (snapshot.status !== 'online') return;
    const timer = window.setTimeout(() => {
      void controller.publishPresence({
        notebookId,
        deviceId,
        name: presenceName,
        color: presenceColor,
        pageId,
        ...(presenceCursor ? { cursor: presenceCursor } : {}),
        ...(presenceSelection ? { selection: presenceSelection } : {}),
      }).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [controller, deviceId, notebookId, pageId, presenceColor, presenceCursor, presenceName, presenceSelection, snapshot.status]);

  const act = (name: string, action: () => Promise<void>) => runAction(name, action, setBusy, setError, t('sync.action.error'));

  // In the title bar, the encrypted team sync only shows once it is set up
  // (or has conflicts to resolve): account sync has its own indicator, and a
  // second crossed-out cloud next to it only confused. Its effects keep running.
  if (compact && snapshot.status === 'local' && conflicts.length === 0 && !open) return null;

  return (
    <div className="sync-collaboration">
      <button
        type="button"
        className={`sync-status sync-status--${snapshot.status}${compact ? ' sync-status--compact' : ''}`}
        aria-label={t(STATUS_KEY[snapshot.status])}
        title={t(STATUS_KEY[snapshot.status])}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {snapshot.status === 'local' || snapshot.status === 'offline' ? <CloudOff size={16} /> : <Cloud size={16} />}
        <span>{t(STATUS_KEY[snapshot.status])}</span>
        {snapshot.pendingChanges > 0 ? <span className="sync-badge" aria-label={t('sync.pending.label', { count: snapshot.pendingChanges })}>{snapshot.pendingChanges}</span> : null}
        {conflicts.length > 0 ? <span className="sync-badge sync-badge--warning" aria-label={t('sync.conflicts.label', { count: conflicts.length })}>{conflicts.length}</span> : null}
      </button>

      {snapshot.browserSessionOnly && snapshot.status !== 'local' ? (
        <p className="sync-banner sync-banner--warning" role="status">
          {t('sync.browserKeyWarning')}
        </p>
      ) : null}
      {snapshot.role === 'viewer' ? <p className="sync-banner" role="status">{t('sync.viewerWarning')}</p> : null}
      {snapshot.status === 'removed' ? <p className="sync-banner sync-banner--danger" role="alert">{t('sync.removedWarning')}</p> : null}

      {open ? (
        <div className="sync-dialog-backdrop" role="presentation">
          <section className="sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
            <header className="sync-dialog__header">
              <div>
                <p className="sync-eyebrow">{t('sync.encrypted')}</p>
                <h2 id="sync-dialog-title">{t('sync.title')}</h2>
              </div>
              <button type="button" className="sync-icon-button" aria-label={t('sync.close')} onClick={() => setOpen(false)}><X size={18} /></button>
            </header>

            <div className="sync-dialog__body">
              <StatusSummary snapshot={snapshot} conflicts={conflicts} />
              {error ? <p className="sync-banner sync-banner--danger" role="alert">{error}</p> : null}
              {snapshot.message ? <p className="sync-banner" role="status">{t(MESSAGE_KEYS[snapshot.message] ?? STATUS_KEY[snapshot.status])}</p> : null}
              {snapshot.status === 'local' ? <ConfigurationForm busy={busy} onSubmit={(config) => act('configure', () => controller.configure(config))} /> : null}
              {snapshot.status === 'signed-out' ? <AuthenticationForms snapshot={snapshot} busy={busy} controller={controller} act={act} /> : null}
              {snapshot.status === 'approval-required' ? <DeviceApproval notebookId={notebookId} snapshot={snapshot} busy={busy} controller={controller} act={act} /> : null}
              {snapshot.recoveryCode ? <RecoveryAcknowledgement code={snapshot.recoveryCode} busy={busy} onAcknowledge={() => act('recovery-ack', () => controller.acknowledgeRecoveryCode())} /> : null}
              {snapshot.status === 'online' || snapshot.status === 'offline' || snapshot.status === 'reconnecting' ? (
                <CollaborationSettings notebookId={notebookId} snapshot={snapshot} busy={busy} controller={controller} act={act} />
              ) : null}
              <LocalDataActions snapshot={snapshot} busy={busy} controller={controller} act={act} />
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function StatusSummary({ snapshot, conflicts }: { snapshot: SyncPanelSnapshot; conflicts: readonly ObjectConflict[] }) {
  const { t } = useI18n();
  return (
    <section className="sync-section sync-summary" aria-label={t('sync.summary.label')}>
      <div><strong>{t(STATUS_KEY[snapshot.status])}</strong><span>{t('sync.pending', { count: snapshot.pendingChanges })}</span></div>
      {snapshot.accountName ? <div><strong>{snapshot.accountName}</strong><span>{snapshot.accountEmail ?? t('sync.signedInAccount')} · {roleLabel(snapshot.role, t)}</span></div> : null}
      {conflicts.length > 0 ? (
        <details className="sync-conflicts">
          <summary><ShieldAlert size={15} /> {t('sync.conflicts.summary', { count: conflicts.length })}</summary>
          <ul>{conflicts.map((conflict) => <li key={conflict.path}><code>{conflict.path}</code>: {t('sync.conflicts.values', { count: conflict.alternatives })}</li>)}</ul>
          <p>{t('sync.conflicts.help')}</p>
        </details>
      ) : <p className="sync-ok"><Check size={15} /> {t('sync.conflicts.none')}</p>}
    </section>
  );
}

function ConfigurationForm({ busy, onSubmit }: { busy?: string; onSubmit(config: Parameters<SyncPanelController['configure']>[0]): Promise<void> }) {
  const { t } = useI18n();
  const [endpoint, setEndpoint] = useState('https://cloud.appwrite.io/v1');
  const [projectId, setProjectId] = useState('');
  const [functionId, setFunctionId] = useState('canvink-sync');
  const [databaseId, setDatabaseId] = useState('canvink-sync');
  const [changesTableId, setChangesTableId] = useState('sync_changes');
  const [assetBucketId, setAssetBucketId] = useState('canvink-encrypted-assets');
  return (
    <form className="sync-section sync-form" onSubmit={(event) => {
      event.preventDefault();
      void onSubmit({ enabled: true, endpoint, projectId, functionId, databaseId, changesTableId, assetBucketId });
    }}>
      <h3>{t('sync.configure.title')}</h3>
      <p>{t('sync.configure.localOnly')}</p>
      <label>{t('sync.configure.endpoint')}<input required type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <label>{t('sync.configure.projectId')}<input required value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
      <details>
        <summary>{t('sync.configure.advanced')}</summary>
        <label>{t('sync.configure.functionId')}<input required value={functionId} onChange={(event) => setFunctionId(event.target.value)} /></label>
        <label>{t('sync.configure.databaseId')}<input required value={databaseId} onChange={(event) => setDatabaseId(event.target.value)} /></label>
        <label>{t('sync.configure.changesTable')}<input required value={changesTableId} onChange={(event) => setChangesTableId(event.target.value)} /></label>
        <label>{t('sync.configure.assetBucket')}<input required value={assetBucketId} onChange={(event) => setAssetBucketId(event.target.value)} /></label>
      </details>
      <button type="submit" disabled={Boolean(busy)}>{t('sync.configure.activate')}</button>
    </form>
  );
}

function AuthenticationForms({ snapshot, busy, controller, act }: PanelActionProps) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const success = typeof location === 'undefined' ? 'https://localhost/sync/success' : location.href;
  const failure = typeof location === 'undefined' ? 'https://localhost/sync/failure' : location.href;
  return (
    <section className="sync-section">
      <h3>{t('sync.auth.title')}</h3>
      <button type="button" disabled={Boolean(busy)} onClick={() => void act('oauth', () => controller.signInMicrosoft(success, failure))}>{t('sync.auth.microsoft')}</button>
      <div className="sync-divider"><span>{t('sync.auth.or')}</span></div>
      <form className="sync-form" onSubmit={(event) => { event.preventDefault(); void act('otp-start', () => controller.startEmailOtp(email)); }}>
        <label>{t('sync.auth.email')}<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button type="submit" disabled={Boolean(busy)}>{t('sync.auth.sendOtp')}</button>
      </form>
      {snapshot.otp ? (
        <form className="sync-form" onSubmit={(event) => { event.preventDefault(); void act('otp-complete', () => controller.completeEmailOtp(secret)); }}>
          <label>{t('sync.auth.otp')}<input required inputMode="numeric" autoComplete="one-time-code" value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
          {snapshot.otp.phrase ? <p>{t('sync.auth.phrase')} <strong>{snapshot.otp.phrase}</strong></p> : null}
          <button type="submit" disabled={Boolean(busy)}>{t('sync.auth.confirmOtp')}</button>
        </form>
      ) : null}
    </section>
  );
}

function DeviceApproval({ notebookId, snapshot, busy, controller, act }: PanelActionProps & { notebookId: string }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  return (
    <section className="sync-section">
      <h3>{t('sync.approval.title')}</h3>
      <p>{t('sync.approval.help')}</p>
      <button type="button" disabled={Boolean(busy)} onClick={() => void act('approval', () => controller.requestExistingDeviceApproval(notebookId))}>{t('sync.approval.request')}</button>
      {snapshot.approvalRequestCode ? (
        <div className="sync-approval-code">
          <p>{t('sync.approval.transferCode')}</p>
          <code>{snapshot.approvalRequestCode}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(snapshot.approvalRequestCode ?? '')}><Copy size={15} /> {t('sync.approval.copyCode')}</button>
        </div>
      ) : null}
      <form className="sync-form" onSubmit={(event) => { event.preventDefault(); void act('recover', () => controller.recoverWithCode(notebookId, code)); }}>
        <label>{t('sync.recovery.code')}<textarea required rows={3} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <button type="submit" disabled={Boolean(busy)}>{t('sync.recovery.restore')}</button>
      </form>
    </section>
  );
}

function RecoveryAcknowledgement({ code, busy, onAcknowledge }: { code: string; busy?: string; onAcknowledge(): Promise<void> }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <section className="sync-section sync-recovery" aria-labelledby="sync-recovery-title">
      <KeyRound aria-hidden="true" />
      <h3 id="sync-recovery-title">{t('sync.recovery.saveTitle')}</h3>
      <p>{t('sync.recovery.saveHelp')}</p>
      <code>{code}</code>
      <button type="button" onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}><Copy size={15} /> {copied ? t('sync.recovery.copied') : t('sync.recovery.copy')}</button>
      <label className="sync-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t('sync.recovery.confirmed')}</label>
      <button type="button" disabled={!confirmed || Boolean(busy)} onClick={() => void onAcknowledge()}>{t('sync.recovery.hide')}</button>
    </section>
  );
}

function CollaborationSettings({ notebookId, snapshot, busy, controller, act }: PanelActionProps & { notebookId: string }) {
  const { t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<NotebookRole>('editor');
  const [approvalCode, setApprovalCode] = useState('');
  const isOwner = snapshot.role === 'owner';
  return (
    <>
      {confirmElement}
      <section className="sync-section">
        <h3><Users size={17} /> {t('sync.presence.title')}</h3>
        {snapshot.presences.length === 0 ? <p>{t('sync.presence.none')}</p> : (
          <ul className="sync-presence">{snapshot.presences.map((presence) => <li key={presence.deviceId}><span style={{ background: presence.color }} />{presence.name} · {presence.pageId === snapshot.presences[0]?.pageId ? t('sync.presence.thisPage') : t('sync.presence.otherPage')}</li>)}</ul>
        )}
      </section>
      <section className="sync-section">
        <h3>{t('sync.members.title')}</h3>
        <ul className="sync-list">
          {snapshot.members.map((member) => (
            <li key={member.membershipId}>
              <span><strong>{member.name || member.email}</strong><small>{member.email} · {member.confirmed ? t('sync.members.confirmed') : t('sync.members.pending')}</small></span>
              {isOwner ? (
                <span className="sync-row-actions">
                  <select aria-label={t('sync.members.roleFor', { email: member.email })} value={member.role} onChange={(event) => void act(`role-${member.membershipId}`, () => controller.updateMemberRole(notebookId, member.membershipId, event.target.value as NotebookRole))}>
                    <option value="owner">{t('sync.role.owner')}</option><option value="editor">{t('sync.role.editor')}</option><option value="viewer">{t('sync.role.viewer')}</option>
                  </select>
                  <button type="button" className="sync-danger-button" onClick={() => void confirm({ title: t('sync.members.removeTitle'), message: t('sync.members.removeConfirm', { email: member.email }), confirmLabel: t('sync.members.remove'), danger: true }).then((confirmed) => {
                    if (confirmed) return act(`remove-${member.membershipId}`, () => controller.removeMember(notebookId, member.membershipId));
                  })}>{t('sync.members.remove')}</button>
                </span>
              ) : <span>{roleLabel(member.role, t)}</span>}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <form className="sync-form sync-inline-form" onSubmit={(event) => {
            event.preventDefault();
            const redirectUrl = new URL('/', window.location.href).toString();
            void act('invite', () => controller.invite({ notebookId, email: inviteEmail, role: inviteRole, redirectUrl }));
          }}>
            <label>{t('sync.members.email')}<input required type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label>
            <label>{t('sync.members.role')}<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as NotebookRole)}><option value="editor">{t('sync.role.editor')}</option><option value="viewer">{t('sync.role.viewer')}</option></select></label>
            <button type="submit" disabled={Boolean(busy)}>{t('sync.members.invite')}</button>
          </form>
        ) : null}
      </section>
      <section className="sync-section">
        <h3>{t('sync.devices.title')}</h3>
        {snapshot.devices.length === 0 ? <p>{t('sync.devices.none')}</p> : (
          <ul className="sync-list">{snapshot.devices.map((device) => <li key={device.deviceId}><span><strong>{device.name}{device.current ? ` · ${t('sync.devices.current')}` : ''}</strong><small>{device.status} {device.lastSeenAt ? `· ${device.lastSeenAt}` : ''}</small></span>{isOwner && !device.current && device.status === 'active' ? <button type="button" className="sync-danger-button" onClick={() => void confirm({ title: t('sync.devices.lostTitle'), message: t('sync.devices.lostConfirm'), confirmLabel: t('sync.devices.markLost'), danger: true }).then((confirmed) => {
                    if (confirmed) return act(`lost-${device.deviceId}`, () => controller.markDeviceLost(notebookId, device.deviceId));
                  })}>{t('sync.devices.markLost')}</button> : null}</li>)}</ul>
        )}
        {isOwner ? <button type="button" disabled={Boolean(busy)} onClick={() => void confirm({ title: t('sync.devices.rotateTitle'), message: t('sync.devices.rotateConfirm'), confirmLabel: t('sync.devices.rotate') }).then((confirmed) => {
          if (confirmed) return act('rotate', () => controller.rotateEpoch(notebookId));
        })}>{t('sync.devices.rotate')}</button> : null}
        <details className="sync-approval-details">
          <summary>{t('sync.devices.approveNew')}</summary>
          <form className="sync-form" onSubmit={(event) => { event.preventDefault(); void act('approve-device', () => controller.approveDeviceRequest(notebookId, approvalCode)); }}>
            <label>{t('sync.devices.approvalCode')}<textarea required rows={3} value={approvalCode} onChange={(event) => setApprovalCode(event.target.value)} /></label>
            <button type="submit" disabled={Boolean(busy)}>{t('sync.devices.activate')}</button>
          </form>
        </details>
      </section>
    </>
  );
}

function LocalDataActions({ snapshot, busy, controller, act }: PanelActionProps) {
  const { t } = useI18n();
  const { confirm, element: confirmElement } = useConfirm();
  if (snapshot.status === 'local') return null;
  return (
    <section className="sync-section sync-local-actions">
      {confirmElement}
      <h3>{t('sync.localData.title')}</h3>
      <p>{t('sync.localData.help')}</p>
      <button type="button" disabled={Boolean(busy)} onClick={() => void act('logout', () => controller.logout())}>{t('sync.localData.logout')}</button>
      <button type="button" className="sync-danger-button" disabled={Boolean(busy)} onClick={() => void confirm({ title: t('sync.localData.disableTitle'), message: t('sync.localData.disableConfirm'), confirmLabel: t('sync.localData.disable'), danger: true }).then((confirmed) => {
        if (confirmed) return act('disable', () => controller.disable());
      })}>{t('sync.localData.disable')}</button>
    </section>
  );
}

interface PanelActionProps {
  snapshot: SyncPanelSnapshot;
  busy?: string;
  controller: SyncPanelController;
  act(name: string, action: () => Promise<void>): Promise<void>;
}

async function runAction(name: string, action: () => Promise<void>, setBusy: (value?: string) => void, setError: (value?: string) => void, fallback: string): Promise<void> {
  setBusy(name);
  setError(undefined);
  try { await action(); } catch { setError(fallback); } finally { setBusy(undefined); }
}

function roleLabel(
  role: NotebookRole | null,
  t: (key: TranslationKey, parameters?: TranslationParameters) => string,
): string {
  if (role === 'owner') return t('sync.role.owner');
  if (role === 'editor') return t('sync.role.canEdit');
  if (role === 'viewer') return t('sync.role.viewer');
  return t('sync.role.none');
}
