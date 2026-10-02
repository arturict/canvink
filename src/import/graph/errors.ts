export type OneNoteGraphErrorCode =
  | 'aborted'
  | 'http-error'
  | 'invalid-response'
  | 'limit-exceeded'
  | 'network-error'
  | 'timeout'
  | 'token-unavailable'
  | 'unsafe-url';

export interface OneNoteGraphErrorDetails {
  code: OneNoteGraphErrorCode;
  operation: string;
  retryable?: boolean;
  status?: number;
  requestId?: string;
}

/** An intentionally opaque error: it never contains tokens, URLs, or response bodies. */
export class OneNoteGraphAcquisitionError extends Error {
  readonly code: OneNoteGraphErrorCode;
  readonly operation: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;

  constructor(details: OneNoteGraphErrorDetails) {
    super(`Microsoft Graph OneNote acquisition failed during ${details.operation}.`);
    this.name = 'OneNoteGraphAcquisitionError';
    this.code = details.code;
    this.operation = details.operation;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

export function graphError(details: OneNoteGraphErrorDetails): OneNoteGraphAcquisitionError {
  return new OneNoteGraphAcquisitionError(details);
}
