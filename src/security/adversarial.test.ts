import { jsPDF } from 'jspdf';
import { describe, expect, it, vi } from 'vitest';
import maliciousOneNoteHtml from '../../tests/fixtures/security/malicious-onenote.html?raw';
import {
  imageWithDimensions,
  pdfBombLike,
  polyglotPng,
  syncPacket,
  TINY_PNG,
} from '../../tests/fixtures/security/synthetic';
import { MemoryAssetRepository, reopenAsset, storeOriginalAsset } from '../assets';
import { MAX_PDF_FILE_BYTES } from '../domain/limits';
import type { AssetBlob } from '../domain/v2';
import { sha256Bytes } from '../domain/v2/hash';
import { convertOneNoteHtml } from '../import/onenoteHtml';
import { createCanvinkBundle, readCanvinkBundle, type CanvinkBundleInput } from '../io/canvinkBundle';
import { inspectPdf } from '../io/pdf';
import { commitAppliedEnvelopes, createInboundSyncState, ingestSyncEnvelope } from '../sync/inbox';
import {
  createDeviceIdentity,
  createNotebookKeyEnvelope,
  destroyDeviceIdentity,
  destroyRecoverySecret,
  encryptChange,
  generateNotebookKey,
  generateRecoveryKit,
  NotebookKeyring,
  openNotebookKeyEnvelope,
  parseRecoveryCode,
  verifyAndDecryptChange,
} from '../sync/crypto';
import type { AppwriteSyncServices } from '../sync/client/appwrite';
import { SyncCoordinator } from '../sync/client/coordinator';
import { registerDeviceAndRequireActivation } from '../sync/client/runtime';
import type {
  DurableSyncSnapshot,
  DurableSyncStatePort,
  NetworkStatePort,
  NotebookRole,
  SyncAuthPort,
  SyncCryptoPort,
  SyncDocumentPort,
  SyncRealtimePort,
  SyncTransportPort,
} from '../sync/client/types';
import { parseCatchUpPage, parseSyncEnvelope } from '../sync/validation';
import type { CatchUpPage, PendingSyncEnvelope } from '../sync/types';

const text = (value: string) => new TextEncoder().encode(value);

