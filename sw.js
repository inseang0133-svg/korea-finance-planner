const CACHE_NAME = 'korea-finance-pwa-20261031-tz1';
const API_CACHE_NAME = 'korea-finance-api-20261031-tz1';

const ASSETS = [
  'index.html', 'style.css', 'script.js', 'manifest.json',
  'gold.html', 'gold.css', 'gold.js', 'pwa-persistence.js',
  'auth.js', 'supabase-config.js', 'floating-nav.js'
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

  // APIs: NETWORK FIRST (6s timeout) -> cache only when the network fails.
  // (เดิมเป็น stale-while-revalidate ทำให้เครือข่ายที่บล็อกได้ราคาเก่าค้างโดยไม่รู้ตัว)
  if(isApiRequest(request)){
    event.respondWith((async()=>{
      const key=normalizedRequest(request);
      const cache=await caches.open(API_CACHE_NAME);
      try{
        const ctl=new AbortController();
        const t=setTimeout(()=>ctl.abort(),6000);
        const response=await fetch(request,{cache:'no-store',signal:ctl.signal});
        clearTimeout(t);
        if(response&&response.ok)await cache.put(key,response.clone());
        return response;
      }catch(err){
        const cached=await cache.match(key);
        if(cached)return cached;
        throw err;
      }
    })());
    return;
  }

  event.respondWith(fetch(request).catch(()=>caches.match(request)));
});
