/* Phase 22 e2e: instant tab switching — service worker serves the app pages from the device,
 * refreshes them in the background, keeps working offline; plan + debt paint instantly from the
 * account's last server answer (read-only until the live answer arrives).
 * Service workers are ON here (every other suite blocks them). */
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";      // lets context.route() see the worker's own requests
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8822, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
let MARK = "";                                    // when set, pricing.html is served with this marker (simulates a new deployment)
const hits = {};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const p = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  hits[u] = (hits[u] || 0) + 1;
  res.writeHead(200, { "Content-Type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" });
  if (MARK && u === "/pricing.html") return res.end(fs.readFileSync(p, "utf8").replace("</body>", `<i id="deployMark">${MARK}</i></body>`));
  fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
const member = { [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", expires_at: 9999999999, user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" };
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const file = page => new URL(page.url()).pathname.split("/").pop();
const navEntry = page => page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { sw: n.workerStart > 0, ttfb: Math.round(n.responseStart - n.fetchStart), dcl: Math.round(n.domContentLoadedEventEnd) }; });
async function tap(page, k) {
  const b = await page.$eval(`.pn .pn-item[data-k="${k}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(b.x, b.y);
  await page.waitForFunction(k => document.querySelector(`.pn .pn-item[data-k="${k}"][aria-current="page"]`), k, { timeout: 8000 }).catch(() => {});
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/^https?:\/\/(?!localhost)/, r => r.request().url().includes("@supabase/supabase-js") ? r.fulfill({ contentType: "text/javascript", body: MOCK }) : r.abort());
  const page = await ctx.newPage();
  page.errors = []; page.on("pageerror", e => { page.errors.push(e.message); console.log("    [pageerror]", e.message); });
  try {
    await page.goto(`${BASE}/manifest.json`);
    await page.evaluate(m => { localStorage.clear(); sessionStorage.clear(); Object.entries(m).forEach(([k, v]) => localStorage.setItem(k, v));
      sessionStorage.setItem("__mock_plan_u-real", "premium"); sessionStorage.setItem("__mock_country", "KR"); }, member);

    console.log("S1 service worker installs and precaches the app");
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    await settle(page, 2500);
    const cached = await page.evaluate(async () => { const out = {}; for (const f of ["index.html", "gold.html", "credit-debt.html", "account.html", "pricing.html", "planner-nav.js"]) out[f] = !!(await caches.match(f)); return out; });
    ok(await page.evaluate(() => !!navigator.serviceWorker.controller) && Object.values(cached).every(Boolean), "controlled by the worker; pages + nav precached " + JSON.stringify(cached));

    console.log("S2 tab switch is served from the device");
    for (const k of ["gold", "debt", "account", "home"]) {
      const t0 = Date.now(); await tap(page, k); const ms = Date.now() - t0;
      const n = await navEntry(page);
      ok(n.sw && n.ttfb < 80, `${k}: page from the service worker (ttfb ${n.ttfb} ms, nav ready ${ms} ms)`);
    }

    console.log("S3 offline: the tabs still open");
    await ctx.setOffline(true);
    await tap(page, "gold"); await settle(page, 600);
    ok(file(page) === "gold.html" && await vis(page, ".pn .pn-bar"), "gold opens offline");
    await tap(page, "debt"); await settle(page, 800);
    ok(file(page) === "credit-debt.html" && await vis(page, ".pn .pn-bar"), "cards & debt opens offline");
    await ctx.setOffline(false); await settle(page, 400);

    console.log("S4 a new deployment reaches the device on the next visit");
    MARK = "deploy-" + Date.now();
    await page.goto(`${BASE}/pricing.html`); await settle(page, 1500);        // served from cache, refreshed in the background
    const first = await page.$("#deployMark");
    await page.goto(`${BASE}/index.html`); await settle(page, 800);
    await page.goto(`${BASE}/pricing.html`); await settle(page, 1200);
    ok(!first && (await page.textContent("#deployMark").catch(() => "")) === MARK, "first visit instant (old copy), next visit shows the new version");
    MARK = "";

    console.log("S5 plan paints instantly from the last server answer");
    await page.goto(`${BASE}/index.html`); await settle(page, 1500);              // live answer cached (premium)
    await page.evaluate(() => sessionStorage.setItem("__mock_rpc_delay", "1500"));
    await page.goto(`${BASE}/gold.html`);
    await page.waitForFunction(() => document.documentElement.getAttribute("data-plan-state"), null, { timeout: 4000 });
    const early = await page.evaluate(() => ({ st: document.documentElement.getAttribute("data-plan-state"), feat: document.documentElement.getAttribute("data-feat-gold_portfolio") }));
    ok(early.st === "cached" && early.feat === "1", "state ‘cached’ right away, gold unlocked without waiting (" + JSON.stringify(early) + ")");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-plan-state") === "ready", null, { timeout: 8000 }).catch(() => {});
    ok(await page.evaluate(() => document.documentElement.getAttribute("data-plan-state")) === "ready", "then the live answer replaces it");

    console.log("S6 cards & debt: instant read-only paint, writes after the live answer");
    await page.evaluate(() => sessionStorage.setItem("__mock_rpc_delay", "0"));
    await page.goto(`${BASE}/credit-debt.html`); await settle(page, 1800);         // live load → snapshot cached
    ok(await vis(page, '[data-act="card-new"]'), "live: add-card available");
    await page.evaluate(() => sessionStorage.setItem("__mock_rpc_delay", "1500"));
    await page.goto(`${BASE}/credit-debt.html`); await settle(page, 450);
    const warm = { skel: !!(await page.$(".cd-skel")), nav: await vis(page, ".pn .pn-bar"), add: await vis(page, '[data-act="card-new"]'), cache: await page.evaluate(() => !!(window.kfpDebtApi && window.kfpDebtApi.cached && window.kfpDebtApi.cached())) };
    ok(!warm.skel && warm.nav && !warm.add, "cached workspace shown at once, no skeleton, no write buttons yet " + JSON.stringify(warm));
    await page.waitForSelector('[data-act="card-new"]', { timeout: 8000 }).catch(() => {});
    ok(await vis(page, '[data-act="card-new"]'), "write buttons appear once the server answers");
    await page.evaluate(() => sessionStorage.setItem("__mock_rpc_delay", "0"));

    console.log("S7 no unload handlers (back/forward cache stays usable)");
    ok(!/addEventListener\(\s*["']beforeunload["']/.test(fs.readFileSync(path.join(ROOT, "pwa-persistence.js"), "utf8")), "pwa-persistence no longer listens to beforeunload");
    await page.evaluate(async () => { const L = window.__kfpRealLocalStorage; L.setItem("kfp:device:probe", "1"); await window.__kfpPwaPersist(); L.removeItem("kfp:device:probe"); location.reload(); });
    await page.waitForLoadState("load"); await settle(page, 1200);
    ok(await page.evaluate(() => window.__kfpRealLocalStorage.getItem("kfp:device:probe") === null), "data removed right before a reload is not brought back by the device backup");
    ok(page.errors.length === 0, "no page errors");

    console.log("S8 heavy libraries stay off the critical path");
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const lib = { xlsx: 0, lwc: 0 };
    const LWC = `(function(){var h={get:function(t,k){if(k==="then")return undefined;if(k===Symbol.toPrimitive)return function(){return 0};return P},apply:function(){return P}};var P=new Proxy(function(){},h);
      window.__lwcCreated=0;window.LightweightCharts={CrosshairMode:{Normal:0},LineStyle:{},PriceScaleMode:{},ColorType:{Solid:"solid"},createChart:function(){window.__lwcCreated++;return P}};})();`;
    const XLSX = `window.XLSX={utils:{json_to_sheet:function(r){return {rows:r}},book_new:function(){return {}},book_append_sheet:function(){}},writeFile:function(w,n){window.__xlsxWrote=n}};`;
    await ctx2.route(/^https?:\/\/(?!localhost)/, r => { const u = r.request().url();
      if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
      if (u.includes("xlsx.full.min.js")) { lib.xlsx++; return r.fulfill({ contentType: "text/javascript", body: XLSX }); }
      if (u.includes("lightweight-charts")) { lib.lwc++; return new Promise(ok => setTimeout(ok, 2500)).then(() => r.fulfill({ contentType: "text/javascript", body: LWC })); }
      return r.abort(); });
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/manifest.json`);
    await p2.evaluate(m => { localStorage.clear(); Object.entries(m).forEach(([k, v]) => localStorage.setItem(k, v));
      localStorage.setItem("salaryRecords", JSON.stringify([{ month: "2026-10", salary: 2500000, rate: 0.024 }]));
      sessionStorage.setItem("__mock_plan_u-real", "premium"); sessionStorage.setItem("__mock_country", "KR"); }, member);
    await p2.goto(`${BASE}/index.html`); await settle(p2, 1200);
    ok(lib.xlsx === 0 && !(await p2.evaluate(() => !!window.XLSX)), "home no longer downloads the Excel writer up front");
    await p2.click('button[onclick^="exportExcel("]');
    await p2.waitForFunction(() => window.__xlsxWrote, null, { timeout: 5000 }).catch(() => {});
    ok(lib.xlsx === 1 && /\.xlsx$/.test(await p2.evaluate(() => window.__xlsxWrote || "")), "Export Excel fetches the writer on demand and still saves the file");
    const t0 = Date.now(); await p2.goto(`${BASE}/gold.html`, { waitUntil: "domcontentloaded" }); const dcl = Date.now() - t0;
    ok(dcl < 1500 && !(await p2.evaluate(() => window.__lwcCreated)), `gold page is usable before the chart library arrives (${dcl} ms; library delayed 2.5 s)`);
    await p2.waitForFunction(() => window.__lwcCreated > 0, null, { timeout: 6000 }).catch(() => {});
    ok(await p2.evaluate(() => window.__lwcCreated > 0), "chart draws as soon as the library lands");
    await ctx2.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 22 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