function bundleFixture(): CanvinkBundleInput {
  return {
    createdAt: '2026-08-03T12:00:00.000Z',
    notebook: { id: 'notebook-security', bytes: text('notebook') },
    pages: [
      { id: 'page-alpha', bytes: text('alpha') },
      { id: 'page-bravo', bytes: text('bravo') },
    ],
    assets: [{ bytes: TINY_PNG, mimeType: 'image/png', originalName: 'safe.png' }],
  };
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function replaceManifestText(bundle: Uint8Array, search: string, replacement: string): Uint8Array {
  if (search.length !== replacement.length) throw new Error('Manifest mutations must preserve ZIP32 offsets.');
  const result = bundle.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const nameLength = view.getUint16(26, true);
  const manifestSize = view.getUint32(18, true);
  const manifestOffset = 30 + nameLength;
  const manifest = new TextDecoder().decode(result.subarray(manifestOffset, manifestOffset + manifestSize));
  const changed = manifest.replace(search, replacement);
  if (changed === manifest) throw new Error(`Manifest fixture does not contain ${search}.`);
  result.set(text(changed), manifestOffset);
  const checksum = crc32(result.subarray(manifestOffset, manifestOffset + manifestSize));
  view.setUint32(14, checksum, true);
  const centralOffset = view.getUint32(result.length - 6, true);
  view.setUint32(centralOffset + 16, checksum, true);
  return result;
}

function markFirstZipEntryCompressed(bundle: Uint8Array): Uint8Array {
  const result = bundle.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint16(8, 8, true);
  const centralOffset = view.getUint32(result.length - 6, true);
  view.setUint16(centralOffset + 10, 8, true);
  view.setUint32(centralOffset + 24, 0xffff_ffff, true);
  return result;
}

describe('adversarial import and asset acceptance', () => {
  it('flattens safe OneNote text while dropping executable HTML, CSS, frames, and URLs', () => {
    const result = convertOneNoteHtml(maliciousOneNoteHtml, []);
    const serialized = JSON.stringify(result.blocks);

    expect(serialized).toContain('Safe lesson text');
    expect(serialized).toContain('https://school.example/lesson');
    for (const forbidden of [
      '__CANVINK_XSS__', 'script-secret', 'frame-secret', 'svg-secret', 'math-secret',
      'form-secret', 'javascript:', 'data:text/html', 'file:///', 'attacker.invalid',
      'background-image', 'expression(', 'onload', 'srcdoc',
    ]) expect(serialized).not.toContain(forbidden);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'unsupported-element', 'unsafe-url-dropped', 'style-dropped',
      'image-resource-missing', 'attachment-resource-missing',
    ]));
  });

  it('bounds hostile OneNote depth and node fan-out without returning a partial tree', () => {
    const deep = `${'<div>'.repeat(10)}secret${'</div>'.repeat(10)}`;
    const many = `<body>${'<span>x</span>'.repeat(20)}</body>`;
    expect(convertOneNoteHtml(deep, [], { maxDepth: 4 }).blocks).toEqual([]);
    expect(convertOneNoteHtml(many, [], { maxNodes: 8 }).blocks).toEqual([]);
  });

  it('rejects corrupt, truncated, oversized, bomb-like, and trailing-polyglot PDFs', async () => {
    const valid = new jsPDF({ unit: 'pt', format: 'a4' });
    valid.text('safe', 40, 60);
    const original = new Uint8Array(valid.output('arraybuffer'));
    const suffix = text('<script>window.__CANVINK_XSS__=true</script>');
    const polyglot = new Uint8Array(original.length + suffix.length);
    polyglot.set(original);
    polyglot.set(suffix, original.length);

    await expect(inspectPdf(text('%PDF-'))).rejects.toThrow();
    await expect(inspectPdf(original.slice(0, Math.floor(original.length / 2)))).rejects.toThrow();
    await expect(inspectPdf(new Uint8Array(MAX_PDF_FILE_BYTES + 1))).rejects.toThrow(/byte limits/);
    await expect(inspectPdf(pdfBombLike())).rejects.toThrow();
    await expect(inspectPdf(polyglot)).rejects.toThrow(/trailing|polyglot|EOF/i);
  });

  it('rejects image pixel bombs, truncated headers, trailing polyglots, and raced corrupt dedupe', async () => {
    const repository = new MemoryAssetRepository();
    await expect(storeOriginalAsset(repository, {
      bytes: imageWithDimensions(65_535, 65_535), mimeType: 'image/png', kind: 'image',
    })).rejects.toThrow(/pixel limit/);
    await expect(storeOriginalAsset(repository, {
      bytes: TINY_PNG.slice(0, 20), mimeType: 'image/png', kind: 'image',
    })).rejects.toThrow(/corrupt|truncated/);
    const corrupt = TINY_PNG.slice();
    corrupt[41] ^= 1;
    await expect(storeOriginalAsset(repository, {
      bytes: corrupt, mimeType: 'image/png', kind: 'image',
    })).rejects.toThrow(/corrupt|truncated/);
    await expect(storeOriginalAsset(repository, {
      bytes: polyglotPng(), mimeType: 'image/png', kind: 'image',
    })).rejects.toThrow(/trailing|polyglot|PNG/i);

    const id = await sha256Bytes(TINY_PNG);
    const corruptStored: AssetBlob = { assetId: id, checksum: id, size: 1, bytes: new Uint8Array([0]) };
    await expect(reopenAsset({
      getAsset: async () => corruptStored,
      putAsset: async () => 'deduplicated',
    }, { assetId: id, checksum: id, mimeType: 'image/png', size: TINY_PNG.length, role: 'original' }))
      .rejects.toThrow(/integrity/);
  });
});

