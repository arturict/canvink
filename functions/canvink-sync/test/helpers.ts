import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type {
  AppwriteDataPort,
  EncryptedAssetPort,
  RowQuery,
  RowRecord,
} from "../src/appwriteRepository.js";
import type {
  MembershipRepository,
  NotebookRole,
  NotebookKeyEnvelope,
  PendingChangeEnvelope,
  RegisterDeviceRequest,
  DeviceApprovalChallenge,
  DeviceApprovalProof,
  BeginAssetUpload,
  RecoveryDeviceApprovalProof,
} from "../src/contracts.js";
import {
  approvalChallengeHash,
  approvalProofPayload,
  changeSignaturePayload,
  keyEnvelopeSignaturePayload,
  assetUploadAuthorizationPayload,
  recoveryApprovalProofPayload,
} from "../src/cryptoVerification.js";

const TEST_SIGNING_KEYS = generateKeyPairSync("ed25519");
const TEST_SIGNING_PUBLIC_DER = TEST_SIGNING_KEYS.publicKey.export({
  type: "spki",
  format: "der",
});
export const TEST_SIGNING_PUBLIC_KEY = Buffer.from(TEST_SIGNING_PUBLIC_DER)
  .subarray(-32)
  .toString("base64url");
const TEST_RECOVERY_SIGNING_KEYS = generateKeyPairSync("ed25519");
const TEST_RECOVERY_SIGNING_PUBLIC_DER =
  TEST_RECOVERY_SIGNING_KEYS.publicKey.export({ type: "spki", format: "der" });
export const TEST_RECOVERY_SIGNING_PUBLIC_KEY = Buffer.from(
  TEST_RECOVERY_SIGNING_PUBLIC_DER,
)
  .subarray(-32)
  .toString("base64url");

export function assetUploadRequest(
  overrides: Omit<Partial<BeginAssetUpload>, "uploadSignature"> = {},
) {
  const unsigned = {
    protocolVersion: 1 as const,
    notebookId: "notebook-1",
    deviceId: "device-1",
    encryptedHash: bytes(32, 30),
    encryptedSize: 10,
    ...overrides,
  };
  return {
    ...unsigned,
    uploadSignature: sign(
      null,
      assetUploadAuthorizationPayload(unsigned),
      TEST_SIGNING_KEYS.privateKey,
    ).toString("base64url"),
  };
}

export function signKeyEnvelope(
  envelope: Omit<NotebookKeyEnvelope, "signature">,
): NotebookKeyEnvelope {
  const { envelopeHash, ...unsigned } = envelope;
  return {
    ...unsigned,
    envelopeHash,
    signature: sign(
      null,
      keyEnvelopeSignaturePayload(unsigned),
      TEST_SIGNING_KEYS.privateKey,
    ).toString("base64url"),
  };
}

export function resignKeyEnvelope(
  envelope: NotebookKeyEnvelope,
): NotebookKeyEnvelope {
  return signKeyEnvelope({
    protocolVersion: envelope.protocolVersion,
    notebookId: envelope.notebookId,
    keyEpoch: envelope.keyEpoch,
    senderDeviceId: envelope.senderDeviceId,
    recipient: envelope.recipient,
    senderEncryptionPublicKey: envelope.senderEncryptionPublicKey,
    recipientEncryptionPublicKey: envelope.recipientEncryptionPublicKey,
    ...(envelope.recoverySigningPublicKey === undefined
      ? {}
      : { recoverySigningPublicKey: envelope.recoverySigningPublicKey }),
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    envelopeHash: envelope.envelopeHash,
  });
}

export function recoveryApprovalProof(
  challenge: DeviceApprovalChallenge,
  recoveryKeyId = "recovery-1",
): RecoveryDeviceApprovalProof {
  const challengeHash = approvalChallengeHash(challenge).toString("base64url");
  return {
    protocolVersion: 1,
    recoveryKeyId,
    challengeHash,
    signature: sign(
      null,
      recoveryApprovalProofPayload(recoveryKeyId, challengeHash),
      TEST_RECOVERY_SIGNING_KEYS.privateKey,
    ).toString("base64url"),
  };
}

