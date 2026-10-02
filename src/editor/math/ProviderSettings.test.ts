import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createCredentialPayload,
  destroyCredentialPayload,
  ProviderSettings,
} from './ProviderSettings';

describe('ProviderSettings credentials', () => {
  it('hands off only a byte payload and erases it after use', () => {
    const payload = createCredentialPayload('tøkén');
    expect(payload).toEqual({ bytes: new TextEncoder().encode('tøkén'), characterCount: 5 });
    expect(Object.keys(payload).sort()).toEqual(['bytes', 'characterCount']);
    destroyCredentialPayload(payload);
    expect([...payload.bytes]).toEqual(new Array(payload.bytes.length).fill(0));
    expect(payload.characterCount).toBe(0);
  });

  it('enforces bounded credential input and renders no secret storage field', () => {
    expect(() => createCredentialPayload('')).toThrow();
    expect(() => createCredentialPayload('x'.repeat(4_097))).toThrow();
    const markup = renderToStaticMarkup(createElement(ProviderSettings, {
      providers: [{ id: 'mathpix', label: 'Mathpix', status: 'unconfigured' }],
      labels: {
        settings: 'Provider', endpoint: 'Endpunkt', credential: 'Token', appId: 'App-ID', appKey: 'App-Key',
        networkScope: 'Netz', privateNetwork: 'Privat', publicNetwork: 'Öffentlich',
        allowInsecurePrivateHttp: 'Privates HTTP erlauben', configure: 'Konfigurieren', refresh: 'Aktualisieren',
        deleteCredential: 'Token löschen', unconfigured: 'Nicht konfiguriert', ready: 'Bereit',
        pending: 'Ausstehend', error: 'Fehler', credentialTooLarge: 'Zu gross',
      },
      viewer: true,
      onConfigureCompatible: () => undefined,
      onConfigureMathpix: () => undefined,
      onRefreshStatus: () => undefined,
      onDeleteCredential: () => undefined,
    }));
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('localStorage');
  });
});
