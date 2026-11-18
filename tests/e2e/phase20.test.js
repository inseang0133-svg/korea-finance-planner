/* Phase 20 e2e: Liquid Glass navigation (mobile tab bar + desktop sidebar) and the custom icon set.
 * Run: node tests/e2e/phase20.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
require("./demo-seed");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8820, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
async function newPage(browser, viewport = { width: 390, height: 844 }, reducedMotion = "no-preference") {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block", reducedMotion });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { page.errors.push(e.message); console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.includes("/functions/v1/")) return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
const member = () => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", expires_at: 9999999999, user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem("kfp_demo", "1");
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const file = page => new URL(page.url()).pathname.split("/").pop();
async function shot(page, name) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png") }); }
const EMOJI_LEFT = () => {   // known emoji still shown as text in the rendered UI (inputs / options excluded)
  const re = /[\u{1F300}-\u{1FAFF}]|[☀-➿]/u, out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let t;
  while ((t = w.nextNode())) { const p = t.parentNode; if (/^(SCRIPT|STYLE|OPTION|SELECT|TEXTAREA)$/.test(p.nodeName)) continue; if (re.test(t.nodeValue) && p.offsetParent !== null) out.push(t.nodeValue.trim().slice(0, 30)); }
  return out;
};

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("N1 icon set");
    const sprite = fs.readFileSync(path.join(ROOT, "assets/icons/planner-icons.svg"), "utf8");
    const ids = new Set([...sprite.matchAll(/<symbol id="pi-([a-z-]+)"/g)].map(m => m[1]));
    const iconsJs = fs.readFileSync(path.join(ROOT, "planner-icons.js"), "utf8");
    const used = new Set([...iconsJs.slice(iconsJs.indexOf("var MAP"), iconsJs.indexOf("var TONE")).matchAll(/:\s*"([a-z-]+)"/g)].map(m => m[1]));
    const navJs = fs.readFileSync(path.join(ROOT, "planner-nav.js"), "utf8");
    [...navJs.matchAll(/icon: "([a-z-]+)"/g)].forEach(m => used.add(m[1]));
    const missing = [...used].filter(n => !ids.has(n));
    ok(ids.size >= 60 && missing.length === 0, `sprite has ${ids.size} icons and every mapped icon exists` + (missing.length ? " (missing " + missing.join(",") + ")" : ""));
    ok(!/<script|on[a-z]+=/i.test(sprite), "sprite is pure SVG (no scripts / handlers)");

    console.log("N2 mobile tab bar");
    let page = await newPage(browser);
    await seed(page);
    await page.goto(`${BASE}/index.html`); await settle(page, 1500);
    ok(await vis(page, ".pn .pn-bar") && !(await vis(page, ".pn-side")), "bottom glass bar on phones, no sidebar");
    ok(!(await page.$(".kfp-fab")), "old floating bubble is gone");
    const tabs = await page.$$eval(".pn .pn-item", es => es.map(e => [e.dataset.k, e.getAttribute("href"), e.getAttribute("aria-current"), e.textContent.trim()]));
    ok(tabs.length === 4 && tabs.map(t => t[0]).join() === "home,gold,debt,account", "4 tabs: home · gold · cards & debt · account");
    ok(tabs[0][2] === "page" && tabs.filter(t => t[2]).length === 1, "current page marked with aria-current");
    const geo = await page.evaluate(() => { const b = document.querySelector(".pn-bar"), l = b.querySelector(".pn-lens").getBoundingClientRect(), h = b.querySelector('.pn-item[data-k="home"]').getBoundingClientRect(), r = b.getBoundingClientRect();
      return { lens: Math.round(l.left + l.width / 2), home: Math.round(h.left + h.width / 2), h: r.height, bottom: innerHeight - r.bottom, items: [...b.querySelectorAll(".pn-item")].map(i => i.getBoundingClientRect().height) }; });
    ok(Math.abs(geo.lens - geo.home) <= 3, "gold lens sits under the active tab");
    ok(geo.items.every(h => h >= 44) && geo.bottom >= 8, "tap targets ≥ 44px, bar floats above the bottom edge");
    ok(await page.$eval(".pn-bar", e => /blur/.test(getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter || "")), "liquid-glass blur on the bar");
    ok(await page.evaluate(() => { const s = document.querySelector(".pn-spacer"); return s && s.getBoundingClientRect().height >= 90; }), "spacer keeps the last content above the bar");
    ok((await page.evaluate(EMOJI_LEFT)).length === 0, "no emoji left in the visible app UI: " + (await page.evaluate(EMOJI_LEFT)).join(" | "));
    ok(await page.$$eval("svg.pi-e use", us => us.length > 15 && us.every(u => /planner-icons\.svg#pi-/.test(u.getAttribute("href")))), "emoji in buttons/headings rendered as custom SVG icons");
    ok((await page.$eval("#salary", e => e.value)) !== null && (await page.$$eval("input", is => is.every(i => !/[\u{1F300}-\u{1FAFF}]/u.test(i.value || "") || i.classList.contains("al-emoji")))), "input values untouched");
    await shot(page, "n2-mobile");

    console.log("N3 tap → spring → navigate");
    { const g = await page.$eval('.pn .pn-item[data-k="gold"]', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(g.x, g.y); }
    await page.waitForTimeout(150);
    const mid = await page.evaluate(() => { const l = document.querySelector(".pn .pn-lens").getBoundingClientRect(), g = document.querySelector('.pn .pn-item[data-k="gold"]').getBoundingClientRect(); return Math.abs((l.left + l.width / 2) - (g.left + g.width / 2)); });
    ok(file(page) === "index.html" && mid < 60, "lens springs toward the tapped tab before the page changes");
    await page.waitForURL(/gold\.html/, { timeout: 4000 }).catch(() => {});
    await settle(page, 1200);
    ok(file(page) === "gold.html" && await page.getAttribute('.pn .pn-item[data-k="gold"]', "aria-current") === "page", "gold page opens with the gold tab active");

    console.log("N4 press and slide along the bar");
    const box = async k => page.$eval(`.pn .pn-item[data-k="${k}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const a = await box("gold"), b = await box("account");
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y, { steps: 2 });
    ok(await page.$eval(".pn-bar", e => e.classList.contains("pn-drag")) && await page.$eval('.pn .pn-item[data-k="account"]', e => e.classList.contains("pn-hot")), "lens follows the finger and highlights the tab under it");
    await page.mouse.up();
    await page.waitForURL(/account\.html/, { timeout: 4000 }).catch(() => {});
    await settle(page, 1000);
    ok(file(page) === "account.html" && await page.getAttribute('.pn .pn-item[data-k="account"]', "aria-current") === "page", "releasing on a tab opens it");

    console.log("N5 quick-add sheet");
    await page.goto(`${BASE}/index.html`); await settle(page, 1500);
    await page.click(".pn .pn-add"); await settle(page, 600);
    ok(await vis(page, "#pnSheet.on") && await page.getAttribute(".pn .pn-add", "aria-expanded") === "true", "+ opens the quick sheet");
    ok((await page.$$eval("#pnSheet .pn-act:not([hidden])", e => e.length)) === 4, "4 quick actions (expense · attendance · gold round · card payment)");
    ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("pn-act")), "focus moves into the sheet");
    await page.keyboard.press("Escape"); await settle(page, 400);
    ok(!(await vis(page, "#pnSheet.on")) && await page.evaluate(() => document.activeElement.classList.contains("pn-add")), "Escape closes it and returns focus to +");
    await page.click(".pn .pn-add"); await settle(page, 500);
    await page.click('#pnSheet [data-q="expense"]'); await settle(page, 900);
    ok(await vis(page, "#kfpTools") && /รายจ่าย/.test(await page.textContent("#kfpTools")), "‘บันทึกรายจ่าย’ opens the existing expense tool");
    await page.keyboard.press("Escape"); await settle(page, 500);

    console.log("N6 quick actions from another page");
    await page.goto(`${BASE}/gold.html`); await settle(page, 1500);
    await page.click(".pn .pn-add"); await settle(page, 500);
    await page.click('#pnSheet [data-q="expense"]');
    await page.waitForURL(/index\.html/, { timeout: 4000 }).catch(() => {}); await settle(page, 2500);
    ok(file(page) === "index.html" && await vis(page, "#kfpTools") && !/quick=/.test(page.url()), "from gold → index opens the expense tool, hash cleared");
    await page.keyboard.press("Escape"); await settle(page, 400);
    await page.click(".pn .pn-add"); await settle(page, 500);
    await page.click('#pnSheet [data-q="gold"]');
    await page.waitForURL(/gold\.html/, { timeout: 4000 }).catch(() => {}); await settle(page, 2500);
    ok(file(page) === "gold.html" && await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest("#lotForm")), "‘บันทึกรอบซื้อทอง’ jumps to the round form with focus");
    await page.close();

    console.log("N7 plan gating shows locks, never hides the tabs");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "free" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2200);
    ok(await vis(page, '.pn .pn-item[data-k="gold"]') && await vis(page, '.pn .pn-item[data-k="gold"] .pn-lock') && await vis(page, '.pn .pn-item[data-k="debt"] .pn-lock'), "free plan: gold + debt tabs visible with a lock");
    await page.click(".pn .pn-add"); await settle(page, 500);
    ok(await vis(page, '#pnSheet [data-q="work"] .pn-tier') && await vis(page, '#pnSheet [data-q="gold"] .pn-tier'), "locked quick actions carry their plan tag");
    await page.click('#pnSheet [data-q="work"]'); await settle(page, 700);
    ok(!(await vis(page, "#kfpTools")) && await vis(page, "#kfpUpsell"), "locked action shows the upgrade dialog instead of opening the tool");
    await page.close();
    page = await newPage(browser);
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "premium" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2200);
    ok(!(await vis(page, '.pn .pn-item[data-k="gold"] .pn-lock')) && !(await vis(page, '.pn .pn-item[data-k="debt"] .pn-lock')), "premium: no locks");
    await page.evaluate(() => { localStorage.setItem("kfp_mode_v1", "THB"); kfpApplyMode && kfpApplyMode(); });
    await page.click(".pn .pn-add"); await settle(page, 500);
    ok(!(await vis(page, '#pnSheet [data-q="work"]')), "baht mode: attendance action hidden (it is a ₩ tool)");
    await page.close();

    console.log("N8 desktop sidebar");
    page = await newPage(browser, { width: 1366, height: 860 });
    await seed(page);
    await page.goto(`${BASE}/credit-debt.html`); await settle(page, 1600);
    ok(await vis(page, ".pn-side") && !(await vis(page, ".pn .pn-bar")), "sidebar on desktop, bottom bar hidden");
    ok(await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingLeft) >= 240), "content shifts right of the sidebar");
    ok(await page.getAttribute('.pn-side .pn-item[data-k="debt"]', "aria-current") === "page", "cards & debt active in the sidebar");
    const pill = await page.evaluate(() => { const p = document.querySelector(".kfp-pv-pill"), s = document.querySelector(".pn-side"); if (!p) return true; return p.getBoundingClientRect().left >= s.getBoundingClientRect().right; });
    ok(pill, "top-left badge/pill moved clear of the sidebar");
    await page.click(".pn-side .pn-side-add"); await settle(page, 600);
    ok(await vis(page, "#pnSheet.on"), "sidebar ‘บันทึกด่วน’ opens the same quick sheet");
    await shot(page, "n8-desktop");
    await page.keyboard.press("Escape");
    await page.click('.pn-side .pn-item[data-k="home"]');
    await page.waitForURL(/index\.html/, { timeout: 4000 }).catch(() => {}); await settle(page, 800);
    ok(file(page) === "index.html", "sidebar link navigates");
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("N9 reduced motion + other pages");
    page = await newPage(browser, { width: 390, height: 844 }, "reduce");
    await seed(page);
    await page.goto(`${BASE}/index.html`); await settle(page, 1200);
    const t0 = Date.now(); await page.click('.pn .pn-item[data-k="account"]'); await page.waitForURL(/account\.html/, { timeout: 4000 }).catch(() => {});
    ok(file(page) === "account.html" && await page.$eval(".pn-lens", e => getComputedStyle(e).transitionDuration === "0s"), "reduced motion: no spring, navigates straight away");
    for (const p of ["pricing.html", "admin.html"]) {
      await page.goto(`${BASE}/${p}`); await settle(page, 1000);
      ok(await vis(page, ".pn .pn-bar") && (await page.$$eval('.pn .pn-item[aria-current="page"]', e => e.length)) === 0, p + ": nav present, no tab falsely active");
    }
    await page.goto(`${BASE}/showcase.html`); await settle(page, 800);
    ok(!(await page.$(".pn")) && (await page.evaluate(EMOJI_LEFT)).length === 0, "showcase keeps its own nav; demo emoji replaced by icons");
    await page.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 20 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
