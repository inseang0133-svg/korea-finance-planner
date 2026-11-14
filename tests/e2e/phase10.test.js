/* Phase 10 e2e: Admin Console (admin.html) — gate, overview, users, detail + actions, revenue, prices, audit.
 * Supabase mocked (admin_* RPC fixtures in mock-supabase.js, role via sessionStorage __mock_admin_role).
 * Run: node tests/e2e/phase10.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8803, BASE = `http://localhost:${PORT}`;
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
  page.fnCalls = []; page.alerts = 0;
  page.on("dialog", d => { page.alerts++; d.dismiss(); });
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    const m = /\/functions\/v1\/([a-z-]+)/.exec(u);
    if (m) {
      page.fnCalls.push({ name: m[1], body: JSON.parse(r.request().postData() || "{}"), auth: r.request().headers()["authorization"] });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ changed: true, status: "active", cancel_at_period_end: true }) });
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

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("A1 guest → sign-in screen, no admin data requested");
    let page = await newPage(browser);
    await seed(page, {});
    await open(page);
    ok(await vis(page, "#gate") && (await txt(page, "#gateTitle")).includes("ผู้ดูแลระบบ") && !(await vis(page, "#app")), "gate shown, console hidden");
    ok((await calls(page)).filter(c => /rpc:admin_/.test(c.name)).length === 0, "no admin RPC for guests");
    await page.click("#gateLogin"); await page.waitForTimeout(250);
    ok(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")), "login opens the auth panel");

    console.log("A2 member who is not an admin → refused by the server");
    page = await newPage(browser);
    await seed(page, member());
    await open(page);
    ok((await txt(page, "#gateTitle")).includes("ไม่มีสิทธิ์") && !(await vis(page, "#app")), "403 screen");
    ok((await calls(page, "rpc:admin_whoami")).length === 1 && (await calls(page, "rpc:admin_overview")).length === 0, "only whoami was asked; nothing else loaded");
    await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(400);
    ok(!(await page.$("#kfpAdminLink")), "no Admin link in the account panel");

    console.log("A3 admin: overview");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "admin" });
    await open(page);
    ok(await vis(page, "#app") && (await txt(page, "#whoRole")) === "admin" && (await txt(page, "#whoEmail")) === "a@gmail.com", "console + role badge");
    ok((await txt(page, "#kTotal")).includes("1,234") && (await txt(page, "#kToday")).includes("7") && (await txt(page, "#kPremium")).includes("134"), "user KPIs");
    const mrr = await txt(page, "#kMrr");
    ok(mrr.includes("฿32,250") && mrr.includes("₩712,000") && mrr.includes("THB") && mrr.includes("KRW"), "MRR per currency (฿32,250 · ₩712,000), not summed");
    ok((await txt(page, "#kArr")).includes("฿387,000") && (await txt(page, "#kChurn")).includes("5.1%") && (await txt(page, "#kArpu")).includes("฿161.25"), "ARR, churn, ARPU");
    ok((await txt(page, "#kCancelling")).includes("12") && (await txt(page, "#kPastDue")).includes("9") && (await txt(page, "#kExpired")).includes("40"), "subscription states");
    ok((await page.$$("#kActivity .actbar span")).length === 5 && (await txt(page, "#kActivity")).includes("Dormant"), "activity distribution");
    await shot(page, "p10_overview", true);
    await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(500);
    ok(await page.$eval("#kfpAdminLink", a => a.getAttribute("href")).catch(() => "") === "admin.html", "admins get an Admin link in the account panel");
    await page.evaluate(() => window.kfpAuth.close());

    console.log("A4 users: server-side search / filter / sort / pagination; text is escaped");
    await page.click("#tab-users"); await page.waitForTimeout(600);
    ok((await page.$$("#userRows tr[data-user]")).length === 25 && (await txt(page, "#userCount")).includes("61") && (await txt(page, "#pgInfo")).includes("1 / 3"), "25 of 61, page 1/3");
    ok(page.alerts === 0 && (await page.$$("#userRows img")).length === 0 && (await txt(page, ROW(5))).includes("<img src=x"), "HTML in a username shown as text");
    await page.click("#pgNext"); await page.waitForTimeout(400);
    ok((await calls(page, "rpc:admin_list_users")).pop().args.p.page === 2 && (await txt(page, "#pgInfo")).includes("2 / 3"), "next page → page 2 requested");
    await page.fill("#fQ", "user7"); await page.waitForTimeout(700);
    let last = (await calls(page, "rpc:admin_list_users")).pop().args.p;
    ok(last.q === "user7" && last.page === 1 && (await page.$$("#userRows tr[data-user]")).length === 1, "search debounced, back to page 1");
    await page.fill("#fQ", ""); await page.selectOption("#fPlan", "premium"); await page.waitForTimeout(700);
    last = (await calls(page, "rpc:admin_list_users")).pop().args.p;
    ok(last.plan === "premium" && !last.q && (await page.$$eval("#userRows .pill.premium", x => x.length)) >= 20, "plan filter sent to the server");
    await page.selectOption("#fSort", "email"); await page.click("#fDir"); await page.waitForTimeout(700);
    last = (await calls(page, "rpc:admin_list_users")).pop().args.p;
    ok(last.sort === "email" && last.dir === "asc", "sort + direction");
    await page.selectOption("#fPlan", ""); await page.selectOption("#fSort", "created_at"); await page.waitForTimeout(700);
    await shot(page, "p10_users");

    console.log("A5 user detail + actions (confirmation, reason, typed e-mail for destructive ones)");
    await page.click(ROW(1)); await page.waitForTimeout(500);
    ok(await page.$eval("#drawer", d => d.open) && (await txt(page, "#drTitle")) === "user1@mail.test", "drawer opened");
    ok((await txt(page, "#drSubs")).includes("sub_TEST001") && (await txt(page, "#drBody")).includes("cus_TEST001") && (await txt(page, "#drPays")).includes("in_TEST1"), "Stripe subscription/customer/invoice ids");
    ok((await txt(page, "#drPays")).includes("คืน ฿50") && !(await page.$('#drPays a[href^="javascript"]')), "refund shown, javascript: link dropped");
    ok((await txt(page, "#drAudit")).includes("<b>bold?</b>") && (await txt(page, "#drAct")).includes("gold.html"), "audit reason as text, activity history");
    await shot(page, "p10_detail");
    await page.click('[data-act="grant_premium"]'); await page.waitForTimeout(250);
    ok(await page.$eval("#cf", d => d.open) && (await txt(page, "#cfTitle")).includes("ให้ Finance Premium"), "confirmation dialog");
    await page.fill("#cfReason", "x"); await page.click("#cfOk"); await page.waitForTimeout(250);
    ok((await txt(page, "#cfErr")).includes("เหตุผล") && (await calls(page, "rpc:admin_set_plan")).length === 0, "reason required → nothing sent");
    await page.selectOption("#cfDays", "90"); await page.fill("#cfReason", "beta tester reward"); await page.click("#cfOk"); await page.waitForTimeout(700);
    let sp = (await calls(page, "rpc:admin_set_plan")).pop();
    const days = sp && (new Date(sp.args.p_expires_at) - Date.now()) / 86400000;
    ok(sp && sp.args.p_plan === "premium" && days > 89 && days < 91 && sp.args.p_reason === "beta tester reward", "admin_set_plan(premium, +90 days, reason)");
    ok(!(await page.$eval("#cf", d => d.open)) && (await txt(page, ".toast")).includes("ให้ Premium แล้ว"), "toast + dialog closed");
    await page.click('[data-act="suspend"]'); await page.waitForTimeout(250);
    ok(await vis(page, "#cfTypeBox") && (await txt(page, "#cfTypeWant")) === "user1@mail.test", "destructive → type the e-mail");
    await page.fill("#cfReason", "chargeback investigation"); await page.fill("#cfType", "someone@else"); await page.click("#cfOk"); await page.waitForTimeout(250);
    ok((await calls(page, "rpc:admin_set_suspended")).length === 0 && (await txt(page, "#cfErr")).includes("พิมพ์อีเมล"), "wrong e-mail → refused locally");
    await page.fill("#cfType", "USER1@mail.test"); await page.click("#cfOk"); await page.waitForTimeout(700);
    const sus = (await calls(page, "rpc:admin_set_suspended")).pop();
    ok(sus && sus.args.p_suspended === true && (await txt(page, "#drIds")).includes("ถูกระงับ") && await vis(page, '[data-act="reactivate"]'), "suspended → badge + reactivate button");
    await page.click('[data-act="cancel_sub"]'); await page.waitForTimeout(250);
    await page.selectOption("#cfMode", "now"); await page.fill("#cfReason", "fraud confirmed"); await page.fill("#cfType", "user1@mail.test");
    await page.click("#cfOk"); await page.waitForTimeout(700);
    const fc = page.fnCalls.find(c => c.name === "admin-actions");
    ok(fc && fc.body.action === "cancel_subscription" && fc.body.mode === "now" && fc.body.user_id.endsWith("000000000001") && fc.auth === "Bearer at-a@gmail.com", "cancel → admin-actions Edge Function with the admin's token");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    ok(!(await page.$eval("#drawer", d => d.open)), "Escape closes the drawer");
    await page.click(ROW(2)); await page.waitForTimeout(500);
    ok(await vis(page, "#actLocked") && (await txt(page, "#actLocked")).includes("Owner"), "admin cannot act on another admin (owner only)");
    await page.click("#drClose");

    console.log("A6 revenue (per currency) · prices (KRW is zero-decimal) · audit (escaped)");
    await page.click("#tab-revenue"); await page.waitForTimeout(600);
    ok((await txt(page, "#revTHB")).includes("฿32,250") && (await txt(page, "#revKRW")).includes("₩712,000") && (await txt(page, "#revTHB")).includes("−฿500"), "currency cards with refunds");
    ok((await page.$$(".bar")).length === 3 && (await txt(page, "#revFailed")).includes("Card declined") && (await txt(page, "#revRefunds")).includes("in_TEST1"), "monthly bars, failed payments, refunds");
    await shot(page, "p10_revenue", true);
    await page.click("#tab-prices"); await page.waitForTimeout(600);
    ok((await page.$$("#priceTable tbody tr")).length === 8 && (await txt(page, "#priceTable")).includes("ยังไม่เปิดขาย"), "8 price slots, missing ones flagged");
    await page.click('[data-price="plus:year:KRW"]'); await page.waitForTimeout(250);
    await page.fill("#cfAmt", "59000"); await page.fill("#cfReason", "launch KRW yearly"); await page.click("#cfOk"); await page.waitForTimeout(600);
    let pr = (await calls(page, "rpc:admin_set_price")).pop();
    ok(pr && pr.args.p_currency === "KRW" && pr.args.p_interval === "year" && pr.args.p_amount_minor === 59000, "KRW 59,000 sent as 59000 (not ×100)");
    await page.click('[data-price="plus:month:THB"]'); await page.waitForTimeout(250);
    ok(await page.$eval("#cfAmt", i => i.value) === "149", "current THB price pre-filled (149)");
    await page.fill("#cfAmt", "149.50"); await page.fill("#cfReason", "price update"); await page.click("#cfOk"); await page.waitForTimeout(600);
    pr = (await calls(page, "rpc:admin_set_price")).pop();
    ok(pr && pr.args.p_amount_minor === 14950, "THB 149.50 → 14950 satang");
    await page.click("#tab-audit"); await page.waitForTimeout(600);
    ok(page.alerts === 0 && (await page.$$("#auRows img, #auRows script")).length === 0 && (await txt(page, "#auRows")).includes("onerror=alert"), "audit reason with HTML rendered as text");
    await page.click("#auRows details summary"); await page.waitForTimeout(150);
    ok((await txt(page, "#auRows pre.json")).includes("</pre><script>"), "before/after JSON shown as text");

    console.log("A7 viewer: read-only");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "viewer" });
    await open(page, "#users");
    ok((await txt(page, "#whoRole")) === "viewer" && (await page.$$("#userRows tr[data-user]")).length === 25, "viewer can read the user list (#users deep link)");
    await page.click(ROW(1)); await page.waitForTimeout(500);
    ok(await vis(page, "#actLocked") && !(await page.$("#userActs")), "no action buttons for viewers");
    await page.click("#drClose");
    await page.click("#tab-prices"); await page.waitForTimeout(500);
    ok((await page.$$("[data-price]")).length === 0, "no price editing for viewers");

    console.log("A8 own account: cannot act on self");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "owner" });
    await open(page, "#users");
    await page.fill("#fQ", "a@gmail"); await page.waitForTimeout(700);
    await page.click('[data-user="u-real"]'); await page.waitForTimeout(500);
    ok((await txt(page, "#actLocked")).includes("ตัวเอง"), "self → locked");

    console.log("A9 mobile 380px");
    page = await newPage(browser, { width: 380, height: 820 });
    await seed(page, member(), { "__mock_admin_role": "admin" });
    await open(page);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "overview: no horizontal scroll");
    await page.click("#tab-users"); await page.waitForTimeout(600);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1) &&
       await page.$eval("#userTable thead", t => getComputedStyle(t).display === "none"), "users: table becomes cards, no horizontal scroll");
    await shot(page, "p10_mobile_users");
    await page.click(ROW(1)); await page.waitForTimeout(500);
    const small = await page.$$eval("#userActs .btn, .dr-head .x", bs => bs.filter(b => b.getBoundingClientRect().height < 34).length);
    ok(small === 0 && await page.evaluate(() => document.getElementById("drawer").getBoundingClientRect().width <= window.innerWidth), "drawer fits, buttons tappable");
    await shot(page, "p10_mobile_detail");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
