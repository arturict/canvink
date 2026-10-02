export type SyncClientErrorCode =
  | 'disabled'
  | 'invalid-config'
  | 'authentication-required'
  | 'forbidden'
  | 'removed-member'
  | 'viewer-read-only'
  | 'offline'
  | 'aborted'
  | 'rate-limited'
  | 'service-unavailable'
  | 'protocol-error'
  | 'key-epoch-unavailable';

export class SyncClientError extends Error {
  constructor(
    public readonly code: SyncClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SyncClientError';
  }
}

export function toSyncClientError(error: unknown): SyncClientError {
  if (error instanceof SyncClientError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new SyncClientError('aborted', 'Sync was cancelled.', { cause: error });
  }
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? Number(error.code)
    : 0;
  if (code === 401) return new SyncClientError('authentication-required', 'Sign in to continue syncing.', { cause: error });
  if (code === 403) return new SyncClientError('forbidden', 'This account cannot access the notebook.', { cause: error });
  if (code === 429) return new SyncClientError('rate-limited', 'Sync is temporarily rate limited.', { cause: error });
  if (code >= 500 || error instanceof TypeError) {
    return new SyncClientError('service-unavailable', 'Sync is temporarily unavailable.', { cause: error });
  }
  return new SyncClientError('protocol-error', 'Sync received an invalid response.', { cause: error });
}
