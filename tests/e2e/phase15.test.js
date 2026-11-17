/* Phase 15 e2e: country decides the page (TH = baht, KR = won) + data conversion, pie card after คำนวณ, pinned badge,
 * Premium monthly digest pop-ups (work + expenses, fireworks), add-ons on pricing / account.
 * Supabase mocked (admin_* RPC fixtures in mock-supabase.js, role via sessionStorage __mock_admin_role).
 * Run: node tests/e2e/phase13.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
require("./demo-seed");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8815, BASE = `http://localhost:${PORT}`;
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

async function newPage(browser, viewport = { width: 1280, height: 900 }, mobile = false) {
  const ctx = await browser.newContext(Object.assign({ viewport, serviceWorkers: "block" }, mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
  const page = await ctx.newPage();
  page.fnCalls = []; page.alerts = 0;
  page.on("dialog", d => { page.alerts++; d.dismiss(); });
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    const m = /\/functions\/v1\/([a-z-]+)/.exec(u);
    if (m) {
      page.fnCalls.push({ name: m[1], body: JSON.parse(r.request().postData() || "{}"), auth: r.request().headers()["authorization"] });
      const reqBody = JSON.parse(r.request().postData() || "{}");
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reqBody.action === "reset_password" ? { reset: true, password: "Aa123456" } : { changed: true, status: "active", cancel_at_period_end: true }) });
    }
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
async function open(page, hash = "") { await page.goto(`${BASE}/admin.html${hash}`); await page.waitForTimeout(1100); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => !n || c.name === n), name);
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
const ROW = (i) => `[data-user="00000000-0000-4000-8000-${String(i).padStart(12, "0")}"]`;
const U = "kfp:u:u-real:";
async function home(page, file = "index.html", wait = 1500) { await page.goto(`${BASE}/${file}`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(wait); }
const html = (page, a) => page.evaluate(a => document.documentElement.getAttribute(a), a);
const lsj = (page, k) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || "null"), k);
const at = (page, iso) => page.addInitScript(t => { window.__kfpDigestNow = t; }, iso);

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("K1 sign-up needs a country");
    let page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, {});
    await home(page);
    await page.evaluate(() => window.kfpAuth.open("register")); await page.waitForTimeout(400);
    const opts = await page.$$eval("#kfpNewCountry option:not([disabled])", o => o.map(x => x.value).join(","));
    ok(opts === "TH,KR", "only ไทย / เกาหลีใต้ to choose");
    await page.fill("#kfpNewEmail", "new@gmail.com"); await page.fill("#kfpNewUsername", "newbie");
    await page.fill("#kfpNewPassword", "Passw0rd1"); await page.fill("#kfpNewPassword2", "Passw0rd1");
    await page.click("#kfpCreateBtn"); await page.waitForTimeout(300);
    ok((await txt(page, "#kfpAuthStatus")).includes("กรุณาเลือกประเทศ") && (await calls(page, "signUp")).length === 0, "no country → not sent");
    ok(await vis(page, "#modeSwitch"), "guests still have the ₩/฿ switch");

    console.log("K2 old account without a country must pick one in the profile");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, Object.assign(member(), { [U + "rate"]: "0.025" }), { "__mock_country": "none", "__mock_plan_u-real": "plus" });
    await home(page);
    ok(await vis(page, "#modeSwitch") && !(await html(page, "data-country")), "no country yet → switch still there");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(500);
    ok(await vis(page, "#kfpCountryReq") && await page.$eval("#kfpCountry", e => e.classList.contains("kfp-need") && e.value === ""), "profile: required notice + highlighted select");
    await page.click("#kfpAuthX"); await page.waitForTimeout(300);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    ok(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")), "cannot close (× / Esc) before choosing");
    await shot(page, "p15_country_required");
    await page.selectOption("#kfpCountry", "TH"); await page.click("#kfpSaveProfileBtn"); await page.waitForTimeout(700);
    const upd = (await calls(page, "update:profiles")).pop();
    ok(upd && upd.args.country === "TH", "saved country = TH");
    ok(await html(page, "data-country") === "TH" && await html(page, "data-mode") === "THB" && !(await vis(page, "#modeSwitch")), "page is now Thai (baht), switch gone");
    await page.click("#kfpAuthX"); await page.waitForTimeout(300);
    ok(!(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open"))), "closes after choosing");

    console.log("K3 Korean account: won page; baht data converted at today's rate");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, Object.assign(member(), {
      [U + "rate"]: "0.025", [U + "kfp_mode_v1"]: "THB", [U + "salaryThb"]: "50000",
      [U + "salaryRecords"]: JSON.stringify([{ month: "2026-09", currency: "THB", thb: 50000, salary: 0, rate: 0 }, { month: "2026-10", salary: 3000000, rate: 0.024 }]),
      [U + "kfp_expenses_v1"]: JSON.stringify([{ id: "x1", ts: 1, cur: "THB", name: "ข้าว", cat: "", date: "2026-10-03", rate: 0.025, amt: 250, thb: 250, krw: 10000 }])
    }), { "__mock_country": "KR", "__mock_plan_u-real": "plus" });
    await home(page);
    const recs = await lsj(page, "salaryRecords"), exs = await lsj(page, "kfp_expenses_v1");
    ok(await html(page, "data-country") === "KR" && await html(page, "data-mode") === "KRW" && !(await vis(page, "#modeSwitch")), "won page, no switch");
    const rt = Number(recs.find(r => r.month === "2026-09").rate);   // today's rate (the page refreshes it on load)
    ok(rt > 0 && recs.length === 2 && recs.every(r => r.currency !== "THB") && recs.find(r => r.month === "2026-09").salary === Math.round(50000 / rt), `฿50,000 → ₩${Math.round(50000 / rt).toLocaleString()} (÷ today's rate ${rt})`);
    ok(exs[0].cur === "KRW" && exs[0].amt === Math.round(250 / rt) && exs[0].thb === 250, "expense ฿250 → won at the same rate, baht kept");
    ok(await page.inputValue("#salary") === String(Math.round(50000 / rt)), "salary box filled in won");
    ok(!!(await lsj(page, "kfp_currency_backup_v1")), "original data kept as a backup");

    console.log("K4 switch the profile KR → TH: won data uses its approximate baht");
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click("#kfpAuthButton"); await page.waitForTimeout(500);
    await page.selectOption("#kfpCountry", "TH"); await page.click("#kfpSaveProfileBtn"); await page.waitForTimeout(900);
    const recs2 = await lsj(page, "salaryRecords"), exs2 = await lsj(page, "kfp_expenses_v1");
    ok(await html(page, "data-mode") === "THB" && recs2.every(r => r.currency === "THB"), "all salary months now in baht");
    ok(recs2.find(r => r.month === "2026-10").thb === 72000 && exs2[0].cur === "THB" && exs2[0].amt === 250, "₩3,000,000 × 0.024 = ฿72,000 · expense back to ฿250");
    ok((await txt(page, "#kfpAuthStatus")).includes("แปลงข้อมูล"), "member told about the conversion");

    console.log("P1 สัดส่วนการเงิน only after คำนวณ");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, Object.assign(member(), { [U + "salary"]: "2500000", [U + "rate"]: "0.025" }), { "__mock_country": "KR", "__mock_plan_u-real": "plus" });
    await home(page);
    ok(!(await vis(page, "#pieCard")), "hidden on load (salary saved but not calculated)");
    await page.click('button[onclick^="calculate("]'); await page.waitForTimeout(600);
    ok(await vis(page, "#pieCard"), "shown after คำนวณ");

    console.log("B1 badge pinned like the account chip, bigger FREE");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "free" });
    await home(page);
    const b = await page.evaluate(() => { const e = document.getElementById("kfpBadge"), t = e.querySelector(".kfb-text");
      return { pos: getComputedStyle(e).position, left: e.getBoundingClientRect().left, fs: parseFloat(getComputedStyle(t).fontSize) }; });
    await page.evaluate(() => window.scrollTo(0, 1200)); await page.waitForTimeout(300);
    const top2 = await page.$eval("#kfpBadge", e => e.getBoundingClientRect().top);
    ok(b.pos === "fixed" && top2 < 30, "stays on screen while scrolling");
    ok(b.left >= 16 && b.fs >= 18, `further from the edge (${Math.round(b.left)}px), FREE ${b.fs}px`);

    console.log("D1 Premium: work summary on the chosen day, then expenses (fireworks), once a month");
    page = await newPage(browser, { width: 390, height: 844 });
    await at(page, "2026-11-12T09:00:00");
    const work = [
      { date: "2026-10-01", type: "normal", reg: 8, ot: 2, krw: 120000, thb: 3000, otInc: 30000 },
      { date: "2026-10-04", type: "weekend", reg: 8, ot: 0, krw: 124000, thb: 3100, otInc: 0 },
      { date: "2026-10-09", type: "holiday", reg: 8, ot: 1, krw: 140000, thb: 3500, otInc: 15000 },
      { date: "2026-10-10", type: "day_off", reg: 0, ot: 0, krw: 0, thb: 0 },
      { date: "2026-11-02", type: "normal", reg: 8, ot: 0, krw: 82560, thb: 2064 }];
    const ex = (id, m, d, amt) => ({ id, ts: 1, cur: "KRW", name: id, cat: "", date: `2026-${m}-${d}`, rate: 0.025, amt, krw: amt, thb: amt * 0.025 });
    await seed(page, Object.assign(member(), {
      [U + "kfp_work_settings_v1"]: JSON.stringify({ wage: 10320, normal: 1, ot: 1.5, weekend: 1.5, holiday: 1.5, notifyDay: 10 }),
      [U + "kfp_work_records_v1"]: JSON.stringify(work),
      [U + "kfp_expenses_v1"]: JSON.stringify([ex("ค่าเช่า", "10", "01", 300000), ex("กาแฟ", "10", "05", 50000), ex("ค่าเช่า9", "09", "01", 400000)])
    }), { "__mock_country": "KR", "__mock_plan_u-real": "premium" });
    await home(page, "index.html", 3200);
    ok(await vis(page, '#kfpDigest[data-kind="work"]'), "work summary pops up (day 12 ≥ notify day 10)");
    await page.waitForTimeout(1300);
    const w = await txt(page, "#kfpDigest");
    ok(w.includes("ตุลาคม 2569") && w.includes("₩384,000") && w.includes("12 ชม.") === false && w.includes("27 ชม.") && w.includes("3 วัน") && w.includes("3 ชม."),
       "last month: ₩384,000 · 27 h · 3 work days · OT 3 h");
    ok(/เสาร์-อาทิตย์\s*1 วัน/.test(w) && /วันหยุด\s*1 วัน/.test(w), "1 weekend day, 1 holiday");
    ok(await page.$eval("#kfpDigest .kdg-fx", c => c.width > 0), "fireworks canvas running");
    await shot(page, "p15_digest_work");
    await page.click('#kfpDigest [data-kdg="ok"]'); await page.waitForTimeout(900);
    ok(await vis(page, '#kfpDigest[data-kind="exp"]'), "then the expense summary");
    await page.waitForTimeout(1300);
    const e = await txt(page, "#kfpDigest");
    ok(e.includes("₩350,000") && e.includes("2 รายการ") && e.includes("ประหยัดขึ้น 12.5%") && e.includes("₩50,000"), "₩350,000 · 2 items · saved 12.5% (₩50,000) vs September");
    await shot(page, "p15_digest_expense");
    await page.click('#kfpDigest [data-kdg="ok"]'); await page.waitForTimeout(500);
    const seen = await lsj(page, "kfp_digest_seen_v1");
    ok(seen && seen.work === "2026-11" && seen.exp === "2026-11", "marked as shown for November");
    await home(page, "index.html", 3200);
    ok(!(await vis(page, "#kfpDigest")), "not shown again the same month");

    console.log("D2 before the notify day only the expense summary · Plus gets none");
    page = await newPage(browser, { width: 390, height: 844 });
    await at(page, "2026-11-05T09:00:00");
    await seed(page, Object.assign(member(), {
      [U + "kfp_work_settings_v1"]: JSON.stringify({ notifyDay: 10 }), [U + "kfp_work_records_v1"]: JSON.stringify(work),
      [U + "kfp_expenses_v1"]: JSON.stringify([ex("a", "10", "01", 1000), ex("b", "09", "01", 500)])
    }), { "__mock_country": "KR", "__mock_plan_u-real": "premium" });
    await home(page, "index.html", 3200);
    ok(await vis(page, '#kfpDigest[data-kind="exp"]') && (await txt(page, "#kfpDigest")).includes("ใช้มากขึ้น 100.0%"), "day 5 < 10: expense summary only (spent 100% more)");
    page = await newPage(browser, { width: 390, height: 844 });
    await at(page, "2026-11-12T09:00:00");
    await seed(page, Object.assign(member(), {
      [U + "kfp_work_settings_v1"]: JSON.stringify({ notifyDay: 10 }), [U + "kfp_work_records_v1"]: JSON.stringify(work),
      [U + "kfp_expenses_v1"]: JSON.stringify([ex("a", "10", "01", 1000)])
    }), { "__mock_country": "KR", "__mock_plan_u-real": "plus" });
    await home(page, "index.html", 3200);
    ok(!(await vis(page, "#kfpDigest")), "Plus: no pop-ups");
    await page.click('[data-open-tool="work"]'); await page.waitForTimeout(400);
    await page.click('[data-go="wset"], [data-act="go"][data-v="wset"]').catch(() => {});
    await page.evaluate(() => { const b = [...document.querySelectorAll("#kfpTools button")].find(x => /ตั้งค่า/.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(400);
    ok(!(await vis(page, "#sNotify")) && (await txt(page, "#kfpTools")).includes("Finance Premium"), "Plus: notify-day setting locked (Premium only)");

    console.log("A1 add-ons on the pricing page");
    page = await newPage(browser, { width: 1280, height: 900 });
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "free" });
    await home(page, "pricing.html", 1500);
    ok((await page.$$("#addonGrid .addon")).length === 6, "6 add-ons");
    const ag = await txt(page, "#addonGrid");
    ok(ag.includes("฿59") && ag.includes("฿69") && ag.includes("฿49") && (await txt(page, "#addon_work")).includes("ไม่รวมการแจ้งเตือนแบบป๊อปอัพรายเดือน"), "THB prices + popup note on expense/work add-ons");
    ok((await txt(page, "#premium")).includes("แจ้งเตือนสรุปรายเดือนแบบป๊อปอัพ") && (await page.$eval("#plus", e => e.querySelector("li.n") && [...e.querySelectorAll("li.n")].some(l => /ป๊อปอัพ/.test(l.textContent)))), "monthly pop-ups: Premium only");
    ok(!!(await page.$('#addon_expense [data-checkout]')) && !!(await page.$('#addon_salary [data-checkout]')), "Free can buy unlimited expenses / salary (limits lifted)");
    await page.click('#addon_gold [data-checkout]'); await page.waitForTimeout(500);
    const co = page.fnCalls.find(c => c.name === "create-checkout");
    ok(co && co.body.plan === "addon_gold" && co.body.interval === "month" && co.body.currency === "THB", "checkout for addon_gold, monthly THB");
    await page.click('#segCurrency [data-v="KRW"]'); await page.waitForTimeout(200);
    ok((await txt(page, "#addon_gold")).includes("ยังไม่เปิดขายเป็นเงินวอน"), "KRW price not set yet → not sold in won");
    await shot(page, "p15_pricing_addons", true);
    page = await newPage(browser, { width: 1280, height: 900 });
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "plus", "__mock_addons": JSON.stringify([{ id: "addon_gold", name: "พอร์ตทอง", status: "active" }]) });
    await home(page, "pricing.html", 1500);
    ok((await txt(page, "#addon_work")).includes("รวมในแพ็กเกจของคุณแล้ว") && (await txt(page, "#addon_gold")).includes("ใช้งานอยู่"), "Plus: work included, gold active");

    console.log("A2 account page lists add-ons, cancel one");
    page = await newPage(browser, { width: 390, height: 844 });
    const end = new Date(Date.now() + 20 * 86400000).toISOString();
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "free",
      "__mock_billing_u-real": JSON.stringify({ subscription: null, grants: [], has_customer: true, open_invoice: null,
        addons: [{ plan_id: "addon_gold", plan_name: "พอร์ตทอง", status: "active", currency: "THB", unit_amount_minor: 6900, cancel_at_period_end: false, current_period_end: end }] }) });
    await home(page, "account.html", 1500);
    ok(await vis(page, "#addonCard") && (await txt(page, "#addonList")).includes("พอร์ตทอง") && (await txt(page, "#addonList")).includes("฿69"), "add-on listed with price");
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('[data-addon-act="cancel"]'); await page.waitForTimeout(700);
    const ba = page.fnCalls.find(c => c.name === "billing-action");
    ok(ba && ba.body.action === "cancel" && ba.body.addon === "addon_gold", "billing-action cancel with addon id");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
