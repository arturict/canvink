const CACHE_PREFIX = 'canvink-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-v1`;
const STATIC_CACHE = `${CACHE_PREFIX}static-v1`;
const MAX_SHELL_ENTRIES = 12;
const MAX_STATIC_ENTRIES = 96;
const VERSIONED_ASSET_PATTERN = /-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/;
const ASSET_REFERENCE_PATTERN = /["'`(=]((?:\.\.\/|\.\/|\/)[^"'`()\s]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+(?:\?[^"'`()\s]*)?)/g;

function scopeUrl(relativePath = '') {
  return new URL(relativePath, self.registration.scope);
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isVersionedStaticAsset(url) {
  const scopePath = scopeUrl().pathname;
  const assetPath = `${scopePath.endsWith('/') ? scopePath : `${scopePath}/`}assets/`;

  return (
    isSameOrigin(url) &&
    url.pathname.startsWith(assetPath) &&
    VERSIONED_ASSET_PATTERN.test(url.pathname)
  );
}

function extractVersionedAssetUrls(source, sourceUrl) {
  const urls = new Set();

  for (const match of source.matchAll(ASSET_REFERENCE_PATTERN)) {
    try {
      const url = new URL(match[1], sourceUrl);
      if (isVersionedStaticAsset(url)) {
        urls.add(url.href);
      }
    } catch {
      // Ignore malformed references. Only resolved same-origin assets are cached.
    }
  }

  return [...urls];
}

async function trimCache(cache, maximumEntries) {
  const keys = await cache.keys();
  const overflow = keys.length - maximumEntries;

  if (overflow > 0) {
    await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
  }
}

async function cacheVersionedAssetGraph(entryUrls) {
  const cache = await caches.open(STATIC_CACHE);
  const queued = [...entryUrls];
  const visited = new Set();

  while (queued.length > 0 && visited.size < MAX_STATIC_ENTRIES) {
    const href = queued.shift();
    if (!href || visited.has(href)) {
      continue;
    }

    const url = new URL(href);
    if (!isVersionedStaticAsset(url)) {
      continue;
    }

    visited.add(href);

    try {
      const response = await fetch(new Request(href, { cache: 'reload' }));
      if (!response.ok || response.type !== 'basic') {
        continue;
      }

      await cache.put(href, response.clone());

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('javascript') || contentType.includes('text/css')) {
        const nestedUrls = extractVersionedAssetUrls(await response.text(), href);
        for (const nestedUrl of nestedUrls) {
          if (!visited.has(nestedUrl)) {
            queued.push(nestedUrl);
          }
        }
      }
    } catch {
      // A partial warm-up must not prevent the worker from installing.
    }
  }

  await trimCache(cache, MAX_STATIC_ENTRIES);
}

async function warmAppShell() {
  const cache = await caches.open(SHELL_CACHE);
  const shellUrls = [scopeUrl(), scopeUrl('app')];
  const assetUrls = new Set();

  await Promise.allSettled(
    shellUrls.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok || response.type !== 'basic') {
        return;
      }

      await cache.put(url, response.clone());
      const html = await response.text();
      for (const assetUrl of extractVersionedAssetUrls(html, url)) {
        assetUrls.add(assetUrl);
      }
    }),
  );

  await trimCache(cache, MAX_SHELL_ENTRIES);
  await cacheVersionedAssetGraph(assetUrls);
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
      await trimCache(cache, MAX_SHELL_ENTRIES);
    }
    return response;
  } catch {
    const exactMatch = await cache.match(request, { ignoreSearch: true });
    if (exactMatch) {
      return exactMatch;
    }

    const requestUrl = new URL(request.url);
    const scopePath = scopeUrl().pathname;
    const appPath = `${scopePath.endsWith('/') ? scopePath : `${scopePath}/`}app`;
    const fallbackUrl = requestUrl.pathname === appPath || requestUrl.pathname.startsWith(`${appPath}/`)
      ? scopeUrl('app')
      : scopeUrl();

    const fallbackResponse = await cache.match(fallbackUrl);
    return fallbackResponse ?? Response.error();
  }
}

async function cacheFirstVersionedAsset(request) {
  const cache = await caches.open(STATIC_CACHE);
  // Version hashes make these same-origin URLs immutable. Ignore response
  // `Vary: Origin` differences between install-time warm-up and module loads.
  const cachedResponse = await cache.match(request, { ignoreVary: true });
  if (cachedResponse) {
    return cachedResponse;
  }

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    await trimCache(cache, MAX_STATIC_ENTRIES);
  }

  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(warmAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (cacheNames) => {
      await Promise.all(
        cacheNames
          .filter(
            (cacheName) =>
              cacheName.startsWith(CACHE_PREFIX) &&
              cacheName !== SHELL_CACHE &&
              cacheName !== STATIC_CACHE,
          )
          .map((cacheName) => caches.delete(cacheName)),
      );
      await self.clients.claim();
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || !isSameOrigin(url)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (!request.headers.has('range') && isVersionedStaticAsset(url)) {
    event.respondWith(cacheFirstVersionedAsset(request));
  }
});
