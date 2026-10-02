import type {
  AccountInfo,
  AuthenticationResult,
  Configuration,
  EndSessionRequest,
  INavigationClient,
  IPublicClientApplication,
  RedirectRequest,
  SilentRequest,
} from '@azure/msal-browser';
import { describe, expect, it, vi } from 'vitest';
import {
  MICROSOFT_ONENOTE_READ_SCOPES,
  createMicrosoftOneNoteAuth,
  type TauriSystemBrowserCallbackBridge,
} from './auth';

const ACCOUNT = {
  homeAccountId: 'home-account',
  localAccountId: 'local-account',
  environment: 'login.microsoftonline.com',
  tenantId: 'tenant-id',
  username: 'student@example.test',
  name: 'Student',
  idTokenClaims: {},
} as AccountInfo;

function authResult(overrides: Partial<AuthenticationResult> = {}): AuthenticationResult {
  return {
    authority: 'https://login.microsoftonline.com/common',
    uniqueId: 'unique',
    tenantId: 'tenant-id',
    scopes: ['Notes.Read'],
    account: ACCOUNT,
    idToken: 'id-token',
    idTokenClaims: {},
    accessToken: 'access-token',
    fromCache: false,
    expiresOn: new Date('2026-08-03T16:00:00Z'),
    tokenType: 'Bearer',
    correlationId: 'correlation',
    ...overrides,
  } as AuthenticationResult;
}

class FakeMsalClient {
  readonly initialize = vi.fn(async () => undefined);
  readonly loginRequests: RedirectRequest[] = [];
  readonly silentRequests: SilentRequest[] = [];
  readonly clearCache = vi.fn(async () => undefined);
  readonly logoutRequests: EndSessionRequest[] = [];
  activeAccount: AccountInfo | null = null;
  navigation?: INavigationClient;
  redirectResult: AuthenticationResult | null = null;
  silentResult: AuthenticationResult = authResult();

  constructor(readonly configuration: Configuration) {
    this.navigation = configuration.system?.navigationClient;
  }