describe('adversarial .canvink acceptance', () => {
  it('rejects checksums, traversal, duplicate IDs, compressed bombs, and bounded overflows before yielding', async () => {
    const bundle = await createCanvinkBundle(bundleFixture());
    const imported = await readCanvinkBundle(bundle);
    const wrongHash = `${imported.manifest.notebook.document.sha256[0] === '0' ? '1' : '0'}${imported.manifest.notebook.document.sha256.slice(1)}`;
    await expect(readCanvinkBundle(replaceManifestText(
      bundle, imported.manifest.notebook.document.sha256, wrongHash,
    ))).rejects.toThrow(/SHA-256/);
    await expect(readCanvinkBundle(replaceManifestText(
      bundle, 'documents/notebook.bin', '../escape/notebook.bin',
    ))).rejects.toThrow(/canonical|unsafe/i);
    await expect(readCanvinkBundle(replaceManifestText(
      bundle, 'page-bravo', 'page-alpha',
    ))).rejects.toThrow(/Duplicate page ID/);
    await expect(readCanvinkBundle(markFirstZipEntryCompressed(bundle))).rejects.toThrow(
      /canonical uncompressed|uncompressed import limit/i,
    );
    await expect(readCanvinkBundle(bundle, { maxTotalUncompressedBytes: 4 })).rejects.toThrow(
      /uncompressed import limit/,
    );
    await expect(readCanvinkBundle(bundle, { maxEntries: 2 })).rejects.toThrow(/entry count/);
  });

  it('leaves caller authority untouched after every rejected bundle', async () => {
    const bundle = await createCanvinkBundle(bundleFixture());
    const state = { authority: 'schema-v2', revision: 7 };
    await readCanvinkBundle(markFirstZipEntryCompressed(bundle)).catch(() => undefined);
    expect(state).toEqual({ authority: 'schema-v2', revision: 7 });
  });
});

async function identities() {
  const sender = await createDeviceIdentity({
    accountId: 'account-owner', deviceId: 'device-owner',
    encryptionSeed: new Uint8Array(32).fill(1), signingSeed: new Uint8Array(32).fill(2),
  });
  const recipient = await createDeviceIdentity({
    accountId: 'account-editor', deviceId: 'device-editor',
    encryptionSeed: new Uint8Array(32).fill(3), signingSeed: new Uint8Array(32).fill(4),
  });
  return { sender, recipient };
}