export function approvalProof(
  challenge: DeviceApprovalChallenge,
  approverDeviceId = "device-1",
): DeviceApprovalProof {
  const challengeHash = approvalChallengeHash(challenge).toString("base64url");
  return {
    protocolVersion: 1,
    approverDeviceId,
    challengeHash,
    signature: sign(
      null,
      approvalProofPayload(approverDeviceId, challengeHash),
      TEST_SIGNING_KEYS.privateKey,
    ).toString("base64url"),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface Transaction {
  reads: Map<string, number>;
  writes: Map<string, RowRecord | null>;
  active: boolean;
}

function conflictError(): Error & { code: number } {
  return Object.assign(new Error("transaction conflict"), { code: 409 });
}

export class MemoryDataPort implements AppwriteDataPort {
  private readonly rows = new Map<string, RowRecord>();
  private readonly versions = new Map<string, number>();
  private readonly transactions = new Map<string, Transaction>();
  private nextTransaction = 1;
  loseNextCommitAcknowledgement = false;
  beforeCommit: ((transactionId: string) => Promise<void>) | undefined;

  private key(tableId: string, rowId: string): string {
    return `${tableId}\0${rowId}`;
  }

  seed(tableId: string, rowId: string, data: Record<string, unknown>): void {
    const key = this.key(tableId, rowId);
    this.rows.set(key, { $id: rowId, ...clone(data) });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  read(tableId: string, rowId: string): RowRecord | null {
    const row = this.rows.get(this.key(tableId, rowId));
    return row ? clone(row) : null;
  }

  async createTransaction(): Promise<string> {
    const id = `tx-${this.nextTransaction++}`;
    this.transactions.set(id, {
      reads: new Map(),
      writes: new Map(),
      active: true,
    });
    return id;
  }

  private transaction(id: string): Transaction {
    const transaction = this.transactions.get(id);
    if (!transaction?.active) throw new Error("inactive transaction");
    return transaction;
  }

  async commitTransaction(transactionId: string): Promise<void> {
    const transaction = this.transaction(transactionId);
    if (this.beforeCommit) await this.beforeCommit(transactionId);
    for (const [key, readVersion] of transaction.reads) {
      if ((this.versions.get(key) ?? 0) !== readVersion) throw conflictError();
    }
    for (const [key, row] of transaction.writes) {
      if (row === null) this.rows.delete(key);
      else this.rows.set(key, clone(row));
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    transaction.active = false;
    if (this.loseNextCommitAcknowledgement) {
      this.loseNextCommitAcknowledgement = false;
      throw Object.assign(new Error("lost acknowledgement"), { code: 503 });
    }
  }

  async rollbackTransaction(transactionId: string): Promise<void> {
    const transaction = this.transactions.get(transactionId);
    if (transaction) transaction.active = false;
  }

  async getRow(
    tableId: string,
    rowId: string,
    transactionId?: string,
  ): Promise<RowRecord | null> {
    const key = this.key(tableId, rowId);
    if (transactionId) {
      const transaction = this.transaction(transactionId);
      const staged = transaction.writes.get(key);
      if (staged !== undefined) return staged === null ? null : clone(staged);
      transaction.reads.set(key, this.versions.get(key) ?? 0);
    }
    const row = this.rows.get(key);
    return row ? clone(row) : null;
  }

  async listRows(
    tableId: string,
    query: RowQuery,
    transactionId?: string,
  ): Promise<RowRecord[]> {
    const prefix = `${tableId}\0`;
    let rows = [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => clone(row));
    if (transactionId) {
      const transaction = this.transaction(transactionId);
      for (const [key, row] of transaction.writes) {
        if (key.startsWith(prefix) && row === null) {
          rows = rows.filter(
            (candidate) => candidate.$id !== key.slice(prefix.length),
          );
        } else if (key.startsWith(prefix) && row !== null)
          rows = [
            ...rows.filter((candidate) => candidate.$id !== row.$id),
            clone(row),
          ];
      }
    }
    for (const [key, expected] of Object.entries(query.equal ?? {})) {
      rows = rows.filter((row) =>
        Array.isArray(expected)
          ? expected.some((candidate) => candidate === row[key])
          : row[key] === expected,
      );
    }
    for (const [key, minimum] of Object.entries(query.greaterThan ?? {})) {
      rows = rows.filter(
        (row) => typeof row[key] === "number" && row[key] > minimum,
      );
    }
    for (const [key, maximum] of Object.entries(query.lessThan ?? {})) {
      rows = rows.filter(
        (row) => row[key] !== undefined && String(row[key]) < String(maximum),
      );
    }
    if (query.orderAsc) {
      const key = query.orderAsc;
      rows.sort((left, right) => {
        const leftValue = key === "$id" ? left.$id : left[key];
        const rightValue = key === "$id" ? right.$id : right[key];
        if (typeof leftValue === "number" && typeof rightValue === "number")
          return leftValue - rightValue;
        return String(leftValue).localeCompare(String(rightValue));
      });
    }
    if (query.cursorAfter) {
      const cursorIndex = rows.findIndex(
        (row) => row.$id === query.cursorAfter,
      );
      rows = cursorIndex < 0 ? [] : rows.slice(cursorIndex + 1);
    }
    return rows.slice(0, query.limit);
  }

  async createRow(
    tableId: string,
    rowId: string,
    data: Record<string, unknown>,
    permissions: string[],
    transactionId: string,
  ): Promise<void> {
    const transaction = this.transaction(transactionId);
    const key = this.key(tableId, rowId);
    if (!transaction.reads.has(key))
      transaction.reads.set(key, this.versions.get(key) ?? 0);
    if (this.rows.has(key) || transaction.writes.has(key))
      throw conflictError();
    transaction.writes.set(key, {
      $id: rowId,
      $permissions: clone(permissions),
      ...clone(data),
    });
  }

  async updateRow(
    tableId: string,
    rowId: string,
    data: Record<string, unknown>,
    permissions: string[] | undefined,
    transactionId: string,
  ): Promise<void> {
    const transaction = this.transaction(transactionId);
    const key = this.key(tableId, rowId);
    const staged = transaction.writes.get(key);
    const current = staged === undefined ? this.rows.get(key) : staged;
    if (!current) throw Object.assign(new Error("not found"), { code: 404 });
    if (!transaction.reads.has(key))
      transaction.reads.set(key, this.versions.get(key) ?? 0);
    transaction.writes.set(key, {
      ...clone(current),
      ...clone(data),
      ...(permissions === undefined
        ? {}
        : { $permissions: clone(permissions) }),
    });
  }

  async deleteRow(
    tableId: string,
    rowId: string,
    transactionId?: string,
  ): Promise<void> {
    const key = this.key(tableId, rowId);
    if (transactionId) {
      const transaction = this.transaction(transactionId);
      if (!transaction.reads.has(key))
        transaction.reads.set(key, this.versions.get(key) ?? 0);
      transaction.writes.set(key, null);
      return;
    }
    this.rows.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}

export class MemoryAssetPort implements EncryptedAssetPort {
  readonly files = new Map<
    string,
    { encryptedSize: number; encryptedHash: string }
  >();
  readonly sealed = new Map<string, string>();
  readonly chunks = new Map<string, Uint8Array>();
  beforeAssemble: (() => Promise<void>) | undefined;

  async inspect(
    fileId: string,
  ): Promise<{ encryptedSize: number; encryptedHash: string }> {
    const file = this.files.get(fileId);
    if (!file) throw Object.assign(new Error("missing file"), { code: 404 });
    return clone(file);
  }

  async sealToNotebook(fileId: string, notebookId: string): Promise<void> {
    this.sealed.set(fileId, notebookId);
  }

  async stageChunk(
    assetId: string,
    chunkIndex: number,
    chunkBytes: Uint8Array,
    chunkHash: string,
  ): Promise<{ duplicate: boolean }> {
    const key = `${assetId}:${chunkIndex}`;
    const existing = this.chunks.get(key);
    if (existing) {
      const hash = createHash("sha256").update(existing).digest("base64url");
      if (hash !== chunkHash || !Buffer.from(existing).equals(chunkBytes))
        throw Object.assign(new Error("chunk conflict"), { code: 409 });
      return { duplicate: true };
    }
    this.chunks.set(key, Uint8Array.from(chunkBytes));
    return { duplicate: false };
  }

  async assembleStagedChunks(
    fileId: string,
    assetId: string,
    chunkCount: number,
  ): Promise<{ encryptedSize: number; encryptedHash: string }> {
    if (this.beforeAssemble) await this.beforeAssemble();
    const existing = this.files.get(fileId);
    if (existing) return clone(existing);
    const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => {
      const chunk = this.chunks.get(`${assetId}:${chunkIndex}`);
      if (!chunk) throw Object.assign(new Error("missing chunk"), { code: 404 });
      return Buffer.from(chunk);
    });
    const bytes = Buffer.concat(chunks);
    const metadata = {
      encryptedSize: bytes.byteLength,
      encryptedHash: createHash("sha256").update(bytes).digest("base64url"),
    };
    this.files.set(fileId, metadata);
    return clone(metadata);
  }

  async removeStagedChunks(assetId: string, chunkCount: number): Promise<void> {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1)
      this.chunks.delete(`${assetId}:${chunkIndex}`);
  }

  async removeIfExists(fileId: string): Promise<void> {
    this.files.delete(fileId);
    this.sealed.delete(fileId);
  }
}

export class MemoryMemberships implements MembershipRepository {
  readonly roles = new Map<string, NotebookRole>();

  set(notebookId: string, userId: string, role: NotebookRole): void {
    this.roles.set(`${notebookId}\0${userId}`, role);
  }

  remove(notebookId: string, userId: string): void {
    this.roles.delete(`${notebookId}\0${userId}`);
  }

  async roleFor(
    notebookId: string,
    userId: string,
  ): Promise<NotebookRole | null> {
    return this.roles.get(`${notebookId}\0${userId}`) ?? null;
  }

  async memberAccountIds(notebookId: string): Promise<string[]> {
    const prefix = `${notebookId}\0`;
    return [...this.roles.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }
}

export function bytes(length: number, fill = 1): string {
  return Buffer.alloc(length, fill).toString("base64url");
}

export function change(
  overrides: Partial<PendingChangeEnvelope> = {},
): PendingChangeEnvelope {
  const { signature, ...unsignedOverrides } = overrides;
  const unsigned: Omit<PendingChangeEnvelope, "signature"> = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    documentId: "page-1",
    deviceId: "device-1",
    keyEpoch: 1,
    changeHash: bytes(32, 1),
    nonce: bytes(24, 2),
    ciphertext: bytes(48, 3),
    ...unsignedOverrides,
  };
  return {
    ...unsigned,
    signature:
      signature ??
      sign(
        null,
        changeSignaturePayload(unsigned),
        TEST_SIGNING_KEYS.privateKey,
      ).toString("base64url"),
  };
}

export function deviceRegistration(
  overrides: Partial<RegisterDeviceRequest> = {},
): RegisterDeviceRequest {
  return {
    protocolVersion: 1,
    deviceId: "device-1",
    encryptionPublicKey: bytes(32, 21),
    signingPublicKey: TEST_SIGNING_PUBLIC_KEY,
    ...overrides,
  };
}
