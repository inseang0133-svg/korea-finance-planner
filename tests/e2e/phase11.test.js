/* Phase 11 e2e: activity tracking in the app (throttled, names only) + Admin "การใช้งาน" analytics.
 * Run: node tests/e2e/phase11.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8804, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }

async function newPage(browser, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.alerts = 0;
  page.on("dialog", d => { page.alerts++; d.dismiss(); });
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX|LightweightCharts|createChart/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.includes("/functions/v1/")) return r.fulfill({ status: 404, body: "" });
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
const member = () => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
async function open(page, file, wait = 1400) { await page.goto(`${BASE}/${file}`); await page.waitForTimeout(wait); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => !n || c.name === n), name);
const features = async (page) => (await calls(page, "rpc:touch_activity")).filter(c => c.args.p_kind === "feature").map(c => c.args.p_page);
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
async function closePopups(page) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("F1 member: page heartbeat + feature usage, throttled (not every click)");
    let page = await newPage(browser, { width: 420, height: 900 });
    await seed(page, member(), { "__mock_plan_u-real": "premium" });
    await open(page, "index.html");
    const beats = (await calls(page, "rpc:touch_activity")).filter(c => c.args.p_kind !== "feature");
    ok(beats.length === 1 && beats[0].args.p_page === "index.html" && beats[0].args.p_kind === "login", "one 'login' heartbeat for the page on open");
    for (let i = 0; i < 5; i++) { await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(120); await closePopups(page); }
    ok(JSON.stringify(await features(page)) === '["expenses"]', "5 clicks on รายจ่าย → 1 feature event");
    await page.click('[data-open-tool="work"]'); await page.waitForTimeout(150); await closePopups(page);
    await page.click('button[onclick^="exportExcel("]').catch(() => {}); await page.waitForTimeout(200);
    ok(JSON.stringify(await features(page)) === '["expenses","work_records","export"]', "work log + export tracked once each");
    const payload = (await calls(page, "rpc:touch_activity")).map(c => Object.keys(c.args).sort().join(",")).filter((v, i, a) => a.indexOf(v) === i);
    ok(payload.length === 1 && payload[0] === "p_kind,p_page", "only a page/feature NAME is sent (no content)");
    await page.reload(); await page.waitForTimeout(1400);
    ok((await calls(page, "rpc:touch_activity")).filter(c => c.args.p_kind !== "feature").length === 1, "reload within 5 minutes → no extra heartbeat");

    console.log("F2 gold page counts as a feature only when the plan allows it; Preview never tracks");
    await open(page, "gold.html", 1800);
    ok((await features(page)).includes("gold_portfolio"), "Premium on gold.html → gold_portfolio");
    page = await newPage(browser, { width: 420, height: 900 });
    await seed(page, member(), { "__mock_plan_u-real": "plus" });
    await open(page, "gold.html", 1800);
    ok(!(await features(page)).includes("gold_portfolio"), "Plus on gold.html (upgrade screen) → not counted");
    page = await newPage(browser, { width: 420, height: 900 });
    await seed(page, {});
    await open(page, "index.html");
    await page.click('[data-open-tool="expense"]').catch(() => {}); await page.waitForTimeout(200);
    ok((await calls(page, "rpc:touch_activity")).length === 0, "guest (Preview) → nothing tracked");

    console.log("F3 Admin → การใช้งาน");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "viewer" });
    await open(page, "admin.html#activity", 1600);
    ok(await vis(page, "#view-activity") && (await txt(page, "#aDau")).includes("140") && (await txt(page, "#aMau")).includes("900") && (await txt(page, "#aStick")).includes("16.7%"), "DAU / MAU / stickiness (150.5 ÷ 900)");
    ok((await page.$$("#aDauChart rect")).length === 30 && (await page.$$("#aSignChart rect")).length === 30, "30-day DAU + signup charts");
    ok((await page.$$("#aHours rect")).length === 24 && (await page.$$("#aWeek rect")).length === 7, "hour / weekday charts");
    ok((await txt(page, "#aFeatures")).includes("รายจ่าย") && (await txt(page, "#aFeatures")).includes("66.7%"), "feature adoption");
    ok(page.alerts === 0 && (await page.$$("#aPages b")).length === 0 && (await txt(page, "#aPages")).includes("<b>x</b>.html"), "page names shown as text");
    ok((await page.$$eval("#aRet td.c", tds => tds.filter(t => t.textContent === "—").length)) === 7 && (await txt(page, "#aRet")).includes("36%"), "retention: future weeks blank, past weeks %");
    ok((await txt(page, "#aByPlan")).includes("Finance Premium") && (await txt(page, "#acTime")).includes("แคช"), "by-plan table + cache note");
    await shot(page, "p11_activity", true);
    await page.selectOption("#acDays", "7"); await page.waitForTimeout(500);
    ok((await page.$$("#aDauChart rect")).length === 7 && (await calls(page, "rpc:admin_activity_analytics")).pop().args.p.days === 7, "range 7 days");
    await page.click("#acRefresh"); await page.waitForTimeout(500);
    ok((await calls(page, "rpc:admin_activity_analytics")).pop().args.p.refresh === true && (await txt(page, "#acTime")).includes("คำนวณเมื่อ"), "refresh bypasses the cache");
    await page.click('[data-bucket="dormant"]'); await page.waitForTimeout(700);
    ok(await vis(page, "#view-users") && await page.$eval("#fAct", s => s.value) === "dormant" && (await calls(page, "rpc:admin_list_users")).pop().args.p.activity === "dormant", "bucket → member list filtered by Dormant");
    await page.click("#tab-activity"); await page.waitForTimeout(300);
    await page.click('#aRisk tr[data-open-user]'); await page.waitForTimeout(600);
    ok(await page.$eval("#drawer", d => d.open) && (await txt(page, "#drTitle")) === "user4@mail.test", "at-risk row opens the member");
    ok((await page.$$("#drStrip .strip span")).length === 30 && (await txt(page, "#drStrip")).includes("ใช้งาน 10 จาก 30 วัน") && (await txt(page, "#drStrip")).includes("รายจ่าย"), "30-day activity strip in the drawer");
    await shot(page, "p11_drawer");
    await page.click("#drClose");

    console.log("F4 mobile 380px");
    page = await newPage(browser, { width: 380, height: 820 });
    await seed(page, member(), { "__mock_admin_role": "admin" });
    await open(page, "admin.html#activity", 1600);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll");
    await shot(page, "p11_mobile", true);
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
