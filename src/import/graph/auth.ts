import {
  BrowserCacheLocation,
  NavigationClient,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type EndSessionRequest,
  type HandleRedirectPromiseOptions,
  type IPublicClientApplication,
  type RedirectRequest,
  type SilentRequest,
} from '@azure/msal-browser';

export const MICROSOFT_ONENOTE_READ_SCOPES = Object.freeze(['Notes.Read'] as const);

export type MicrosoftOneNoteAuthErrorCode =
  | 'cancelled'
  | 'configuration-invalid'
  | 'interaction-in-progress'
  | 'invalid-response'
  | 'sign-in-required'
  | 'token-expired'
  | 'unexpected';

export class MicrosoftOneNoteAuthError extends Error {
  constructor(public readonly code: MicrosoftOneNoteAuthErrorCode) {
    super(`Microsoft OneNote authorization failed (${code}).`);
    this.name = 'MicrosoftOneNoteAuthError';
  }
}

export interface TauriSystemBrowserCallbackBridge {
  openExternal(url: string, signal: AbortSignal): Promise<void>;
  /** Returns the query/hash response expected by MSAL's handleRedirectPromise. */
  waitForCallback(signal: AbortSignal): Promise<string>;
}

export interface MicrosoftOneNoteAuthSession {
  accountId: string;
  username?: string;
  tenantId?: string;
  expiresAt: string;
}

export type MicrosoftOneNoteAuthorizationResult =
  | { status: 'redirect-started' }
  | { status: 'authorized'; session: MicrosoftOneNoteAuthSession };

export interface MicrosoftOneNoteAuthClient {
  initialize(): Promise<void>;
  authorize(signal?: AbortSignal): Promise<MicrosoftOneNoteAuthorizationResult>;
  completeRedirect(signal?: AbortSignal, callbackResponse?: string): Promise<MicrosoftOneNoteAuthSession | null>;
  getAccessToken(signal: AbortSignal): Promise<string>;
  logout(options?: { signal?: AbortSignal; endServerSession?: boolean }): Promise<void>;
  cancelPendingAuthorization(): void;
  getSession(): MicrosoftOneNoteAuthSession | null;
}

export interface MicrosoftOneNoteAuthOptions {
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  authority?: string;
  systemBrowser?: TauriSystemBrowserCallbackBridge;
  clientFactory?: (configuration: Configuration) => IPublicClientApplication;
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
}

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com/common';
const TOKEN_EXPIRY_SKEW_MS = 30_000;

function authError(code: MicrosoftOneNoteAuthErrorCode): MicrosoftOneNoteAuthError {
  return new MicrosoftOneNoteAuthError(code);
}

function validAuthority(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://login.microsoftonline.com'
      || url.username
      || url.password
      || url.search
      || url.hash
      || !/^\/(?:common|organizations|consumers|[0-9a-f-]{36})\/?$/i.test(url.pathname)
    ) throw authError('configuration-invalid');
    return url.href.replace(/\/$/, '');
  } catch (error) {
    if (error instanceof MicrosoftOneNoteAuthError) throw error;
    throw authError('configuration-invalid');
  }
}

function validRedirect(value: string, systemBrowser: boolean): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const customScheme = systemBrowser && /^[a-z][a-z0-9+.-]+:$/.test(url.protocol) && !['http:', 'https:'].includes(url.protocol);
    if ((!loopback && url.protocol !== 'https:' && !customScheme) || url.username || url.password || url.hash) {
      throw authError('configuration-invalid');
    }
    return url.href;
  } catch (error) {
    if (error instanceof MicrosoftOneNoteAuthError) throw error;
    throw authError('configuration-invalid');
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw authError('configuration-invalid');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function validateAuthorizationUrl(value: string): void {
  try {
    const url = new URL(value);
    const scopes = new Set((url.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean).map((scope) => scope.toLowerCase()));
    const forbidden = [...scopes].some((scope) => scope === 'notes.readwrite' || scope === 'notes.readwrite.all');
    if (
      url.origin !== 'https://login.microsoftonline.com'
      || !/\/oauth2\/v2\.0\/authorize$/i.test(url.pathname)
      || url.searchParams.get('response_type') !== 'code'
      || url.searchParams.get('code_challenge_method') !== 'S256'
      || (url.searchParams.get('code_challenge')?.length ?? 0) < 43
      || !url.searchParams.get('state')
      || !url.searchParams.get('nonce')
      || !scopes.has('notes.read')
      || forbidden
    ) throw authError('invalid-response');
  } catch (error) {
    if (error instanceof MicrosoftOneNoteAuthError) throw error;
    throw authError('invalid-response');
  }
}

function validateLogoutUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://login.microsoftonline.com' || !/\/oauth2\/v2\.0\/logout$/i.test(url.pathname)) {
      throw authError('invalid-response');
    }
  } catch (error) {
    if (error instanceof MicrosoftOneNoteAuthError) throw error;
    throw authError('invalid-response');
  }
}