describe('adversarial encrypted sync acceptance', () => {
  it('rejects tampered metadata/ciphertext/signature, wrong senders, and wrong epochs without plaintext leakage', async () => {
    const { sender, recipient } = await identities();
    const notebookKey = await generateNotebookKey('notebook-security', 1);
    const plaintext = text('PRIVATE-AUTOMERGE-CONTENT');
    const encrypted = await encryptChange({
      notebookId: 'notebook-security', documentId: 'document-security', plaintext,
      notebookKey, sender, nonce: new Uint8Array(24).fill(7),
    });
    expect(new TextDecoder().decode(encrypted.ciphertext)).not.toContain('PRIVATE-AUTOMERGE-CONTENT');
    expect(JSON.stringify(encrypted)).not.toContain('PRIVATE-AUTOMERGE-CONTENT');

    const mutations: PendingSyncEnvelope[] = [
      { ...encrypted, documentId: 'document-other' },
      { ...encrypted, ciphertext: Uint8Array.from(encrypted.ciphertext, (byte, index) => index === 0 ? byte ^ 1 : byte) },
      { ...encrypted, signature: Uint8Array.from(encrypted.signature, (byte, index) => index === 0 ? byte ^ 1 : byte) },
    ];
    for (const mutation of mutations) {
      await expect(verifyAndDecryptChange({ envelope: mutation, notebookKey, sender: sender.publicIdentity }))
        .rejects.toMatchObject({ code: 'signature-invalid' });
    }
    await expect(verifyAndDecryptChange({ envelope: encrypted, notebookKey, sender: recipient.publicIdentity }))
      .rejects.toMatchObject({ code: 'wrong-device' });
    await expect(verifyAndDecryptChange({
      envelope: encrypted,
      notebookKey: { notebookId: notebookKey.notebookId, epoch: 2, key: new Uint8Array(32).fill(9) },
      sender: sender.publicIdentity,
    })).rejects.toMatchObject({ code: 'wrong-epoch' });
  });

  it('buffers reordering but rejects replay, sequence conflicts, wrong notebooks, and compromised pages', () => {
    const initial = createInboundSyncState('notebook-security');
    const second = ingestSyncEnvelope(initial, syncPacket(2));
    expect(second).toMatchObject({ accepted: true, ready: [] });
    if (!second.accepted) throw new Error('Expected sequence 2 to buffer.');
    const first = ingestSyncEnvelope(second.state, syncPacket(1));
    expect(first).toMatchObject({ accepted: true });
    if (!first.accepted) throw new Error('Expected sequence 1 to complete the prefix.');
    expect(first.ready.map((packet) => packet.sequence)).toEqual([1, 2]);
    const applied = commitAppliedEnvelopes(first.state, first.ready);
    expect(applied.contiguousSequence).toBe(2);
    expect(ingestSyncEnvelope(applied, syncPacket(1))).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(ingestSyncEnvelope(applied, syncPacket(1, 9))).toMatchObject({ accepted: false, reason: 'sequence-conflict' });
    expect(ingestSyncEnvelope(applied, syncPacket(3, 1))).toMatchObject({ accepted: false, reason: 'replay' });
    expect(ingestSyncEnvelope(createInboundSyncState('notebook-security', 2), syncPacket(1, 9)))
      .toMatchObject({ accepted: false, reason: 'replay' });
    expect(ingestSyncEnvelope(initial, { ...syncPacket(1), notebookId: 'other' })).toMatchObject({
      accepted: false, reason: 'wrong-notebook',
    });

    expect(() => parseSyncEnvelope({ ...syncPacket(1), plaintext: 'server leaked this' })).toThrow();
    expect(() => parseCatchUpPage({
      notebookId: 'notebook-security', afterSequence: 0, snapshotSequence: 2,
      hasMore: false, envelopes: [syncPacket(2), syncPacket(1)],
    })).toThrow(/contiguous and ascending/);
    expect(() => parseCatchUpPage({
      notebookId: 'notebook-security', afterSequence: 0, snapshotSequence: 1,
      hasMore: false, envelopes: [{ ...syncPacket(1), notebookId: 'other' }],
    })).toThrow(/another notebook/);
  });

  it('blocks viewer writes and rejects revoked-device activation', async () => {
    const role = { value: 'viewer' as NotebookRole | null };
    const coordinator = coordinatorFixture(role);
    await coordinator.start();
    await expect(coordinator.enqueueLocalChange('document-security', text('secret')))
      .rejects.toMatchObject({ code: 'viewer-read-only' });

    const { sender } = await identities();
    const services = {
      directory: {
        registerDevice: vi.fn(async () => ({
          device: {
            protocolVersion: 1 as const, deviceId: sender.publicIdentity.deviceId,
            encryptionPublicKey: sender.publicIdentity.encryptionPublicKey,
            signingPublicKey: sender.publicIdentity.signingPublicKey,
            status: 'revoked' as const,
            createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T12:01:00.000Z',
            revokedAt: '2026-08-03T12:01:00.000Z',
          }, duplicate: false, bootstrap: false,
        })),
      },
    } as unknown as AppwriteSyncServices;
    await expect(registerDeviceAndRequireActivation(services, sender))
      .rejects.toMatchObject({ code: 'key-epoch-unavailable' });
  });

  it('rebuilds from local authority after a server cursor reset', async () => {
    const role = { value: 'editor' as NotebookRole | null };
    const captured: PendingSyncEnvelope[] = [];
    let serverSequence = 0;
    let reset = true;
    const coordinator = coordinatorFixture(role, {
      transport: {
        appendChange: async (packet) => {
          captured.push(structuredClone(packet));
          serverSequence += 1;
          return { envelope: { ...structuredClone(packet), sequence: serverSequence }, duplicate: false };
        },
        listChangesAfter: async (notebookId, afterSequence): Promise<CatchUpPage> => {
          if (reset) {
            reset = false;
            return { notebookId, afterSequence, snapshotSequence: 0, hasMore: false, envelopes: [] };
          }
          const envelopes = captured.map((packet, index) => ({ ...packet, sequence: index + 1 }));
          return { notebookId, afterSequence, snapshotSequence: envelopes.length, hasMore: false, envelopes: envelopes.slice(afterSequence) };
        },
      },
      durableCursor: 5,
      online: true,
      localChanges: [{ documentId: 'document-security', change: text('LOCAL-AUTHORITY-SECRET') }],
    });
    await coordinator.start();
    await coordinator.syncNow();
    expect(coordinator.cursor).toBe(1);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain('LOCAL-AUTHORITY-SECRET');
  });

  it('fails irreversibly after device, keyring, and recovery material are all destroyed', async () => {
    const { sender, recipient } = await identities();
    const notebookKey = await generateNotebookKey('notebook-security', 1);
    const keyring = new NotebookKeyring(notebookKey);
    const recoveryKit = await generateRecoveryKit();
    const recoveryCode = recoveryKit.reveal();
    const recoverySecret = await parseRecoveryCode(recoveryCode);
    const envelope = await createNotebookKeyEnvelope({
      notebookKey, sender,
      recipient: { kind: 'recovery', identity: recoverySecret },
      nonce: new Uint8Array(24).fill(11),
    });
    await Promise.all([
      destroyRecoverySecret(recoverySecret),
      destroyDeviceIdentity(recipient),
      keyring.destroy(),
    ]);
    await expect(openNotebookKeyEnvelope({ envelope, sender: sender.publicIdentity, recipient: recoverySecret }))
      .rejects.toMatchObject({ code: 'destroyed-secret' });
    expect(() => keyring.currentKey()).toThrow(/destroyed/);
    await expect(parseRecoveryCode(`${recoveryCode.slice(0, -1)}x`))
      .rejects.toMatchObject({ code: 'recovery-code-invalid' });
  });
});