  async loginRedirect(request: RedirectRequest): Promise<void> {
    this.loginRequests.push(request);
    if (!this.navigation) return;
    const url = new URL(`${this.configuration.auth.authority}/oauth2/v2.0/authorize`);
    url.searchParams.set('client_id', this.configuration.auth.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', request.scopes.join(' '));
    url.searchParams.set('state', request.state ?? '');
    url.searchParams.set('nonce', request.nonce ?? '');
    url.searchParams.set('code_challenge', 'a'.repeat(43));
    url.searchParams.set('code_challenge_method', 'S256');
    await this.navigation.navigateExternal(url.href, { apiId: 0 as never, timeout: 1_000, noHistory: true });
  }

  async handleRedirectPromise(): Promise<AuthenticationResult | null> {
    return this.redirectResult;
  }

  async acquireTokenSilent(request: SilentRequest): Promise<AuthenticationResult> {
    this.silentRequests.push(request);
    return this.silentResult;
  }

  setActiveAccount(account: AccountInfo | null): void { this.activeAccount = account; }
  getActiveAccount(): AccountInfo | null { return this.activeAccount; }
  getAllAccounts(): AccountInfo[] { return this.activeAccount ? [this.activeAccount] : []; }

  async logoutRedirect(request?: EndSessionRequest): Promise<void> {
    this.logoutRequests.push(request ?? {});
  }
}

function factory(capture: { client?: FakeMsalClient; configuration?: Configuration }) {
  return (configuration: Configuration): IPublicClientApplication => {
    capture.configuration = configuration;
    capture.client = new FakeMsalClient(configuration);
    return capture.client as unknown as IPublicClientApplication;
  };
}

function randomBytes() {
  let seed = 0;
  return (length: number) => Uint8Array.from({ length }, () => (seed++ % 251) + 1);
}

function systemBridge(): TauriSystemBrowserCallbackBridge & {
  opened: string[];
  resolveCallback: (value: string) => void;
} {
  let resolveCallback: (value: string) => void = () => undefined;
  return {
    opened: [],
    openExternal: async function (url) { this.opened.push(url); },
    waitForCallback: (signal) => new Promise<string>((resolve, reject) => {
      resolveCallback = resolve;
      signal.addEventListener('abort', () => reject(new Error('private cancel detail')), { once: true });
    }),
    resolveCallback: (value) => resolveCallback(value),
  };
}

const BASE_OPTIONS = {
  clientId: '11111111-1111-4111-8111-111111111111',
  redirectUri: 'https://app.example.test/auth/callback',
  now: () => Date.parse('2026-08-03T14:00:00Z'),
};

describe('Microsoft OneNote delegated authorization', () => {
  it('requests only Notes.Read and sends state, nonce, and SDK-generated S256 PKCE through the system browser', async () => {
    const capture: { client?: FakeMsalClient; configuration?: Configuration } = {};
    const bridge = systemBridge();
    const auth = createMicrosoftOneNoteAuth({
      ...BASE_OPTIONS,
      redirectUri: 'canvink://auth/callback',
      systemBrowser: bridge,
      randomBytes: randomBytes(),
      clientFactory: factory(capture),
    });
    const pending = auth.authorize();
    await vi.waitFor(() => expect(bridge.opened).toHaveLength(1));
    const request = capture.client!.loginRequests[0];
    expect(request.scopes).toEqual([...MICROSOFT_ONENOTE_READ_SCOPES]);
    expect(request.scopes).not.toContain('Notes.ReadWrite');
    expect(request.state).toMatch(/^canvink-onenote\./);
    expect(request.nonce).toBeTruthy();
    expect(request.state).not.toBe(request.nonce);

    const authorizationUrl = new URL(bridge.opened[0]);
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).toHaveLength(43);
    capture.client!.redirectResult = authResult({ state: request.state });
    bridge.resolveCallback(`?code=fixture&state=${encodeURIComponent(request.state ?? '')}`);
    await expect(pending).resolves.toMatchObject({
      status: 'authorized',
      session: { accountId: 'home-account', username: 'student@example.test' },
    });
    expect(capture.configuration).toMatchObject({
      auth: { clientId: BASE_OPTIONS.clientId, verifySSO: false },
      cache: { cacheLocation: 'sessionStorage' },
      system: { allowPlatformBroker: false, allowRedirectInIframe: false, protocolMode: 'AAD' },
    });
    expect(JSON.stringify(capture.configuration)).not.toContain('clientSecret');
  });

  it('rejects a mismatched returned state even after the SDK callback succeeds', async () => {
    const capture: { client?: FakeMsalClient } = {};
    const bridge = systemBridge();
    const auth = createMicrosoftOneNoteAuth({
      ...BASE_OPTIONS,
      redirectUri: 'canvink://auth/callback',
      systemBrowser: bridge,
      randomBytes: randomBytes(),
      clientFactory: factory(capture),
    });
    const pending = auth.authorize();
    await vi.waitFor(() => expect(capture.client?.loginRequests).toHaveLength(1));
    capture.client!.redirectResult = authResult({ state: 'wrong-state' });
    bridge.resolveCallback('?code=fixture&state=wrong-state');
    await expect(pending).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('cancels a pending system-browser callback without leaking the cancellation reason', async () => {
    const capture: { client?: FakeMsalClient } = {};
    const bridge = systemBridge();
    const auth = createMicrosoftOneNoteAuth({
      ...BASE_OPTIONS,
      redirectUri: 'canvink://auth/callback',
      systemBrowser: bridge,
      clientFactory: factory(capture),
    });
    const pending = auth.authorize();
    await vi.waitFor(() => expect(bridge.opened).toHaveLength(1));
    auth.cancelPendingAuthorization();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await expect(pending).rejects.not.toHaveProperty('message', expect.stringContaining('private cancel detail'));
  });

  it('silently refreshes only Notes.Read and rejects expired results', async () => {
    const capture: { client?: FakeMsalClient } = {};
    const auth = createMicrosoftOneNoteAuth({ ...BASE_OPTIONS, clientFactory: factory(capture) });
    await auth.initialize();
    capture.client!.activeAccount = ACCOUNT;
    const signal = new AbortController().signal;

    await expect(auth.getAccessToken(signal)).resolves.toBe('access-token');
    expect(capture.client!.silentRequests[0].scopes).toEqual(['Notes.Read']);
    capture.client!.silentResult = authResult({ expiresOn: new Date('2026-08-03T14:00:10Z') });
    await expect(auth.getAccessToken(signal)).rejects.toMatchObject({ code: 'token-expired' });
    capture.client!.silentResult = authResult({ scopes: ['Notes.Read', 'Notes.ReadWrite'] });
    await expect(auth.getAccessToken(signal)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('requires an account for silent access and clears local cache before server logout', async () => {
    const capture: { client?: FakeMsalClient } = {};
    const auth = createMicrosoftOneNoteAuth({ ...BASE_OPTIONS, clientFactory: factory(capture) });
    const signal = new AbortController().signal;
    await expect(auth.getAccessToken(signal)).rejects.toMatchObject({ code: 'sign-in-required' });

    capture.client!.activeAccount = ACCOUNT;
    await auth.logout({ endServerSession: true });
    expect(capture.client!.clearCache).toHaveBeenCalledWith({ account: ACCOUNT });
    expect(capture.client!.activeAccount).toBeNull();
    expect(capture.client!.logoutRequests).toHaveLength(1);
    expect(auth.getSession()).toBeNull();
  });

  it('rejects insecure redirect and non-Microsoft authority configuration', () => {
    expect(() => createMicrosoftOneNoteAuth({
      ...BASE_OPTIONS,
      redirectUri: 'http://attacker.invalid/callback',
    })).toThrowError(expect.objectContaining({ code: 'configuration-invalid' }));
    expect(() => createMicrosoftOneNoteAuth({
      ...BASE_OPTIONS,
      authority: 'https://attacker.invalid/common',
    })).toThrowError(expect.objectContaining({ code: 'configuration-invalid' }));
  });
});