class SystemBrowserNavigationClient extends NavigationClient {
  constructor(
    private readonly bridge: TauriSystemBrowserCallbackBridge,
    private readonly signal: () => AbortSignal,
  ) {
    super();
  }

  override async navigateExternal(url: string): Promise<boolean> {
    if (url.includes('/authorize')) validateAuthorizationUrl(url);
    else validateLogoutUrl(url);
    await this.bridge.openExternal(url, this.signal());
    return false;
  }

  override async navigateInternal(): Promise<boolean> {
    return false;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(authError('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(authError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        reject(authError('unexpected'));
      },
    );
  });
}

function linkedController(external?: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  if (external?.aborted) controller.abort();
  return { controller, cleanup: () => external?.removeEventListener('abort', onAbort) };
}

function validAuthResult(
  result: AuthenticationResult,
  now: number,
  expectedState?: string,
): MicrosoftOneNoteAuthSession {
  const granted = new Set(result.scopes.map((scope) => scope.toLowerCase()));
  const forbidden = [...granted].some((scope) => scope === 'notes.readwrite' || scope === 'notes.readwrite.all');
  if (
    !result.accessToken
    || !granted.has('notes.read')
    || forbidden
    || !result.account?.homeAccountId
    || !(result.expiresOn instanceof Date)
  ) throw authError('invalid-response');
  if (expectedState && result.state !== expectedState) throw authError('invalid-response');
  if (result.expiresOn.getTime() <= now + TOKEN_EXPIRY_SKEW_MS) throw authError('token-expired');
  return {
    accountId: result.account.homeAccountId,
    ...(result.account.username ? { username: result.account.username } : {}),
    ...(result.account.tenantId ? { tenantId: result.account.tenantId } : {}),
    expiresAt: result.expiresOn.toISOString(),
  };
}