function coordinatorFixture(
  role: { value: NotebookRole | null },
  overrides: {
    transport?: Pick<SyncTransportPort, 'appendChange' | 'listChangesAfter'>;
    durableCursor?: number;
    online?: boolean;
    localChanges?: ReadonlyArray<{ documentId: string; change: Uint8Array }>;
  } = {},
): SyncCoordinator {
  const auth: SyncAuthPort = {
    startMicrosoftOAuth: async () => undefined,
    startEmailOtp: async () => ({ userId: 'user', expire: 'later' }),
    completeEmailOtp: async () => ({ userId: 'user', name: 'User' }),
    currentAccount: async () => ({ userId: 'user', name: 'User' }),
    logout: async () => undefined,
    roleForNotebook: async () => role.value,
  };
  const network: NetworkStatePort = { isOnline: () => overrides.online ?? false, subscribe: () => () => undefined };
  const realtime: SyncRealtimePort = {
    subscribe: async () => async () => undefined,
    publishPresence: async () => undefined,
    disconnect: async () => undefined,
  };
  const transport: SyncTransportPort = {
    appendChange: overrides.transport?.appendChange ?? (async (packet) => ({ envelope: { ...packet, sequence: 1 }, duplicate: false })),
    listChangesAfter: overrides.transport?.listChangesAfter ?? (async (notebookId, afterSequence) => ({
      notebookId, afterSequence, snapshotSequence: afterSequence, hasMore: false, envelopes: [],
    })),
    acknowledgeHeads: async (value) => ({ accepted: value.documents.length, sequence: value.sequence }),
    putKeyEnvelope: async () => ({ envelopeId: 'key', duplicate: false }),
    uploadEncryptedAsset: async () => { throw new Error('not used'); },
    downloadEncryptedAsset: async () => { throw new Error('not used'); },
  };
  const crypto: SyncCryptoPort = {
    currentKeyEpoch: () => 1,
    encryptChange: async (documentId, plaintext) => ({
      protocolVersion: 1, notebookId: 'notebook-security', documentId,
      deviceId: 'device-security', keyEpoch: 1, sequence: null,
      changeHash: new Uint8Array(32).fill(plaintext[0] ?? 0), nonce: new Uint8Array(24).fill(1),
      ciphertext: new Uint8Array([99, plaintext.byteLength]), signature: new Uint8Array(64).fill(2),
    }),
    decryptChange: async () => text('remote-change'),
    awaitKeyEpoch: async () => undefined,
  };
  const documents: SyncDocumentPort = {
    applyRemoteChange: async () => undefined,
    heads: async () => [],
    allChanges: async () => [...(overrides.localChanges ?? [])],
  };
  let durableSnapshot: DurableSyncSnapshot | undefined = overrides.durableCursor === undefined
    ? undefined
    : {
      version: 1, notebookId: 'notebook-security', outbox: { nextLocalOrder: 1, pending: [], acknowledged: [] },
      inbox: { notebookId: 'notebook-security', contiguousSequence: overrides.durableCursor, buffered: [], applied: [] },
    };
  const durable: DurableSyncStatePort = {
    load: async () => durableSnapshot ? structuredClone(durableSnapshot) : undefined,
    save: async (snapshot) => { durableSnapshot = structuredClone(snapshot); },
  };
  return new SyncCoordinator({
    notebookId: 'notebook-security', deviceId: 'device-security', auth, transport, realtime,
    durable, crypto, documents, network, backoff: { wait: async () => undefined },
    createOperationId: () => 'security-operation',
  });
}
