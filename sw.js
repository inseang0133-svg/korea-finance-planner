const CACHE_NAME = 'korea-finance-pwa-20260823-13';
const API_CACHE_NAME = 'korea-finance-api-20260823-13';

const ASSETS = [
  'index.html', 'style.css', 'script.js', 'manifest.json',
  'gold.html', 'gold.css', 'gold.js', 'pwa-persistence.js',
  'auth.js', 'supabase-config.js'
];

const API_HOSTS = new Set([
  'xaus.com', 'api.gold-api.com', 'api.frankfurter.app',
  'api.chnwt.dev', 'script.google.com', 'api.goldprice.dev'
]);

function isGet(request) { return request.method === 'GET'; }
function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    if (!API_HOSTS.has(url.hostname)) return false;
    return (
      (url.hostname === 'xaus.com' && url.pathname.startsWith('/api/v1/')) ||
      (url.hostname === 'api.gold-api.com' && url.pathname.startsWith('/price/')) ||
      (url.hostname === 'api.frankfurter.app' && url.pathname.startsWith('/latest')) ||
      (url.hostname === 'api.chnwt.dev' && url.pathname.includes('/thai-gold-api/')) ||
      (url.hostname === 'script.google.com' && url.pathname.includes('/macros/s/')) ||
      (url.hostname === 'api.goldprice.dev' && url.pathname.startsWith('/v1/'))
    );
  } catch (_) { return false; }
}
function isLocalAsset(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return ASSETS.includes(url.pathname.split('/').pop());
  } catch (_) { return false; }
}
function normalizedRequest(request) {
  const url = new URL(request.url);
  url.searchParams.delete('fresh');
  return new Request(url.toString(), {
    method:'GET', headers:request.headers, mode:request.mode,
    credentials:request.credentials, cache:'default', redirect:request.redirect,
    referrer:request.referrer, referrerPolicy:request.referrerPolicy
  });
}
async function updateApiCache(request,key) {
  try {
    const response=await fetch(request,{cache:'no-store'});
    if(response&&response.ok){const cache=await caches.open(API_CACHE_NAME);await cache.put(key,response.clone());}
  } catch(_){}
}
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key!==CACHE_NAME&&key!==API_CACHE_NAME).map(key=>caches.delete(key))
  )).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(!isGet(request))return;

  // Local HTML/CSS/JS: NETWORK FIRST. This prevents an installed PWA from
  // continuing to run an old gold.js/gold.css after a deployment.
  if(request.mode==='navigate'||request.destination==='document'||isLocalAsset(request)){
    event.respondWith((async()=>{
      const cache=await caches.open(CACHE_NAME);
      try{
        const response=await fetch(request,{cache:'no-store'});
        if(response&&response.ok)await cache.put(request,response.clone());
        return response;
      }catch(_){
        const cached=await cache.match(request)||await cache.match(new URL(request.url).pathname);
        return cached||Response.error();
      }
    })());
    return;
  }

  // APIs remain stale-while-revalidate for fast/offline behavior.
  if(isApiRequest(request)){
    event.respondWith((async()=>{
      const key=normalizedRequest(request);
      const cache=await caches.open(API_CACHE_NAME);
      const cached=await cache.match(key);
      if(cached){event.waitUntil(updateApiCache(request,key));return cached;}
      const response=await fetch(request,{cache:'no-store'});
      if(response&&response.ok)await cache.put(key,response.clone());
      return response;
    })());
    return;
  }

  event.respondWith(fetch(request).catch(()=>caches.match(request)));
});
