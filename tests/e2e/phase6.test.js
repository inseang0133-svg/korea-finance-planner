/* Phase 6 e2e: prices from plan_prices + throttled activity heartbeat.  Run: node tests/e2e/phase6.test.js */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8799, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX|LightweightCharts|createChart/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => { const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  return page;
}
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const member = { [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" };
const acts = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => c.name === "rpc:touch_activity" && c.args.p_kind !== "feature").map(c => c.args));   // page heartbeats only (Phase 11 feature events are counted separately)

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("A1 pricing page shows prices from plan_prices (admin-editable)");
    let page = await newPage(browser);
    await seed(page, {}, { "__mock_prices": JSON.stringify([
      { plan_id: "plus", billing_interval: "month", currency: "THB", amount_minor: 14900 },
      { plan_id: "plus", billing_interval: "year", currency: "KRW", amount_minor: 59000 },
      { plan_id: "premium", billing_interval: "month", currency: "THB", amount_minor: 19900 } ]) });
    await page.goto(`${BASE}/pricing.html`); await page.waitForSelector("#plans .plan"); await page.waitForTimeout(700);
    ok((await page.textContent("#plus")).includes("฿149"), "changed price ฿149 shown (THB stored in satang)");
    await page.click('#segInterval [data-v="year"]'); await page.click('#segCurrency [data-v="KRW"]');
    ok((await page.textContent("#plus")).includes("₩59,000"), "KRW yearly set by admin shown (zero-decimal)");
    ok((await page.textContent("#premium")).includes("—"), "missing price → placeholder, not a stale default");

    console.log("A2 activity heartbeat");
    page = await newPage(browser);
    await seed(page, {});
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(1200);
    ok((await acts(page)).length === 0, "guest: nothing sent");
    await seed(page, member);
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(1200);
    let a = await acts(page);
    ok(a.length === 1 && a[0].p_page === "index.html" && a[0].p_kind === "login", "member: one 'login' ping for index.html");
    await page.reload(); await page.waitForTimeout(1200);
    await page.reload(); await page.waitForTimeout(1200);
    ok((await acts(page)).length === 1, "reloads within 5 minutes → no extra writes");
    await page.goto(`${BASE}/gold.html`); await page.waitForTimeout(1200);
    a = await acts(page);
    ok(a.length === 2 && a[1].p_page === "gold.html" && a[1].p_kind === "page", "new page → one 'page' ping");
    await page.evaluate(() => sessionStorage.setItem("__kfp_act_gold.html", String(Date.now() - 6 * 60 * 1000)));
    await page.reload(); await page.waitForTimeout(1200);
    ok((await acts(page)).length === 3, "after 5 minutes → next ping allowed");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
