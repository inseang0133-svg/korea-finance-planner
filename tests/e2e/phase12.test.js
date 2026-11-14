/* Phase 12 e2e: security behaviour in the browser.
 *   X1 stored-XSS canary in every place user text is shown (expenses, deductions, categories, gold notes, profile)
 *   X2 guest tour of every page: no errors, no writes
 *   X3 admin CSP: no violations while the console is used
 *   X4 "log out and remove from this device" (shared devices), incl. the iOS IndexedDB backup
 *   X5 only Stripe URLs are followed after checkout/portal
 *   X6 profile update sends only the permitted column; account isolation on one device
 * Run: node tests/e2e/phase12.test.js */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8805, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1"><svg onload="window.__xss=(window.__xss||0)+1"></svg>"'><script>window.__xss=9</script>`;

async function newPage(browser, { fn, viewport, users } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 420, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = []; page.csp = []; page.alerts = 0; page.nav = [];
  if (users) await page.addInitScript(u => { window.__sb = { users: u }; }, users);
  await page.addInitScript(() => { document.addEventListener("securitypolicyviolation", e => { (window.__csp = window.__csp || []).push(e.violatedDirective + " " + e.blockedURI); }); });
  page.on("dialog", d => { if (d.type() === "confirm") return d.accept(); page.alerts++; d.dismiss(); });
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX|LightweightCharts|createChart/i.test(e.message)) page.errors.push(e.message); });
  page.on("console", m => { if (/Content Security Policy/i.test(m.text())) page.csp.push(m.text()); });
  page.on("framenavigated", f => { if (f === page.mainFrame()) page.nav.push(f.url()); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    const m = /\/functions\/v1\/([a-z-]+)/.exec(u);
    if (m) { const spec = (fn && fn[m[1]]) || { status: 404, body: {} }; return r.fulfill({ status: spec.status, contentType: "application/json", body: JSON.stringify(spec.body) }); }
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
const member = (email = "a@gmail.com", id = "u-real") => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-" + email, refresh_token: "rt", user: { id, email, email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": id });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
async function open(page, file, wait = 1500) { await page.goto(`${BASE}/${file}`); await page.waitForTimeout(wait); }
const calls = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]"));
const injected = (page) => page.evaluate(() => ({ xss: window.__xss || 0, nodes: document.querySelectorAll('img[src="x"], svg[onload], script:not([src])').length - document.querySelectorAll("head script:not([src]), body > script:not([src])").length }));
const NS = (k, id = "u-real") => `kfp:u:${id}:${k}`;
const realKeys = (page) => page.evaluate(() => { const L = window.__kfpRealLocalStorage || localStorage; return Array.from({ length: L.length }, (_, i) => L.key(i)); });
const ym = new Date().toISOString().slice(0, 7), today = new Date().toISOString().slice(0, 10);

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("X1 stored-XSS canary: user text everywhere is shown as text");
    const evil = {
      [NS("kfp_expenses_v1")]: JSON.stringify([{ id: "e1", ts: Date.now(), cur: "KRW", name: XSS, cat: "family", date: today, rate: 0.025, amt: 1000, krw: 1000, thb: 25 }]),
      [NS("kfp_work_deductions_v1")]: JSON.stringify([{ id: "d1", ym, name: XSS, krw: 5000, rate: 0.025, thb: 125 }]),
      [NS("kfp_alloc_v1")]: JSON.stringify({ cats: [{ id: "saving", emoji: "💰", name: XSS.slice(0, 24), pct: 50, role: "saving" }, { id: "family", emoji: "<b>", name: "fam" + XSS, pct: 50, role: "" }] }),
      [NS("kfp_gold_lots_v1")]: JSON.stringify([{ id: "g1", date: today, time: "", goldType: "96.5", quantity: 1, unit: "baht", grams: 15.244, costThb: 60000, note: XSS }]),
      [NS("salary")]: "2500000"
    };
    let page = await newPage(browser, { users: { "a@gmail.com": { id: "u-real", password: "Passw0rd1", confirmed: true, username: XSS } } });
    await seed(page, member(), evil);
    await open(page, "index.html", 1800);
    await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(300);
    await page.click('[data-act="ex-tab"][data-v="history"]').catch(() => {}); await page.waitForTimeout(300);
    const exText = await page.textContent("body");
    ok(exText.includes('onerror="window.__xss'), "expense name rendered (as text)");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    await page.click('[data-open-tool="work"]'); await page.waitForTimeout(300);
    await page.click('[data-act="m-sum"]').catch(() => {}); await page.waitForTimeout(400);
    ok((await page.textContent("body")).includes("<svg onload="), "deduction name rendered (as text)");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(500);
    let r = await injected(page);
    ok(r.xss === 0 && r.nodes <= 0 && page.alerts === 0, `index + expense/work popups + account panel: nothing executed (${JSON.stringify(r)})`);
    await open(page, "gold.html", 2200);
    r = await injected(page);
    ok((await page.textContent("body")).includes("onerror=") && r.xss === 0 && r.nodes <= 0, "gold lot note rendered as text, nothing executed");
    ok(page.errors.length === 0, "no script errors: " + page.errors.slice(0, 2).join(" | "));

    console.log("X2 guest tour: every page loads, nothing is written anywhere");
    page = await newPage(browser);
    await seed(page, {});
    for (const f of ["index.html", "gold.html", "pricing.html", "account.html", "admin.html", "auth-callback.html"]) await open(page, f, 1200);
    const writes = (await calls(page)).filter(c => /^(upsert|update|insert|delete):/.test(c.name) || /rpc:(touch_activity|save_my_gold|admin_)/.test(c.name));
    ok(page.errors.length === 0, "6 pages, no script errors " + page.errors.slice(0, 2).join(" | "));
    ok(writes.length === 0, "guest: zero database writes / private calls " + writes.map(c => c.name).join(","));
    ok((await realKeys(page)).filter(k => k.indexOf("kfp:u:") === 0).length === 0, "guest: no account namespace created");

    console.log("X3 admin console under a strict CSP");
    page = await newPage(browser, { viewport: { width: 1280, height: 900 } });
    await seed(page, member(), { "__mock_admin_role": "admin" });
    await open(page, "admin.html", 1500);
    for (const t of ["users", "activity", "revenue", "prices", "audit"]) { await page.click("#tab-" + t); await page.waitForTimeout(400); }
    await page.click("#tab-users"); await page.waitForTimeout(300);
    await page.click('#userRows tr[data-user]'); await page.waitForTimeout(500);
    const viol = await page.evaluate(() => window.__csp || []);
    ok(await page.isVisible("#app") && viol.length === 0 && page.csp.length === 0, "all tabs + drawer work, 0 CSP violations " + viol.concat(page.csp).slice(0, 2).join(" | "));
    ok(await page.evaluate(() => { const s = document.createElement("script"); s.textContent = "window.__inl=1"; document.body.appendChild(s); return !window.__inl; }), "CSP blocks an injected inline script");
    await page.waitForTimeout(200);
    ok((await page.evaluate(() => window.__csp || [])).some(v => /script-src/.test(v)), "…and the browser reports it as a script-src violation");
    await page.evaluate(() => { const s = document.createElement("script"); s.src = "https://evil.example/x.js"; document.body.appendChild(s); });
    await page.waitForTimeout(300);
    ok((await page.evaluate(() => window.__csp || [])).some(v => /evil\.example/.test(v)), "CSP blocks scripts from other origins");

    console.log("X4 log out and remove this account from a shared device");
    page = await newPage(browser);
    await seed(page, Object.assign(member(), { [NS("salary")]: "2500000", [NS("kfp_expenses_v1")]: "[]", [NS("salary", "u-other")]: "1234" }), { "__mock_plan_u-real": "plus" });
    await open(page, "index.html", 1600);
    await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(400);
    await page.click("#kfpLogoutWipeBtn"); await page.waitForTimeout(150);
    ok((await page.textContent("#kfpLogoutWipeBtn")).includes("แตะอีกครั้ง") && await page.evaluate(() => !!window.__kfpRealLocalStorage.getItem("kfp:u:u-real:salary")), "first tap only asks (nothing removed)");
    await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => {}), page.click("#kfpLogoutWipeBtn")]);
    await page.waitForTimeout(1500);
    const left = (await realKeys(page)).filter(k => k.indexOf("kfp:u:u-real:") === 0);
    ok(left.length === 0 && await page.evaluate(() => document.documentElement.getAttribute("data-kfp-mode")) === "preview", "account data removed, back to Preview");
    ok(await page.evaluate(() => window.__kfpRealLocalStorage.getItem("kfp:u:u-other:salary")) === "1234", "another account on the same device is untouched");
    await page.reload(); await page.waitForTimeout(2000);
    ok((await realKeys(page)).filter(k => k.indexOf("kfp:u:u-real:") === 0).length === 0, "not resurrected by the iOS IndexedDB backup after reload");

    console.log("X5 checkout/portal: only Stripe pages are followed");
    page = await newPage(browser, { fn: { "create-checkout": { status: 200, body: { url: "https://evil.example/phish" } } } });
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await open(page, "pricing.html", 1300);
    const before = page.nav.length;
    await page.click("#plus .cta"); await page.waitForTimeout(600);
    ok(page.nav.length === before && page.url().startsWith(BASE + "/pricing.html"), "pricing: non-Stripe URL from the server is not opened");
    page = await newPage(browser, { fn: { "create-portal": { status: 200, body: { url: "javascript:alert(1)" } } } });
    await seed(page, member(), { "__mock_plan_u-real": "plus", "__mock_billing_u-real": JSON.stringify({ subscription: { plan_id: "plus", plan_name: "Finance Plus", status: "active", billing_interval: "month", currency: "THB", unit_amount_minor: 12900, cancel_at_period_end: false, current_period_end: new Date(Date.now() + 9e8).toISOString() }, grants: [], has_customer: true }) });
    await open(page, "account.html", 1500);
    await page.click('[data-portal-flow="manage"]'); await page.waitForTimeout(500);
    ok(page.alerts === 0 && page.url().startsWith(BASE + "/account.html"), "account: javascript: URL refused");

    console.log("X6 profile writes + account isolation on one device");
    page = await newPage(browser);
    await seed(page, Object.assign(member(), { [NS("salary")]: "2500000", [NS("salary", "u-legacy")]: "999" }));
    await open(page, "index.html", 1500);
    await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(300);
    await page.fill("#kfpNickname", "ชื่อใหม่ " + "ก".repeat(80)); await page.selectOption("#kfpCountry", "KR");
    await page.click("#kfpSaveProfileBtn"); await page.waitForTimeout(300);
    const upd = (await calls(page)).filter(c => c.name === "update:profiles").pop();
    ok(upd && JSON.stringify(Object.keys(upd.args).sort()) === '["country","nickname"]' && upd.args.nickname.length === 60 && upd.args.country === "KR",
       "profile update sends only {nickname, country}, nickname max 60, country = 2-letter code (admin Country column)");
    ok(await page.evaluate(() => localStorage.getItem("salary")) === "2500000" && await page.evaluate(() => localStorage.getItem("kfp:u:u-legacy:salary")) === null,
       "this account cannot read another account's namespace through the page");

    console.log("X7 PART 7: a Free (expired) member can still download all own data");
    page = await newPage(browser);
    await seed(page, Object.assign(member(), { [NS("salary")]: "2500000", [NS("kfp_expenses_v1")]: JSON.stringify([{ id: "e1", name: "ค่าเช่า", krw: 300000 }]) }),
      { "__mock_plan_u-real": "free", "__mock_gold_u-real": JSON.stringify({ lots: [{ id: "old1", grams: 15.244, costThb: 60000 }], settings: {}, version: 3 }) });
    await open(page, "account.html", 1500);
    ok(await page.isVisible("#dataCard"), "'ข้อมูลของฉัน' card shown on Free");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), page.click("#exportMyData")]);
    const file = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
    ok(file.device_data.salary === 2500000 && file.device_data.kfp_expenses_v1[0].name === "ค่าเช่า", "file has the device data of this account");
    ok(file.cloud_gold.lots[0].id === "old1" && file.account.email === "a@gmail.com", "…and the gold kept on Cloud, even without Premium");
    ok(!JSON.stringify(file).includes("access_token") && !Object.keys(file.device_data).some(k => /^sb-|^__/.test(k)), "no session tokens / internal keys in the file");

    console.log("X8 PART 10: gold restore from an Export file + undo");
    page = await newPage(browser);
    await seed(page, Object.assign(member(), { [NS("kfp_gold_lots_v1")]: JSON.stringify([{ id: "cur", date: today, goldType: "96.5", quantity: 1, unit: "baht", grams: 15.244, costThb: 60000 }]) }),
      { "__mock_plan_u-real": "premium" });
    await open(page, "gold.html", 2000);
    const exp = JSON.stringify({ exportedAt: "x", lots: [{ id: "a", date: today, goldType: "96.5", quantity: 1, unit: "baht", grams: 15.244, costThb: 50000 }, { id: "b", date: today, goldType: "99.99", quantity: 2, unit: "g", grams: 2, costThb: 8000, note: "<b>n</b>" }], settings: {} });
    await page.setInputFiles("#importGoldFile", { name: "gold.json", mimeType: "application/json", buffer: Buffer.from(exp) });
    await page.waitForTimeout(2200);
    const lotsNow = await page.evaluate(() => JSON.parse(localStorage.getItem("kfp_gold_lots_v1")).map(l => l.id).join());
    ok(lotsNow === "a,b" && (await page.textContent("#lotSummary")).includes("2 รอบ"), "restored 2 lots from the file (confirm accepted)");
    ok(await page.isVisible("#undoGoldBtn"), "undo button appears");
    const pushed = (await calls(page)).filter(c => c.name === "rpc:save_my_gold").pop();
    ok(pushed && pushed.args.p_lots.length === 2, "restored data synced to the Cloud");
    await page.click("#undoGoldBtn"); await page.waitForTimeout(400);
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem("kfp_gold_lots_v1")).map(l => l.id).join()) === "cur", "undo brings the previous lot back");
    await page.setInputFiles("#importGoldFile", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"lots":[{"id":"x","grams":"lots"}]}') });
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem("kfp_gold_lots_v1")).map(l => l.id).join()) === "cur", "invalid file rejected, nothing changed");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
