import { useState, type FormEvent } from 'react';
import { isolateCanvasEvent } from './canvasIsolation';
import './mathCanvas.css';

export type RecognitionProviderStatus = 'unconfigured' | 'ready' | 'pending' | 'error';
export type RecognitionProviderId = 'compatible' | 'mathpix';

export interface RecognitionProviderView {
  id: RecognitionProviderId;
  label: string;
  status: RecognitionProviderStatus;
  endpoint?: string;
}

export interface CredentialPayload { bytes: Uint8Array; characterCount: number }

export interface ProviderSettingsLabels {
  settings: string; endpoint: string; credential: string; appId: string; appKey: string;
  networkScope: string; privateNetwork: string; publicNetwork: string; allowInsecurePrivateHttp: string;
  configure: string; deleteCredential: string; refresh: string;
  unconfigured: string; ready: string; pending: string; error: string; credentialTooLarge: string;
}

export interface ProviderSettingsProps {
  providers: readonly RecognitionProviderView[];
  labels: ProviderSettingsLabels;
  viewer?: boolean;
  onConfigureCompatible: (configuration: {
    endpoint: string;
    networkScope: 'private' | 'public';
    allowInsecurePrivateHttp: boolean;
    bearerToken: CredentialPayload;
  }) => void | Promise<void>;
  onConfigureMathpix: (configuration: {
    appId: CredentialPayload;
    appKey: CredentialPayload;
  }) => void | Promise<void>;
  onRefreshStatus: (providerId: RecognitionProviderId) => void | Promise<void>;
  onDeleteCredential: (providerId: RecognitionProviderId) => void | Promise<void>;
}

const MAX_CREDENTIAL_CHARACTERS = 4_096;
const MAX_CREDENTIAL_BYTES = 16_384;
const MAX_ENDPOINT_CHARACTERS = 2_048;

export function createCredentialPayload(credential: string): CredentialPayload {
  if (credential.length === 0 || credential.length > MAX_CREDENTIAL_CHARACTERS) {
    throw new RangeError('Credential character limit exceeded');
  }
  const bytes = new TextEncoder().encode(credential);
  if (bytes.byteLength > MAX_CREDENTIAL_BYTES) {
    bytes.fill(0);
    throw new RangeError('Credential byte limit exceeded');
  }
  return { bytes, characterCount: credential.length };
}

export function destroyCredentialPayload(payload: CredentialPayload): void {
  payload.bytes.fill(0);
  payload.characterCount = 0;
}

function ProviderActions({ provider, labels, viewer, refresh, remove }: {
  provider: RecognitionProviderView;
  labels: ProviderSettingsLabels;
  viewer: boolean;
  refresh: () => void;
  remove: () => void;
}) {
  return (
    <header>
      <h3 id={`provider-${provider.id}`}>{provider.label}</h3>
      <span role={provider.status === 'error' ? 'alert' : 'status'}>{labels[provider.status]}</span>
      <button type="button" disabled={viewer} onClick={refresh}>{labels.refresh}</button>
      <button type="button" disabled={viewer} onClick={remove}>{labels.deleteCredential}</button>
    </header>
  );
}

function CompatibleForm({ provider, labels, viewer, submit, refresh, remove }: {
  provider: RecognitionProviderView; labels: ProviderSettingsLabels; viewer: boolean;
  submit: ProviderSettingsProps['onConfigureCompatible']; refresh: () => void; remove: () => void;
}) {
  const [endpoint, setEndpoint] = useState(provider.endpoint ?? '');
  const [scope, setScope] = useState<'private' | 'public'>('private');
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState(false);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let bearerToken: CredentialPayload;
    try { bearerToken = createCredentialPayload(token); } catch { setError(true); return; }
    setToken(''); setError(false);
    try {
      await submit({ endpoint: endpoint.slice(0, MAX_ENDPOINT_CHARACTERS), networkScope: scope,
        allowInsecurePrivateHttp: scope === 'private' && allowInsecure, bearerToken });
    } finally { destroyCredentialPayload(bearerToken); }
  };
  return (
    <section className="provider-settings__provider" aria-labelledby={`provider-${provider.id}`}>
      <ProviderActions provider={provider} labels={labels} viewer={viewer} refresh={refresh} remove={remove} />
      <form onSubmit={(event) => { void onSubmit(event); }}>
        <label>{labels.endpoint}<input type="url" value={endpoint} maxLength={MAX_ENDPOINT_CHARACTERS}
          disabled={viewer} onChange={(event) => setEndpoint(event.target.value)} /></label>
        <label>{labels.networkScope}<select value={scope} disabled={viewer}
          onChange={(event) => setScope(event.target.value as 'private' | 'public')}>
          <option value="private">{labels.privateNetwork}</option><option value="public">{labels.publicNetwork}</option>
        </select></label>
        <label><input type="checkbox" checked={allowInsecure} disabled={viewer || scope !== 'private'}
          onChange={(event) => setAllowInsecure(event.target.checked)} />{labels.allowInsecurePrivateHttp}</label>
        <label>{labels.credential}<input type="password" value={token} maxLength={MAX_CREDENTIAL_CHARACTERS}
          autoComplete="off" spellCheck={false} disabled={viewer} aria-invalid={error}
          onChange={(event) => { setToken(event.target.value); setError(false); }} /></label>
        {error ? <span role="alert">{labels.credentialTooLarge}</span> : null}
        <button type="submit" disabled={viewer || !endpoint || !token}>{labels.configure}</button>
      </form>
    </section>
  );
}