export function createMicrosoftOneNoteAuth(
  options: MicrosoftOneNoteAuthOptions,
): MicrosoftOneNoteAuthClient {
  if (!CLIENT_ID_PATTERN.test(options.clientId)) throw authError('configuration-invalid');
  const authority = validAuthority(options.authority ?? DEFAULT_AUTHORITY);
  const redirectUri = validRedirect(options.redirectUri, Boolean(options.systemBrowser));
  const postLogoutRedirectUri = options.postLogoutRedirectUri
    ? validRedirect(options.postLogoutRedirectUri, Boolean(options.systemBrowser))
    : redirectUri;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const now = options.now ?? Date.now;
  let activeSignal = new AbortController().signal;
  const configuration: Configuration = {
    auth: {
      clientId: options.clientId,
      authority,
      redirectUri,
      postLogoutRedirectUri,
      verifySSO: false,
    },
    cache: {
      cacheLocation: BrowserCacheLocation.SessionStorage,
    },
    system: {
      allowPlatformBroker: false,
      allowRedirectInIframe: false,
      protocolMode: 'AAD',
      serverTelemetryEnabled: false,
    },
  };
  if (options.systemBrowser) {
    configuration.system!.navigationClient = new SystemBrowserNavigationClient(
      options.systemBrowser,
      () => activeSignal,
    );
  }
  const client = options.clientFactory?.(configuration) ?? new PublicClientApplication(configuration);
  let initialized: Promise<void> | undefined;
  let pending: AbortController | undefined;
  let pendingState: string | undefined;
  let session: MicrosoftOneNoteAuthSession | null = null;

  const initialize = (): Promise<void> => {
    initialized ??= client.initialize().catch(() => {
      initialized = undefined;
      throw authError('unexpected');
    });
    return initialized;
  };

  const beginInteractive = (external?: AbortSignal) => {
    if (pending) throw authError('interaction-in-progress');
    const linked = linkedController(external);
    pending = linked.controller;
    activeSignal = linked.controller.signal;
    return {
      signal: linked.controller.signal,
      finish: () => {
        linked.cleanup();
        if (pending === linked.controller) pending = undefined;
      },
    };
  };

  const accept = (result: AuthenticationResult, expectedState?: string): MicrosoftOneNoteAuthSession => {
    const accepted = validAuthResult(result, now(), expectedState);
    client.setActiveAccount(result.account);
    session = accepted;
    return accepted;
  };

  const completeRedirect = async (
    signal?: AbortSignal,
    callbackResponse?: string,
  ): Promise<MicrosoftOneNoteAuthSession | null> => {
    await initialize();
    const linked = linkedController(signal);
    try {
      const handleOptions: HandleRedirectPromiseOptions = {
        navigateToLoginRequestUrl: false,
        ...(callbackResponse ? { hash: callbackResponse } : {}),
      };
      const result = await abortable(client.handleRedirectPromise(handleOptions), linked.controller.signal);
      if (!result) return null;
      const accepted = accept(result, pendingState);
      pendingState = undefined;
      return accepted;
    } finally {
      linked.cleanup();
    }
  };

  const authorize = async (signal?: AbortSignal): Promise<MicrosoftOneNoteAuthorizationResult> => {
    await initialize();
    const operation = beginInteractive(signal);
    const state = `canvink-onenote.${base64Url(randomBytes(24))}`;
    const nonce = base64Url(randomBytes(32));
    pendingState = state;
    const request: RedirectRequest = {
      scopes: [...MICROSOFT_ONENOTE_READ_SCOPES],
      redirectUri,
      prompt: 'select_account',
      state,
      nonce,
    };
    try {
      if (options.systemBrowser) {
        const callback = options.systemBrowser.waitForCallback(operation.signal);
        await abortable(client.loginRedirect(request), operation.signal);
        const response = await abortable(callback, operation.signal);
        const result = await abortable(client.handleRedirectPromise({
          hash: response,
          navigateToLoginRequestUrl: false,
        }), operation.signal);
        if (!result) throw authError('invalid-response');
        const authorized = accept(result, state);
        pendingState = undefined;
        return { status: 'authorized', session: authorized };
      }
      await abortable(client.loginRedirect(request), operation.signal);
      return { status: 'redirect-started' };
    } catch (error) {
      if (error instanceof MicrosoftOneNoteAuthError) throw error;
      throw authError(operation.signal.aborted ? 'cancelled' : 'unexpected');
    } finally {
      operation.finish();
    }
  };

  const getAccessToken = async (signal: AbortSignal): Promise<string> => {
    await initialize();
    if (signal.aborted) throw authError('cancelled');
    const account: AccountInfo | null = client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
    if (!account) throw authError('sign-in-required');
    const request: SilentRequest = {
      account,
      scopes: [...MICROSOFT_ONENOTE_READ_SCOPES],
      redirectUri,
    };
    let result: AuthenticationResult;
    try {
      result = await abortable(client.acquireTokenSilent(request), signal);
    } catch (error) {
      if (error instanceof MicrosoftOneNoteAuthError && error.code === 'cancelled') throw error;
      throw authError('sign-in-required');
    }
    session = validAuthResult(result, now());
    return result.accessToken;
  };

  const logout = async (logoutOptions: { signal?: AbortSignal; endServerSession?: boolean } = {}): Promise<void> => {
    pending?.abort();
    pending = undefined;
    pendingState = undefined;
    await initialize();
    const linked = linkedController(logoutOptions.signal);
    activeSignal = linked.controller.signal;
    const account = client.getActiveAccount();
    try {
      await abortable(client.clearCache(account ? { account } : undefined), linked.controller.signal);
      client.setActiveAccount(null);
      session = null;
      if (logoutOptions.endServerSession ?? true) {
        const request: EndSessionRequest = { account, postLogoutRedirectUri };
        await abortable(client.logoutRedirect(request), linked.controller.signal);
      }
    } finally {
      linked.cleanup();
    }
  };

  return {
    initialize,
    authorize,
    completeRedirect,
    getAccessToken,
    logout,
    cancelPendingAuthorization: () => pending?.abort(),
    getSession: () => session ? structuredClone(session) : null,
  };
}
