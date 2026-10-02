import { Buffer } from "node:buffer";
import { AppwriteException, Client } from "node-appwrite";
import { AppwriteSyncRepository } from "./appwriteRepository.js";
import {
  LIMITS,
  type AuthenticatedUser,
  type IdentityVerifier,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import {
  AppwriteIdentityVerifier,
  AppwriteMembershipRepository,
  NodeAppwriteAssetPort,
  NodeAppwriteDataPort,
} from "./sdkPorts.js";
import { SyncService } from "./service.js";
import {
  parseBeginAssetUpload,
  parseActivateDevice,
  parseActivateDeviceWithRecovery,
  parseCompleteAssetUpload,
  parseCreateDeviceApprovalChallenge,
  parseHeadsAcknowledgement,
  parseKeyEnvelope,
  parseListKeyEnvelopes,
  parseListChangesAfter,
  parseListMyDevices,
  parseListNotebookDevices,
  parsePendingChange,
  parseRegisterDevice,
  parseRevokeDevice,
  parseUploadAssetChunk,
} from "./validation.js";

interface FunctionRequest {
  method: string;
  path: string;
  bodyText: string;
  headers: Record<string, string | undefined>;
}

interface FunctionResponse {
  json(
    body: unknown,
    status?: number,
    headers?: Record<string, string>,
  ): unknown;
}

interface FunctionContext {
  req: FunctionRequest;
  res: FunctionResponse;
  log(message: string): void;
  error(message: string): void;
}

interface HandlerDependencies {
  identity: IdentityVerifier;
  service: SyncService;
  allowedOrigins: ReadonlySet<string>;
}

const ROUTES = new Set([
  "/registerDevice",
  "/listMyDevices",
  "/listNotebookDevices",
  "/revokeDevice",
  "/createDeviceApprovalChallenge",
  "/activateDevice",
  "/activateDeviceWithRecovery",
  "/listKeyEnvelopes",
  "/appendChange",
  "/listChangesAfter",
  "/ackHeads",
  "/putKeyEnvelope",
  "/beginAssetUpload",
  "/uploadAssetChunk",
  "/completeAssetUpload",
]);

function normalizedPath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function corsHeaders(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin !== undefined && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "content-type, x-appwrite-user-jwt";
    headers["Access-Control-Max-Age"] = "600";
    headers.Vary = "Origin";
  }
  return headers;
}

function parseBody(req: FunctionRequest): unknown {
  const contentType = req.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
  if (Buffer.byteLength(req.bodyText, "utf8") > LIMITS.requestBytes) {
    throw new ApiError(
      413,
      "payload_too_large",
      "Request body exceeds the encrypted sync limit.",
    );
  }
  try {
    return JSON.parse(req.bodyText) as unknown;
  } catch {
    throw new ApiError(400, "bad_request", "Request body must be valid JSON.");
  }
}

async function authenticatedUser(
  req: FunctionRequest,
  identity: IdentityVerifier,
): Promise<AuthenticatedUser> {
  const userId = req.headers["x-appwrite-user-id"];
  const jwt = req.headers["x-appwrite-user-jwt"];
  if (!userId || !jwt)
    throw new ApiError(
      401,
      "unauthorized",
      "An authenticated Appwrite session is required.",
    );
  const verifiedUserId = await identity.verify(jwt);
  if (verifiedUserId !== userId)
    throw new ApiError(
      401,
      "unauthorized",
      "Authenticated identity headers do not match.",
    );
  return { userId, jwt };
}

function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AppwriteException) {
    if (error.code === 409)
      return new ApiError(
        409,
        "conflict",
        "The operation conflicted with concurrent state.",
      );
    if (error.code === 429)
      return new ApiError(
        503,
        "service_unavailable",
        "The sync service is temporarily busy.",
      );
  }
  return new ApiError(
    500,
    "internal_error",
    "The sync operation failed safely.",
  );
}

