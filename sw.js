const CACHE_NAME = 'korea-finance-v7-mobile8';
const API_CACHE_NAME = 'korea-finance-api-v5';

const ASSETS = [
  'index.html',
  'style.css',
  'script.js',
  'manifest.json',
  'gold.html',
  'gold.css',
  'gold.js',
  'pwa-persistence.js',
  'auth.js',
  'supabase-config.js'
];

const API_HOSTS = new Set([
  'xaus.com',
  'api.gold-api.com',
  'api.frankfurter.app',
  'api.chnwt.dev',
  'script.google.com',
  'api.goldprice.dev'
]);

function isGet(request) { return request.method === 'GET'; }

function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    if (!API_HOSTS.has(url.hostname)) return false;
    return (
      url.hostname === 'xaus.com' && url.pathname.startsWith('/api/v1/')
    ) || (
      url.hostname === 'api.gold-api.com' && url.pathname.startsWith('/price/')
    ) || (
      url.hostname === 'api.frankfurter.app' && url.pathname.startsWith('/latest')
    ) || (
      url.hostname === 'api.chnwt.dev' && url.pathname.includes('/thai-gold-api/')
    ) || (
      url.hostname === 'script.google.com' && url.pathname.includes('/macros/s/')
    ) || (
      url.hostname === 'api.goldprice.dev' && url.pathname.startsWith('/v1/')
    );
  } catch (_) { return false; }
}

function normalizedRequest(request) {
  const url = new URL(request.url);
  url.searchParams.delete('fresh');
  return new Request(url.toString(), {
    method: 'GET', headers: request.headers, mode: request.mode,
    credentials: request.credentials, cache: 'default', redirect: request.redirect,
    referrer: request.referrer, referrerPolicy: request.referrerPolicy
  });
}

async function updateApiCache(request, key) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) {
      const cache = await caches.open(API_CACHE_NAME);
      await cache.put(key, response.clone());
    }
  } catch (_) {}
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME && key !== API_CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (!isGet(request)) return;

  // Navigation/HTML: network-first so phones/PWA receive deployed HTML updates
  // instead of remaining on an old cache-first document.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
      } catch (_) {
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isApiRequest(request)) {
    event.respondWith((async () => {
      const key = normalizedRequest(request);
      const cache = await caches.open(API_CACHE_NAME);
      const cached = await cache.match(key);
      if (cached) {
        event.waitUntil(updateApiCache(request, key));
        return cached;
      }
      const response = await fetch(request);
      if (response && response.ok) await cache.put(key, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
