const CACHE_NAME = 'korea-finance-pwa-20261119-saas31';
const API_CACHE_NAME = 'korea-finance-api-20261119-saas31';

const ASSETS = [
  'index.html', 'style.css', 'script.js', 'manifest.json',
  'gold.html', 'gold.css', 'gold.js', 'pwa-persistence.js',
  'auth.js', 'auth-callback.html', 'supabase-config.js', 'planner-nav.js', 'planner-icons.js', 'kfp-support.js', 'kfp-support.css', 'planner-nav.css', 'assets/icons/planner-icons.svg',
  'theme.css', 'ui-fx.js', 'ui-charts.js', 'ui-numflow.js', 'kfp-config.js', 'alloc-ui.js', 'tools.css', 'tools-ui.js', 'kfp-storage.js', 'kfp-demo-data.js', 'kfp-access.js', 'kfp-access.css', 'pricing.html', 'account.html', 'kfp-gold-sync.js', 'kfp-motion.css', 'kfp-motion.js', 'kfp-bfcache.js', 'kfp-badge.css', 'kfp-badge.js', 'kfp-guard.js', 'kfp-country.js', 'kfp-digest.js', 'kfp-digest.css', 'kfp-notice.js', 'kfp-notice.css', 'credit-debt.html', 'credit-debt.css', 'debt-engine.js', 'debt-api.js', 'debt-ui.js', 'showcase.html', 'showcase.css', 'showcase.js', 'planner-logo.css', 'favicon.ico',
  'assets/brand/planner-logo.png', 'assets/brand/planner-logo-sm.png', 'assets/brand/icon-192.png', 'assets/brand/icon-512.png',
  'assets/brand/icon-maskable-512.png', 'assets/brand/apple-touch-icon.png', 'assets/brand/favicon-32.png'
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
// Precache with cache:'reload' so a new service worker never stores a stale copy from the HTTP cache.
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache=>Promise.all(ASSETS.map(a=>cache.add(new Request(a,{cache:'reload'})).catch(()=>{}))))
    .then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key!==CACHE_NAME&&key!==API_CACHE_NAME).map(key=>caches.delete(key))
  )).then(()=>self.clients.claim()));
});

// ---- speed: app pages open from this device, then refresh quietly in the background ----
const APP_PAGES=new Set(['index.html','gold.html','credit-debt.html','account.html','pricing.html','showcase.html']);
function pageKey(url){ const f=url.pathname.split('/').pop()||'index.html'; return APP_PAGES.has(f)?f:null; }
// Cache writes only ever store a body that is ALREADY downloaded: Cache API operations queue behind each other,
// so streaming a slow network body into cache.put() would make the next instant cache hit wait for it.
// Bodies are always read to the end (an unread network body keeps its connection busy).
async function buffered(response){
  const buf=await response.arrayBuffer();
  const init={status:response.status,statusText:response.statusText,headers:response.headers};
  return { save:()=>new Response(buf,init), give:()=>new Response(buf,init) };
}
async function store(cache,key,response){
  try{ const b=await buffered(response); await cache.put(key,b.save()); return b.give(); }catch(_){ return null; }
}
const lastCheck=new Map();                         // background refresh of the same file at most once a minute
async function revalidate(cache,key,request){
  const k=typeof key==='string'?key:key.url, now=Date.now();
  if(lastCheck.has(k)&&now-lastCheck.get(k)<60000) return null;
  lastCheck.set(k,now);
  try{
    const r=await fetch(typeof request==='string'?request:request.url,{cache:'no-store',credentials:'same-origin'});
    if(r&&r.ok&&r.type==='basic') return await store(cache,key,r);
    return r;
  }catch(_){ lastCheck.delete(k); return null; }
}

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(!isGet(request))return;
  let url; try{ url=new URL(request.url); }catch(_){ return; }
  // Admin Console + sign-in callback are never cached (always live; nothing kept on shared devices).
  if(url.origin===self.location.origin&&/\/(admin\.(html|js|css)|auth-callback\.html)$/.test(url.pathname)) return;

  if(url.origin===self.location.origin){
    // 1) App pages (index/gold/credit-debt/account/pricing/showcase): stale-while-revalidate.
    //    Open instantly from the cache; the fresh copy is stored for the next visit. A new deployment
    //    (new sw.js) re-precaches everything, so updates land on the next tab switch.
    const key=(request.mode==='navigate'||request.destination==='document')?pageKey(url):null;
    if(key){
      event.respondWith((async()=>{
        const cache=await caches.open(CACHE_NAME);
        const cached=await cache.match(key);
        if(cached){ event.waitUntil(revalidate(cache,key,request)); return cached; }
        lastCheck.delete(key);
        return (await revalidate(cache,key,request))||(await cache.match(key))||Response.error();
      })());
      return;
    }
    // 2) Versioned files (?v=…) never change → cache first, by exact URL.
    if(url.searchParams.has('v')){
      event.respondWith((async()=>{
        const cache=await caches.open(CACHE_NAME);
        const hit=await cache.match(request);
        if(hit) return hit;
        try{ const r=await fetch(request); if(r&&r.ok&&r.type==='basic') return (await store(cache,request,r))||r; return r; }
        catch(_){ return (await cache.match(request,{ignoreSearch:true}))||Response.error(); }
      })());
      return;
    }
    // 3) Other local files (icons, logo, manifest, other pages): cache first, refresh in background.
    if(request.mode==='navigate'||request.destination==='document'||isLocalAsset(request)||url.pathname.includes('/assets/')||url.pathname.endsWith('.ico')){
      event.respondWith((async()=>{
        const cache=await caches.open(CACHE_NAME);
        const hit=await cache.match(request,{ignoreSearch:true});
        if(hit){ event.waitUntil(revalidate(cache,request,request)); return hit; }
        lastCheck.delete(request.url);
        return (await revalidate(cache,request,request))||Response.error();
      })());
      return;
    }
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