function MathpixForm({ provider, labels, viewer, submit, refresh, remove }: {
  provider: RecognitionProviderView; labels: ProviderSettingsLabels; viewer: boolean;
  submit: ProviderSettingsProps['onConfigureMathpix']; refresh: () => void; remove: () => void;
}) {
  const [appId, setAppId] = useState('');
  const [appKey, setAppKey] = useState('');
  const [error, setError] = useState(false);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let idPayload: CredentialPayload;
    try { idPayload = createCredentialPayload(appId); } catch { setError(true); return; }
    let keyPayload: CredentialPayload;
    try { keyPayload = createCredentialPayload(appKey); }
    catch { destroyCredentialPayload(idPayload); setError(true); return; }
    setAppId(''); setAppKey(''); setError(false);
    try { await submit({ appId: idPayload, appKey: keyPayload }); }
    finally { destroyCredentialPayload(idPayload); destroyCredentialPayload(keyPayload); }
  };
  return (
    <section className="provider-settings__provider" aria-labelledby={`provider-${provider.id}`}>
      <ProviderActions provider={provider} labels={labels} viewer={viewer} refresh={refresh} remove={remove} />
      <form onSubmit={(event) => { void onSubmit(event); }}>
        <label>{labels.appId}<input type="password" value={appId} maxLength={MAX_CREDENTIAL_CHARACTERS}
          autoComplete="off" spellCheck={false} disabled={viewer} onChange={(event) => setAppId(event.target.value)} /></label>
        <label>{labels.appKey}<input type="password" value={appKey} maxLength={MAX_CREDENTIAL_CHARACTERS}
          autoComplete="off" spellCheck={false} disabled={viewer} aria-invalid={error}
          onChange={(event) => { setAppKey(event.target.value); setError(false); }} /></label>
        {error ? <span role="alert">{labels.credentialTooLarge}</span> : null}
        <button type="submit" disabled={viewer || !appId || !appKey}>{labels.configure}</button>
      </form>
    </section>
  );
}

export function ProviderSettings({ providers, labels, viewer = false, onConfigureCompatible,
  onConfigureMathpix, onRefreshStatus, onDeleteCredential }: ProviderSettingsProps) {
  return (
    <aside className="provider-settings" aria-label={labels.settings}
      onPointerDown={isolateCanvasEvent} onPointerMove={isolateCanvasEvent} onPointerUp={isolateCanvasEvent}
      onPointerCancel={isolateCanvasEvent} onKeyDown={isolateCanvasEvent} onWheel={isolateCanvasEvent}>
      {providers.map((provider) => provider.id === 'compatible' ? (
        <CompatibleForm key={provider.id} provider={provider} labels={labels} viewer={viewer}
          submit={onConfigureCompatible} refresh={() => { void onRefreshStatus(provider.id); }}
          remove={() => { void onDeleteCredential(provider.id); }} />
      ) : (
        <MathpixForm key={provider.id} provider={provider} labels={labels} viewer={viewer}
          submit={onConfigureMathpix} refresh={() => { void onRefreshStatus(provider.id); }}
          remove={() => { void onDeleteCredential(provider.id); }} />
      ))}
    </aside>
  );
}

export default ProviderSettings;
