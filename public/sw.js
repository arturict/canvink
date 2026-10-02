// vite.config.ts stamps every build's id here. Browsers install a new worker
// only when its bytes change, and installing is what precaches every file of
// the build, lazy chunks included, for offline use. Build: __CANVINK_BUILD_ID__

const CACHE_PREFIX = 'canvink-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-v1`;
const STATIC_CACHE = `${CACHE_PREFIX}static-v1`;
const MAX_SHELL_ENTRIES = 12;
// A build emits about 70 files; the limit leaves room for the previous build's
// files, which a page that is still open may load.
const MAX_STATIC_ENTRIES = 192;
// vite.config.ts replaces this token with a JSON array of every file the build
// emitted under assets/ (scope-relative). All of them are content-hashed, so
// caching them at install is safe and a lazy chunk never has to be fetched
// while offline. Unstamped (dev, tests) the list is empty and only the pages'
// own reference graph is cached.
const PRECACHE_MANIFEST = '__CANVINK_PRECACHE__';

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

async function trimCache(cache, maximumEntries, keepHrefs = new Set()) {
  const keys = await cache.keys();
  const overflow = keys.length - maximumEntries;

  if (overflow > 0) {
    // Oldest first, but never the files the current build needs: a build that
    // changed little leaves most of its files older than a previous build's.
    const removable = keys.filter((key) => !keepHrefs.has(key.url));
    await Promise.all(removable.slice(0, overflow).map((key) => cache.delete(key)));
  }
}

function precachedAssetUrls() {
  if (!PRECACHE_MANIFEST.startsWith('[')) {
    return [];
  }
  return JSON.parse(PRECACHE_MANIFEST).map((path) => scopeUrl(path).href);
}

/**
 * Caches every file of the build, not only the ones the pages reference
 * directly. Unlike the graph walk below, a failure here rejects: a worker that
 * installed with a chunk missing would answer a later offline import with a
 * network error, so it stays uninstalled and the browser retries on the next
 * visit.
 */
async function precacheBuild() {
  const cache = await caches.open(STATIC_CACHE);
  const hrefs = precachedAssetUrls();

  await Promise.all(
    hrefs.map(async (href) => {
      if (await cache.match(href, { ignoreVary: true })) {
        return;
      }
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(href);
          if (response.ok && response.type === 'basic') {
            await cache.put(href, response);
            return;
          }
          lastError = new Error(`${response.status} for ${href}`);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }),
  );

  await trimCache(cache, MAX_STATIC_ENTRIES, new Set(hrefs));
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
      // The name carries the content hash: a file that is cached already is
      // this exact file, so a new build only downloads what it changed.
      let response = await cache.match(href, { ignoreVary: true });
      if (!response) {
        response = await fetch(new Request(href, { cache: 'reload' }));
        if (!response.ok || response.type !== 'basic') {
          continue;
        }

        await cache.put(href, response.clone());
      }

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

  await trimCache(cache, MAX_STATIC_ENTRIES, visited);
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

function isAppNavigation(url) {
  const scopePath = scopeUrl().pathname;
  const appPath = `${scopePath.endsWith('/') ? scopePath : `${scopePath}/`}app`;
  return url.pathname === appPath || url.pathname.startsWith(`${appPath}/`);
}

/**
 * The app shell opens from the cache at once and refreshes in the background:
 * a visit does not wait for the network (on a slow or half-dead connection
 * that wait is seconds long), and the next visit runs the build the refresh
 * found. Every chunk of the older shell stays cached, so it keeps working.
 */
async function staleWhileRevalidateAppNavigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request, { ignoreSearch: true });
  if (!cached) {
    return networkFirstNavigation(event.request);
  }

  event.waitUntil(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && response.type === 'basic') {
          await cache.put(event.request, response.clone());
          await trimCache(cache, MAX_SHELL_ENTRIES);
        }
      } catch {
        // Offline: the cached shell stays as it is.
      }
    })(),
  );
  return cached;
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
  // Takes over as soon as its precache is complete instead of waiting for
  // every open window to close: an installed app may stay open for days, and
  // this worker only ever serves files the old one cached under the same names.
  event.waitUntil(precacheBuild().then(warmAppShell).then(() => self.skipWaiting()));
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
    event.respondWith(
      isAppNavigation(url) ? staleWhileRevalidateAppNavigation(event) : networkFirstNavigation(request),
    );
    return;
  }

  if (!request.headers.has('range') && isVersionedStaticAsset(url)) {
    event.respondWith(cacheFirstVersionedAsset(request));
  }
});
