export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "approval_expired"
  | "invalid_approval"
  | "invalid_signature"
  | "too_many_challenges"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media_type"
  | "service_unavailable"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string): never {
  throw new ApiError(400, "bad_request", message);
}

export function conflict(message: string): never {
  throw new ApiError(409, "conflict", message);
}
