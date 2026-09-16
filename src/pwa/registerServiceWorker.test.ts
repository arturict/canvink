import { describe, expect, it } from 'vitest';
import {
  isLocalDevelopmentHost,
  shouldRegisterServiceWorker,
  type ServiceWorkerRegistrationPolicy,
} from './registerServiceWorker';

const eligiblePolicy: ServiceWorkerRegistrationPolicy = {
  hasServiceWorker: true,
  hostname: 'notes.example.com',
  isProduction: true,
  isSecureContext: true,
  isTauriRuntime: false,
};

describe('service worker registration policy', () => {
  it('registers the production browser build on a secure origin', () => {
    expect(shouldRegisterServiceWorker(eligiblePolicy)).toBe(true);
  });

  it('allows production previews on local loopback hosts', () => {
    for (const hostname of ['localhost', 'canvink.localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLocalDevelopmentHost(hostname)).toBe(true);
      expect(
        shouldRegisterServiceWorker({
          ...eligiblePolicy,
          hostname,
          isSecureContext: false,
        }),
      ).toBe(true);
    }
  });

  it('does not register in development, Tauri, unsupported browsers, or insecure remote origins', () => {
    expect(
      shouldRegisterServiceWorker({ ...eligiblePolicy, isProduction: false }),
    ).toBe(false);
    expect(
      shouldRegisterServiceWorker({ ...eligiblePolicy, isTauriRuntime: true }),
    ).toBe(false);
    expect(
      shouldRegisterServiceWorker({ ...eligiblePolicy, hasServiceWorker: false }),
    ).toBe(false);
    expect(
      shouldRegisterServiceWorker({
        ...eligiblePolicy,
        hostname: 'notes.example.com',
        isSecureContext: false,
      }),
    ).toBe(false);
  });

  it('rejects hostnames that merely contain a loopback-looking value', () => {
    expect(isLocalDevelopmentHost('localhost.example.com')).toBe(false);
    expect(isLocalDevelopmentHost('127.0.0.1.example.com')).toBe(false);
    expect(isLocalDevelopmentHost('127.0.0.999')).toBe(false);
    expect(isLocalDevelopmentHost('128.0.0.1')).toBe(false);
  });
});
