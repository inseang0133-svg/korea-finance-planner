/* Phase 5 e2e: plan-based visibility from server entitlements.
 * Run: node tests/e2e/phase5.test.js   (Supabase mocked: get_my_entitlements returns the plan set per test) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8797, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

async function newPage(browser, { width = 400 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept());
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX|LightweightCharts|createChart/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", route => {
    const u = route.request().url();
    if (u.includes("@supabase/supabase-js")) return route.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.includes("/functions/v1/")) return route.fulfill({ status: 404, body: "" });
    if (u.startsWith(BASE)) return route.continue();
    return route.abort();
  });
  return page;
}
const pad = n => String(n).padStart(2, "0");
function monthsBack(n) { const d = new Date(); const t = d.getFullYear() * 12 + d.getMonth() - n; return `${Math.floor(t / 12)}-${pad(t % 12 + 1)}`; }
const records = Array.from({ length: 23 }, (_, i) => ({ month: monthsBack(22 - i), salary: 2400000 + i * 1000, rate: 0.025 }));
const expenses = [0, 1, 2, 4].map((b, i) => ({ id: "e" + i, ts: i, cur: "KRW", name: "ex-" + b, cat: "", date: monthsBack(b) + "-05", rate: 0.025, amt: 1000, krw: 1000, thb: 25 }));
function memberSeed(extra) {
  return Object.assign({
    [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }),
    "__kfp_auth_user_v1": "u-real",
    "kfp:u:u-real:salary": "2500000", "kfp:u:u-real:salaryRecords": JSON.stringify(records), "kfp:u:u-real:kfp_expenses_v1": JSON.stringify(expenses),
    "kfp:u:u-real:kfp_gold_lots_v1": '[{"id":"g1","date":"2026-01-01","goldType":"96.5","quantity":1,"unit":"baht","grams":15.244,"costThb":60000}]'
  }, extra || {});
}
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
async function open(page, file = "index.html", wait = 1200) { await page.goto(`${BASE}/${file}`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(wait); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const attr = (page, a) => page.evaluate(a => document.documentElement.getAttribute(a), a);
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("V1 guest preview: every feature visible with demo data");
    let page = await newPage(browser);
    await seed(page, {});
    await open(page);
    ok(await attr(page, "data-plan-state") === "preview", "plan state = preview");
    ok(await vis(page, ".tool-work") && await vis(page, 'button[onclick^="exportExcel("]') && await vis(page, '.card[data-feature="advanced_statistics"]') && await vis(page, ".kfp-fab"), "work, export, charts, gold nav all visible");
    ok(!(await vis(page, '.kfp-locked-note[data-feature-off="advanced_statistics"]')), "no upgrade notes in preview");
    await open(page, "gold.html");
    ok(await vis(page, ".gold-hero") && !(await vis(page, "#kfpGoldUpsell")), "gold preview content (no upsell)");

    console.log("V2 Free member: work, export, charts, gold, cloud hidden; history limited; data kept");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_plan_u-real": "free" });
    await open(page);
    ok(await attr(page, "data-plan-state") === "ready" && await attr(page, "data-plan") === "free", "entitlements loaded from server: free");
    ok(!(await vis(page, ".tool-work")) && await vis(page, ".tool-exp"), "บันทึกการเข้างาน hidden, รายจ่าย shown");
    const tw = await page.$eval(".tool-exp", e => e.getBoundingClientRect().width), rw = await page.$eval(".tool-row", e => e.getBoundingClientRect().width);
    ok(tw > rw * 0.9, "expense button takes the full row");
    ok(!(await vis(page, 'button[onclick^="exportExcel("]')), "Export Excel hidden");
    ok(!(await vis(page, '.card[data-feature="advanced_statistics"]')) && !(await vis(page, "#salaryChart")) && !(await vis(page, "#savingChartBlock")), "charts hidden");
    ok(await vis(page, '.kfp-locked-note[data-feature-off="advanced_statistics"]'), "upgrade note in their place");
    ok(await vis(page, "#statsGrid"), "basic statistics still shown");
    ok(!(await vis(page, ".kfp-fab")), "floating gold button hidden");
    await page.selectOption("#filterYear", String(new Date().getFullYear() - 1)); await page.waitForTimeout(200);
    const note1 = await page.textContent("#salaryHistory");
    ok(note1.includes("ซ่อนประวัติที่เก่ากว่า 6 เดือน") && (await page.$$("#salaryHistory .history-item")).length === 0, "last year's records hidden with note");
    await page.selectOption("#filterYear", String(new Date().getFullYear())); await page.waitForTimeout(200);
    const months = await page.$$eval("#salaryHistory .history-item button", bs => bs.map(b => /'(\d{4}-\d{2})'/.exec(b.getAttribute("onclick"))[1]));
    ok(months.length > 0 && months.every(m => m >= monthsBack(5)), "this year shows only the last 6 months (" + months.length + ")");
    ok(JSON.parse(await page.evaluate(() => localStorage.getItem("salaryRecords"))).length === 23, "no salary record deleted");
    await shot(page, "p5_free_index", true);
    await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(400);
    await page.click('[data-act="ex-tab"][data-v="history"]'); await page.click('[data-act="exm-prev"]'); await page.waitForTimeout(200);
    ok(await page.$eval('[data-act="exm-prev"]', b => b.disabled) && await vis(page, ".tl-limit"), "expense history stops after 2 months with note");
    await shot(page, "p5_free_expense");
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    await page.click("#kfpAuthButton"); await page.waitForTimeout(300);
    ok((await page.textContent("#kfpPlanLine")).includes("Free") && (await page.textContent("#kfpPlanLine")).includes("อัปเกรด"), "account shows plan + upgrade link");
    ok(!(await vis(page, ".kfp-cloud-upload")) && await vis(page, '.kfp-locked-note[data-feature-off="cloud_sync"]'), "Cloud upload replaced by Plus note");
    await page.evaluate(() => document.getElementById("kfpUploadCloudBtn").click()); await page.waitForTimeout(300);
    const up = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_calls")).filter(c => c.name === "upsert:user_data").length);
    ok(up === 0 && (await page.textContent("#kfpAuthStatus")).includes("Finance Plus"), "forced upload click refused (no request sent)");
    await shot(page, "p5_free_account");
    await page.keyboard.press("Escape");
    await open(page, "gold.html");
    ok(await vis(page, "#kfpGoldUpsell") && !(await vis(page, ".gold-container")), "gold.html direct URL → upgrade screen, portfolio hidden");
    ok((await page.textContent("#kfpUpCur")).includes("Free"), "upgrade screen names current plan");
    await shot(page, "p5_gold_upsell");

    console.log("V3 Plus: everything except gold");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_plan_u-real": "plus" });
    await open(page);
    ok(await attr(page, "data-plan") === "plus", "plan = plus");
    ok(await vis(page, ".tool-work"), "work records visible");
    ok(await vis(page, 'button[onclick^="exportExcel("]'), "Export visible");
    // (canvases themselves stay blank here: Chart.js CDN is blocked in tests → check the plan-gated containers)
    ok(await vis(page, '.card[data-feature="advanced_statistics"]') && await vis(page, '[data-feature="advanced_statistics"] .chart-box'), "chart cards visible");
    ok(!(await vis(page, ".kfp-fab")), "gold button hidden");
    await page.selectOption("#filterYear", String(new Date().getFullYear() - 1)); await page.waitForTimeout(200);
    ok(!(await page.textContent("#salaryHistory")).includes("ซ่อนประวัติ") && (await page.$$("#salaryHistory .history-item")).length > 0, "full salary history");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(300);
    ok(await vis(page, ".kfp-cloud-upload"), "Cloud upload available");
    await page.click("#kfpUploadCloudBtn"); await page.waitForTimeout(400);
    const payload = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_calls")).filter(c => c.name === "upsert:user_data").pop());
    ok(payload && payload.args.data.salary === "2500000" && !("kfp_gold_lots_v1" in payload.args.data), "upload sent without gold keys");
    await page.keyboard.press("Escape");
    ok(await page.evaluate(() => requireFeature("gold_portfolio")) === false && await vis(page, "#kfpUpsell"), "requireFeature(gold) → upgrade dialog");
    ok((await page.textContent("#kfpUpsell")).includes("Finance Premium"), "dialog names Premium");
    await open(page, "gold.html");
    ok(await vis(page, "#kfpGoldUpsell") && !(await vis(page, ".gold-container")), "gold.html → upgrade screen");

    console.log("V4 Premium: everything incl. gold");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_plan_u-real": "premium" });
    await open(page);
    ok(await vis(page, ".kfp-fab") && await vis(page, ".tool-work"), "gold button + work visible");
    await open(page, "gold.html");
    ok(await vis(page, ".gold-hero") && !(await vis(page, "#kfpGoldUpsell")), "gold portfolio shown");
    ok((await page.textContent("#lotSummary")).includes("1 รอบ"), "member's own gold lot rendered");

    console.log("V5 while waiting for the server nothing plan-gated is shown");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_plan_u-real": "premium", "__mock_ent_mode": "slow" });
    await page.goto(`${BASE}/gold.html`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(500);
    ok(await attr(page, "data-plan-state") === "loading", "state = loading");
    ok(!(await vis(page, ".gold-container")) && !(await vis(page, "#kfpGoldUpsell")) && await vis(page, ".kfp-plan-loading"), "gold hidden, 'checking access' shown");
    await shot(page, "p5_gold_loading");
    await page.waitForTimeout(2800);
    ok(await attr(page, "data-plan-state") === "ready" && await vis(page, ".gold-container"), "then shown once the server confirms");

    console.log("V6 server unreachable → last server answer (≤7 days) or Free");
    await page.evaluate(() => sessionStorage.setItem("__mock_ent_mode", "error"));
    await open(page, "gold.html");
    ok(await attr(page, "data-plan-state") === "offline" && await attr(page, "data-plan") === "premium" && await vis(page, ".gold-container"), "offline: cached premium (from server) used");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_ent_mode": "error" });
    await open(page);
    ok(await attr(page, "data-plan-state") === "offline" && await attr(page, "data-plan") === "free" && !(await vis(page, ".tool-work")), "offline with no cache → Free");

    console.log("V7 a tampered local cache cannot grant features");
    page = await newPage(browser);
    await seed(page, memberSeed({ "kfp:u:u-real:__kfp_ent_cache_v1": JSON.stringify({ at: Date.now(), ent: { user_id: "u-real", plan: "premium", plan_name: "Finance Premium",
      features: { gold_portfolio: true, work_records: true, export: true, cloud_sync: true, advanced_statistics: true }, limits: {} } }) }), { "__mock_plan_u-real": "free" });
    await open(page);
    ok(await attr(page, "data-plan") === "free" && !(await vis(page, ".tool-work")) && !(await vis(page, ".kfp-fab")), "server answer (free) wins over edited cache");
    ok(JSON.parse(await page.evaluate(() => localStorage.getItem("__kfp_ent_cache_v1"))).ent.plan === "free", "cache overwritten with server answer");
    page = await newPage(browser);
    await seed(page, memberSeed({ "kfp:u:u-real:__kfp_ent_cache_v1": JSON.stringify({ at: Date.now(), ent: { user_id: "someone-else", plan: "premium", features: { gold_portfolio: true }, limits: {} } }) }), { "__mock_ent_mode": "error" });
    await open(page);
    ok(await attr(page, "data-plan") === "free", "cache of another user ignored");

    console.log("V8 migration 0400 not deployed yet → pre-SaaS behaviour (all visible)");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_ent_mode": "missing" });
    await open(page);
    ok(await attr(page, "data-plan-state") === "unconfigured" && await vis(page, ".tool-work") && await vis(page, ".kfp-fab"), "everything visible");

    console.log("V9 pricing page");
    page = await newPage(browser);
    await seed(page, memberSeed(), { "__mock_plan_u-real": "free" });
    await open(page);
    await page.click('.kfp-locked-note[data-feature-off="advanced_statistics"] a'); await page.waitForSelector("#plans .plan"); await page.waitForTimeout(1000);
    ok(page.url().endsWith("pricing.html#plus"), "upgrade link → pricing.html#plus");
    ok((await page.$$("#plans .plan")).length === 3, "3 plans from the plans table");
    ok((await page.textContent("#free")).includes("แพ็กเกจของคุณ"), "current plan (free) marked");
    ok((await page.textContent("#plus")).includes("฿129") && (await page.textContent("#premium")).includes("฿199"), "monthly THB prices");
    ok(!(await vis(page, "#kfpPreviewBanner")), "no demo banner on pricing");
    await page.click('#segInterval [data-v="year"]');
    ok((await page.textContent("#plus")).includes("฿1,290") && (await page.textContent("#saveBadge")).includes("17%"), "yearly THB + savings badge");
    await page.click('#segCurrency [data-v="KRW"]');
    ok((await page.textContent("#plus")).includes("—") && (await page.textContent("#plus")).includes("ประกาศ"), "KRW yearly not set yet → placeholder");
    await page.click('#segInterval [data-v="month"]');
    ok((await page.textContent("#plus")).includes("₩5,900") && (await page.textContent("#premium")).includes("₩8,900"), "monthly KRW prices");
    ok(!(await page.$eval("#premium .cta", b => b.disabled)) && (await page.textContent("#premium .cta")).includes("สมัคร"), "checkout button enabled (Phase 7)");
    await shot(page, "p5_pricing", true);
    page = await newPage(browser);
    await seed(page, {});
    await open(page, "pricing.html", 800);
    await page.click("[data-start=free]"); await page.waitForTimeout(250);
    ok(await page.isVisible("#kfpNewEmail"), "guest: เริ่มใช้ฟรี → register form");

    console.log("V10 mobile 360px: no horizontal scroll");
    for (const [plan, file] of [["free", "index.html"], ["plus", "gold.html"], ["free", "pricing.html"]]) {
      page = await newPage(browser, { width: 360 });
      await seed(page, memberSeed(), { "__mock_plan_u-real": plan });
      await open(page, file);
      ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${file} (${plan}) fits 360px`);
      if (file === "gold.html") await shot(page, "p5_gold_upsell_360");
    }
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
