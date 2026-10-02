export interface ServiceWorkerRegistrationPolicy {
  hasServiceWorker: boolean;
  hostname: string;
  isProduction: boolean;
  isSecureContext: boolean;
  isTauriRuntime: boolean;
}

export function isLocalDevelopmentHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const ipv4Parts = normalizedHostname.split('.');
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === '127' &&
    ipv4Parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    );

  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    normalizedHostname === '::1' ||
    normalizedHostname === '[::1]' ||
    isIpv4Loopback
  );
}

export function shouldRegisterServiceWorker(
  policy: ServiceWorkerRegistrationPolicy,
): boolean {
  return (
    policy.isProduction &&
    policy.hasServiceWorker &&
    !policy.isTauriRuntime &&
    (policy.isSecureContext || isLocalDevelopmentHost(policy.hostname))
  );
}

export async function registerCanvinkServiceWorker(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return undefined;
  }

  const policy: ServiceWorkerRegistrationPolicy = {
    hasServiceWorker: 'serviceWorker' in navigator,
    hostname: window.location.hostname,
    isProduction: import.meta.env.PROD,
    isSecureContext: window.isSecureContext,
    isTauriRuntime: typeof window.__TAURI_INTERNALS__ !== 'undefined',
  };

  if (!shouldRegisterServiceWorker(policy)) {
    return undefined;
  }

  const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
  const workerUrl = new URL('sw.js', baseUrl);

  try {
    return await navigator.serviceWorker.register(workerUrl, {
      scope: baseUrl.pathname,
      updateViaCache: 'none',
    });
  } catch (error) {
    console.warn('Canvink could not enable its offline app shell.', error);
    return undefined;
  }
}
