import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  Account,
  AppwriteException,
  Client,
  Query,
  Storage,
  TablesDB,
  Teams,
  type Models,
} from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import {
  LIMITS,
  type IdentityVerifier,
  type MembershipRepository,
  type NotebookRole,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import {
  RESOURCE_IDS,
  type AppwriteDataPort,
  type EncryptedAssetPort,
  type RowQuery,
  type RowRecord,
} from "./appwriteRepository.js";

function isNotFound(error: unknown): boolean {
  return error instanceof AppwriteException && error.code === 404;
}

function asRow(row: Models.Row): RowRecord {
  return row as unknown as RowRecord;
}

export class NodeAppwriteDataPort implements AppwriteDataPort {
  private readonly tables: TablesDB;

  constructor(client: Client) {
    this.tables = new TablesDB(client);
  }

  async createTransaction(ttlSeconds: number): Promise<string> {
    const transaction = await this.tables.createTransaction({
      ttl: ttlSeconds,
    });
    return transaction.$id;
  }

  async commitTransaction(transactionId: string): Promise<void> {
    await this.tables.updateTransaction({ transactionId, commit: true });
  }

  async rollbackTransaction(transactionId: string): Promise<void> {
    await this.tables.updateTransaction({ transactionId, rollback: true });
  }

  async getRow(
    tableId: string,
    rowId: string,
    transactionId?: string,
  ): Promise<RowRecord | null> {
    try {
      const row = await this.tables.getRow({
        databaseId: RESOURCE_IDS.database,
        tableId,
        rowId,
        ...(transactionId === undefined ? {} : { transactionId }),
      });
      return asRow(row);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listRows(
    tableId: string,
    query: RowQuery,
    transactionId?: string,
  ): Promise<RowRecord[]> {
    const queries: string[] = [];
    for (const [key, value] of Object.entries(query.equal ?? {}))
      queries.push(Query.equal(key, value));
    for (const [key, value] of Object.entries(query.greaterThan ?? {}))
      queries.push(Query.greaterThan(key, value));
    for (const [key, value] of Object.entries(query.lessThan ?? {}))
      queries.push(Query.lessThan(key, value));
    if (query.orderAsc) queries.push(Query.orderAsc(query.orderAsc));
    if (query.cursorAfter) queries.push(Query.cursorAfter(query.cursorAfter));
    queries.push(Query.limit(query.limit));
    const result = await this.tables.listRows({
      databaseId: RESOURCE_IDS.database,
      tableId,
      queries,
      total: false,
      ...(transactionId === undefined ? {} : { transactionId }),
    });
    return result.rows.map(asRow);
  }

  async createRow(
    tableId: string,
    rowId: string,
    data: Record<string, unknown>,
    permissions: string[],
    transactionId: string,
  ): Promise<void> {
    await this.tables.createRow({
      databaseId: RESOURCE_IDS.database,
      tableId,
      rowId,
      data,
      permissions,
      transactionId,
    });
  }

  async updateRow(
    tableId: string,
    rowId: string,
    data: Record<string, unknown>,
    permissions: string[] | undefined,
    transactionId: string,
  ): Promise<void> {
    await this.tables.updateRow({
      databaseId: RESOURCE_IDS.database,
      tableId,
      rowId,
      data,
      transactionId,
      ...(permissions === undefined ? {} : { permissions }),
    });
  }

  async deleteRow(
    tableId: string,
    rowId: string,
    transactionId?: string,
  ): Promise<void> {
    try {
      await this.tables.deleteRow({
        databaseId: RESOURCE_IDS.database,
        tableId,
        rowId,
        ...(transactionId === undefined ? {} : { transactionId }),
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export class NodeAppwriteAssetPort implements EncryptedAssetPort {
  private readonly storage: Storage;

  constructor(client: Client) {
    this.storage = new Storage(client);
  }

  async inspect(
    fileId: string,
  ): Promise<{ encryptedSize: number; encryptedHash: string }> {
    const metadata = await this.storage.getFile({
      bucketId: RESOURCE_IDS.assetBucket,
      fileId,
    });
    const download = await this.storage.getFileDownload({
      bucketId: RESOURCE_IDS.assetBucket,
      fileId,
    });
    const bytes = Buffer.from(download);
    if (bytes.byteLength !== metadata.sizeOriginal) {
      throw new ApiError(
        409,
        "conflict",
        "Uploaded encrypted bytes have inconsistent storage metadata.",
      );
    }
    return {
      encryptedSize: bytes.byteLength,
      encryptedHash: createHash("sha256").update(bytes).digest("base64url"),
    };
  }

  async sealToNotebook(fileId: string, notebookId: string): Promise<void> {
    await this.storage.updateFile({
      bucketId: RESOURCE_IDS.assetBucket,
      fileId,
      permissions: [`read("team:${notebookId}")`],
    });
  }

  private stagedFileId(assetId: string, chunkIndex: number): string {
    const digest = createHash("sha256")
      .update(`${assetId}\0${chunkIndex}`, "utf8")
      .digest("hex");
    return `chk_${digest.slice(0, 32)}`;
  }

  async stageChunk(
    assetId: string,
    chunkIndex: number,
    chunkBytes: Uint8Array,
    chunkHash: string,
  ): Promise<{ duplicate: boolean }> {
    const fileId = this.stagedFileId(assetId, chunkIndex);
    try {
      await this.storage.createFile({
        bucketId: RESOURCE_IDS.assetBucket,
        fileId,
        file: InputFile.fromBuffer(Buffer.from(chunkBytes), fileId),
        permissions: [],
      });
      return { duplicate: false };
    } catch (error) {
      if (!(error instanceof AppwriteException) || error.code !== 409)
        throw error;
      const bytes = Buffer.from(
        await this.storage.getFileDownload({
          bucketId: RESOURCE_IDS.assetBucket,
          fileId,
        }),
      );
      const existingHash = createHash("sha256")
        .update(bytes)
        .digest("base64url");
      if (existingHash !== chunkHash || !bytes.equals(Buffer.from(chunkBytes))) {
        throw new ApiError(
          409,
          "conflict",
          "Encrypted asset chunk identity is already bound to different bytes.",
        );
      }
      return { duplicate: true };
    }
  }

  async assembleStagedChunks(
    fileId: string,
    assetId: string,
    chunkCount: number,
  ): Promise<{ encryptedSize: number; encryptedHash: string }> {
    const chunks: Buffer[] = [];
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      chunks.push(
        Buffer.from(
          await this.storage.getFileDownload({
            bucketId: RESOURCE_IDS.assetBucket,
            fileId: this.stagedFileId(assetId, chunkIndex),
          }),
        ),
      );
    }
    const bytes = Buffer.concat(chunks);
    try {
      await this.storage.createFile({
        bucketId: RESOURCE_IDS.assetBucket,
        fileId,
        file: InputFile.fromBuffer(bytes, fileId),
        permissions: [],
      });
      return {
        encryptedSize: bytes.byteLength,
        encryptedHash: createHash("sha256").update(bytes).digest("base64url"),
      };
    } catch (error) {
      if (!(error instanceof AppwriteException) || error.code !== 409)
        throw error;
      return this.inspect(fileId);
    }
  }

  async removeStagedChunks(assetId: string, chunkCount: number): Promise<void> {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      await this.removeIfExists(this.stagedFileId(assetId, chunkIndex));
    }
  }

  async removeIfExists(fileId: string): Promise<void> {
    try {
      await this.storage.deleteFile({
        bucketId: RESOURCE_IDS.assetBucket,
        fileId,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

export class AppwriteIdentityVerifier implements IdentityVerifier {
  constructor(
    private readonly endpoint: string,
    private readonly projectId: string,
  ) {}

  async verify(jwt: string): Promise<string> {
    const client = new Client()
      .setEndpoint(this.endpoint)
      .setProject(this.projectId)
      .setJWT(jwt);
    try {
      const account = await new Account(client).get();
      return account.$id;
    } catch (error) {
      if (
        error instanceof AppwriteException &&
        (error.code === 401 || error.code === 403)
      ) {
        throw new ApiError(
          401,
          "unauthorized",
          "Authentication is missing or expired.",
        );
      }
      throw error;
    }
  }
}

export class AppwriteMembershipRepository implements MembershipRepository {
  private readonly teams: Teams;

  constructor(client: Client) {
    this.teams = new Teams(client);
  }

  async roleFor(
    notebookId: string,
    userId: string,
  ): Promise<NotebookRole | null> {
    try {
      const result = await this.teams.listMemberships({
        teamId: notebookId,
        queries: [Query.equal("userId", userId), Query.limit(2)],
      });
      const memberships = result.memberships.filter(
        (membership) => membership.userId === userId && membership.confirm,
      );
      if (memberships.length !== 1) return null;
      const assigned =
        memberships[0]?.roles.filter(
          (role): role is NotebookRole =>
            role === "owner" || role === "editor" || role === "viewer",
        ) ?? [];
      return assigned.length === 1 ? (assigned[0] ?? null) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async memberAccountIds(notebookId: string): Promise<string[]> {
    try {
      const result = await this.teams.listMemberships({
        teamId: notebookId,
        queries: [Query.limit(LIMITS.notebookMembers)],
      });
      if (result.total > LIMITS.notebookMembers) {
        throw new ApiError(
          503,
          "service_unavailable",
          "Notebook device directory exceeds its member bound.",
        );
      }
      const accountIds = result.memberships.flatMap((membership) => {
        const assigned = membership.roles.filter(
          (role): role is NotebookRole =>
            role === "owner" || role === "editor" || role === "viewer",
        );
        return membership.confirm && assigned.length === 1
          ? [membership.userId]
          : [];
      });
      return [...new Set(accountIds)].sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }
}