export function createHandler(dependencies: HandlerDependencies) {
  return async (context: FunctionContext): Promise<unknown> => {
    const { req, res } = context;
    const path = normalizedPath(req.path);
    const origin = req.headers.origin;
    const headers = corsHeaders(origin, dependencies.allowedOrigins);
    try {
      if (!ROUTES.has(path))
        throw new ApiError(404, "not_found", "Sync route was not found.");
      if (origin !== undefined && !dependencies.allowedOrigins.has(origin)) {
        throw new ApiError(
          403,
          "forbidden",
          "This browser origin is not allowed.",
        );
      }
      if (req.method === "OPTIONS") return res.json({}, 204, headers);
      if (req.method !== "POST")
        throw new ApiError(405, "method_not_allowed", "Only POST is allowed.");

      const user = await authenticatedUser(req, dependencies.identity);
      const body = parseBody(req);
      let result: unknown;
      switch (path) {
        case "/registerDevice":
          result = await dependencies.service.registerDevice(
            user,
            parseRegisterDevice(body),
          );
          break;
        case "/listMyDevices":
          result = await dependencies.service.listMyDevices(
            user,
            parseListMyDevices(body),
          );
          break;
        case "/listNotebookDevices":
          result = await dependencies.service.listNotebookDevices(
            user,
            parseListNotebookDevices(body),
          );
          break;
        case "/revokeDevice":
          result = await dependencies.service.revokeDevice(
            user,
            parseRevokeDevice(body),
          );
          break;
        case "/createDeviceApprovalChallenge":
          result = await dependencies.service.createDeviceApprovalChallenge(
            user,
            parseCreateDeviceApprovalChallenge(body),
          );
          break;
        case "/activateDevice":
          result = await dependencies.service.activateDevice(
            user,
            parseActivateDevice(body),
          );
          break;
        case "/activateDeviceWithRecovery":
          result = await dependencies.service.activateDeviceWithRecovery(
            user,
            parseActivateDeviceWithRecovery(body),
          );
          break;
        case "/listKeyEnvelopes":
          result = await dependencies.service.listKeyEnvelopes(
            user,
            parseListKeyEnvelopes(body),
          );
          break;
        case "/appendChange":
          result = await dependencies.service.appendChange(
            user,
            parsePendingChange(body),
          );
          break;
        case "/listChangesAfter": {
          const request = parseListChangesAfter(body);
          result = await dependencies.service.listChangesAfter(
            user,
            request.notebookId,
            request.afterSequence,
            request.limit,
          );
          break;
        }
        case "/ackHeads":
          result = await dependencies.service.acknowledgeHeads(
            user,
            parseHeadsAcknowledgement(body),
          );
          break;
        case "/putKeyEnvelope":
          result = await dependencies.service.putKeyEnvelope(
            user,
            parseKeyEnvelope(body),
          );
          break;
        case "/beginAssetUpload":
          result = await dependencies.service.beginAssetUpload(
            user,
            parseBeginAssetUpload(body),
          );
          break;
        case "/uploadAssetChunk":
          result = await dependencies.service.uploadAssetChunk(
            user,
            parseUploadAssetChunk(body),
          );
          break;
        case "/completeAssetUpload":
          result = await dependencies.service.completeAssetUpload(
            user,
            parseCompleteAssetUpload(body),
          );
          break;
        default:
          throw new ApiError(404, "not_found", "Sync route was not found.");
      }
      context.log(`sync_operation route=${path} status=success`);
      return res.json(result, 200, headers);
    } catch (error) {
      const safe = publicError(error);
      context.error(
        `sync_operation route=${ROUTES.has(path) ? path : "unknown"} status=${safe.status} code=${safe.code}`,
      );
      return res.json(
        { error: { code: safe.code, message: safe.message } },
        safe.status,
        headers,
      );
    }
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new ApiError(
      503,
      "service_unavailable",
      `Function environment ${name} is unavailable.`,
    );
  return value;
}

function productionDependencies(req: FunctionRequest): HandlerDependencies {
  const endpoint = requiredEnvironment("APPWRITE_FUNCTION_API_ENDPOINT");
  const projectId = requiredEnvironment("APPWRITE_FUNCTION_PROJECT_ID");
  const dynamicKey = req.headers["x-appwrite-key"];
  if (!dynamicKey)
    throw new ApiError(
      503,
      "service_unavailable",
      "Function execution credentials are unavailable.",
    );
  const adminClient = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(dynamicKey);
  const data = new NodeAppwriteDataPort(adminClient);
  const assets = new NodeAppwriteAssetPort(adminClient);
  const repository = new AppwriteSyncRepository(data, assets);
  const memberships = new AppwriteMembershipRepository(adminClient);
  const service = new SyncService(memberships, repository);
  const allowedOrigins = new Set(
    (process.env.CANVINK_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
  return {
    identity: new AppwriteIdentityVerifier(endpoint, projectId),
    service,
    allowedOrigins,
  };
}

export default async function main(context: FunctionContext): Promise<unknown> {
  try {
    return await createHandler(productionDependencies(context.req))(context);
  } catch (error) {
    const safe = publicError(error);
    context.error(
      `sync_initialization status=${safe.status} code=${safe.code}`,
    );
    return context.res.json(
      { error: { code: safe.code, message: safe.message } },
      safe.status,
      { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    );
  }
}
