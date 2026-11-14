/* Phase 8 e2e: member billing page (account.html) — plan, status, dates, auto-renew,
 * payment history + receipts, upgrade / downgrade / cancel / resume / manage billing.
 * Supabase mocked (mock-supabase.js), Edge Functions mocked at the network level.
 * Run: node tests/e2e/phase8.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8801, BASE = `http://localhost:${PORT}`;
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

const DAY = 86400000, iso = (d) => new Date(Date.now() + d * DAY).toISOString();
const SUB = (o = {}) => ({ plan_id: "plus", plan_name: "Finance Plus", status: "active", billing_interval: "month", currency: "THB", unit_amount_minor: 12900,
  cancel_at_period_end: false, started_at: iso(-95), current_period_start: iso(-5), current_period_end: iso(25), trial_end: null, canceled_at: null, ended_at: null, provider: "stripe", ...o });
function payments(n, cur = "THB") {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: "pay" + i, created_at: iso(-30 * i - 1), paid_at: iso(-30 * i - 1), plan_id: "plus", billing_interval: "month", currency: cur,
    amount_due_minor: cur === "KRW" ? 5900 : 12900, amount_paid_minor: cur === "KRW" ? 5900 : 12900, amount_refunded_minor: 0, status: "paid", failure_reason: null,
    period_start: iso(-30 * i - 1), period_end: iso(-30 * i + 29), hosted_invoice_url: "https://invoice.stripe.com/i/" + i, invoice_pdf_url: "https://pay.stripe.com/invoice/" + i + "/pdf" });
  return out;
}

// fn: { portal?: {status, body}, action?: {status, body} | (body, page) => Promise<{status, body}> }
async function newPage(browser, fn = {}, viewport = { width: 420, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.fnCalls = [];
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", async r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    const m = /\/functions\/v1\/(create-portal|billing-action|create-checkout)/.exec(u);
    if (m) {
      const body = JSON.parse(r.request().postData() || "{}");
      page.fnCalls.push({ name: m[1], body, auth: r.request().headers()["authorization"] });
      let spec = m[1] === "billing-action" ? fn.action : fn.portal;
      if (typeof spec === "function") spec = await spec(body, page);
      spec = spec || { status: 200, body: { url: `${BASE}/manifest.json?stripe=${m[1]}` } };
      return r.fulfill({ status: spec.status, contentType: "application/json", body: JSON.stringify(spec.body) });
    }
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const member = (email = "a@gmail.com", id = "u-real") => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-" + email, refresh_token: "rt", user: { id, email, email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": id });
const billing = (uid, b, pays, extra = {}) => ({ ["__mock_billing_" + uid]: JSON.stringify(b), ["__mock_payments_" + uid]: JSON.stringify(pays || []), ...extra });
async function openAccount(page, qs = "") {
  await page.goto(`${BASE}/account.html${qs}`);
  await page.waitForFunction(() => document.getElementById("planCard").getAttribute("aria-busy") === "false", null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(250);
}
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
async function shot(page, name, full = true) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: full }); }
const calls = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]"));

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("B1 guest → sign-in prompt, no billing request");
    let page = await newPage(browser);
    await seed(page, {});
    await openAccount(page);
    ok(await vis(page, "#guestBox") && (await txt(page, "#whoami")).includes("ยังไม่ได้เข้าสู่ระบบ"), "guest box");
    ok(!(await calls(page)).some(c => c.name === "rpc:get_my_billing"), "no get_my_billing call");
    await page.click("#loginBtn"); await page.waitForTimeout(250);
    ok(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")), "login opens the auth panel");
    ok(!(await vis(page, ".kfp-preview-pill")) && !(await vis(page, "#kfpPreviewBanner")), "no PREVIEW UI on this page");

    console.log("B2 Free member, never paid");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "free", ...billing("u-real", { subscription: null, grants: [], has_customer: false }, []) });
    await openAccount(page);
    ok((await txt(page, "#planName")) === "Free" && (await txt(page, "#planPill")).includes("แพ็กเกจฟรี"), "Free + pill");
    ok((await txt(page, "#factNext")).includes("ไม่มี") && !(await page.$("#factRenew .sw.on")), "no next charge, auto-renew off");
    ok(await page.$eval("#upgradeLink", a => a.getAttribute("href")) === "pricing.html" && !(await page.$("[data-portal-flow]")), "upgrade link, no Stripe button without a customer");
    ok(await vis(page, "#payEmpty") && (await txt(page, "#whoami")) === "a@gmail.com", "empty history, e-mail shown");
    ok(!(await vis(page, "#moreBtn")), "no 'load more' on an empty history");
    await shot(page, "p8_free");

    console.log("B3 active Plus (THB monthly): details, plan options, history with receipts");
    const pays = payments(12);
    pays[1].amount_refunded_minor = 5000; pays[1].status = "partially_refunded";
    pays[2].status = "failed"; pays[2].amount_paid_minor = 0; pays[2].failure_reason = "Your card was declined."; pays[2].invoice_pdf_url = null;
    pays[3].hosted_invoice_url = "javascript:alert(1)";                 // never rendered as a link
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "plus", ...billing("u-real", { subscription: SUB(), grants: [], has_customer: true, open_invoice: null }, pays) });
    await openAccount(page);
    ok((await txt(page, "#planName")) === "Finance Plus" && (await txt(page, "#planPill")).includes("ใช้งานอยู่"), "plan + status");
    ok((await txt(page, "#planPrice")).includes("฿129") && (await txt(page, "#planPrice")).includes("/ เดือน"), "price ฿129 / เดือน");
    const nextDay = new Date(Date.now() + 25 * DAY).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
    ok((await txt(page, "#factNext")).includes(nextDay), "next billing date = period end (" + nextDay + ")");
    ok((await txt(page, "#factExpiry")).includes("ไม่มีวันหมดอายุ") && await page.$("#factRenew .sw.on"), "no expiry while auto-renew is on");
    const opts = await page.$$eval("[data-switch]", bs => bs.map(b => b.dataset.switch + "|" + b.textContent));
    ok(opts.length === 3 && opts[0].startsWith("premium:month|อัปเกรด") && opts.some(o => o.startsWith("plus:year|") && o.includes("รายปี")) && opts.every(o => o.includes("฿")),
       "options: upgrade Premium (month/year) + Plus yearly, THB only");
    ok((await page.$$(".pay")).length === 10 && await vis(page, "#moreBtn") && (await txt(page, "#historyCount")).includes("12"), "first 10 of 12 payments + load more");
    const sel = (await calls(page)).find(c => c.name === "select:payments");
    ok(sel && sel.args.f.user_id === "u-real" && sel.args.r[0] === 0 && sel.args.r[1] === 9, "history query filtered by own user_id, range 0–9");
    ok(await page.$eval('.pay:nth-child(1) .links a', a => a.href) === "https://invoice.stripe.com/i/0" && (await txt(page, ".pay:nth-child(1) .links")).includes("ใบเสร็จ")
       && (await txt(page, ".pay:nth-child(1) .links")).includes("PDF"), "receipt + PDF links");
    ok((await txt(page, '.pay[data-status="partially_refunded"] .ref')).includes("฿50"), "refund shown (฿50)");
    ok((await txt(page, '.pay[data-status="failed"] .why')).includes("declined") && (await txt(page, '.pay[data-status="failed"] .pill')).includes("ไม่สำเร็จ"), "failed payment + reason");
    ok(!(await page.$('a[href^="javascript"]')) && (await page.$$(".pay:nth-child(4) .links a")).length === 1, "javascript: URL dropped (PDF link only)");
    await shot(page, "p8_active");
    await page.click("#moreBtn"); await page.waitForTimeout(300);
    ok((await page.$$(".pay")).length === 12 && !(await vis(page, "#moreBtn")), "load more → 12, button hidden");
    await Promise.all([page.waitForURL(/stripe=create-portal/), page.click('[data-switch="premium:month"]')]);
    let fc = page.fnCalls[0];
    ok(fc && fc.name === "create-portal" && fc.body.flow === "switch" && fc.body.plan === "premium" && fc.body.interval === "month" && fc.auth === "Bearer at-a@gmail.com",
       "upgrade → create-portal {flow: switch, premium, month} with the user's token");

    console.log("B4 cancel (two-step dialog) → cancelling state → resume");
    const subKey = "__mock_billing_u-real";
    const setCancel = (on) => async (body, pg) => {
      await pg.evaluate(([k, on]) => { const b = JSON.parse(sessionStorage.getItem(k)); b.subscription.cancel_at_period_end = on; sessionStorage.setItem(k, JSON.stringify(b)); }, [subKey, on]);
      return { status: 200, body: { changed: true, status: "active", cancel_at_period_end: on, current_period_end: iso(25) } };
    };
    page = await newPage(browser, { action: (body, pg) => setCancel(body.action === "cancel")(body, pg) });
    await seed(page, member(), { "__mock_plan_u-real": "plus", ...billing("u-real", { subscription: SUB(), grants: [], has_customer: true }, payments(2)) });
    await openAccount(page);
    await page.click('[data-action="cancel"]'); await page.waitForTimeout(250);
    ok(await page.$eval("#cancelDlg", d => d.open) && (await txt(page, "#cancelFacts")).includes(nextDay) && (await txt(page, "#cancelFacts")).includes("ข้อมูลทั้งหมดยังอยู่"), "dialog explains end date + data kept");
    await shot(page, "p8_cancel_dialog", false);
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    ok(!(await page.$eval("#cancelDlg", d => d.open)) && page.fnCalls.length === 0, "Escape → closed, nothing sent");
    ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === "cancel"), "focus back on the cancel button");
    await page.click('[data-action="cancel"]'); await page.waitForTimeout(150);
    await page.click('#cancelForm button[value="keep"]'); await page.waitForTimeout(150);
    ok(page.fnCalls.length === 0, "'ใช้ต่อ' → nothing sent");
    await page.click('[data-action="cancel"]'); await page.waitForTimeout(150);
    await page.selectOption("#cancelReason", "too_expensive");
    await page.click("#cancelConfirm"); await page.waitForTimeout(700);
    fc = page.fnCalls[0];
    ok(fc && fc.name === "billing-action" && fc.body.action === "cancel" && fc.body.feedback === "too_expensive", "billing-action {cancel, feedback}");
    ok((await txt(page, "#acStatus")).includes("ยกเลิกการต่ออายุแล้ว") && (await txt(page, "#planPill")).includes("ยกเลิกแล้ว"), "confirmation + pill 'ยกเลิกแล้ว · ใช้ได้ถึง'");
    ok(await vis(page, "#alertCancelling") && (await txt(page, "#factExpiry")).includes(nextDay) && !(await page.$("#factRenew .sw.on")), "end date as expiry, auto-renew off");
    ok((await txt(page, "#factNext")).includes("ไม่มี"), "no next charge");
    ok(await page.$$eval("[data-switch]", bs => bs.length > 0 && bs.every(b => b.disabled)) && await vis(page, "#lockedHint"), "plan change locked until resumed");
    await shot(page, "p8_cancelling");
    await page.click('#alertCancelling [data-action="resume"]'); await page.waitForTimeout(700);
    ok(page.fnCalls[1] && page.fnCalls[1].body.action === "resume" && (await txt(page, "#acStatus")).includes("เปิดต่ออายุอัตโนมัติแล้ว"), "resume → billing-action {resume}");
    ok((await txt(page, "#planPill")).includes("ใช้งานอยู่") && await page.$("#factRenew .sw.on") && !(await vis(page, "#alertCancelling")), "back to active, auto-renew on");

    console.log("B5 past_due: pay the open invoice / change card; no plan switch");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "plus", ...billing("u-real", { subscription: SUB({ status: "past_due" }), grants: [], has_customer: true,
      open_invoice: { hosted_invoice_url: "https://invoice.stripe.com/i/due", amount_due_minor: 12900, currency: "THB", status: "failed", failure_reason: "Insufficient funds" } }, payments(1)) });
    await openAccount(page);
    ok((await txt(page, "#planPill")).includes("ค้างชำระ") && (await txt(page, "#alertPastDue")).includes("Insufficient funds") && (await txt(page, "#alertPastDue")).includes("฿129"), "past_due alert with reason + amount");
    ok(await page.$eval("#payNowBtn", a => a.href) === "https://invoice.stripe.com/i/due", "pay-now → Stripe hosted invoice");
    ok(await page.$$eval("[data-switch]", bs => bs.every(b => b.disabled)), "switch disabled while past_due");
    await shot(page, "p8_past_due");
    await Promise.all([page.waitForURL(/stripe=create-portal/), page.click('#alertPastDue [data-portal-flow="payment_method"]')]);
    ok(page.fnCalls[0].body.flow === "payment_method", "change card → portal flow payment_method");

    console.log("B6 legacy 90-day grant (no payment)");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", "__mock_source": "legacy_launch",
      ...billing("u-real", { subscription: null, grants: [{ plan_id: "premium", reason: "legacy_launch", starts_at: iso(-30), expires_at: iso(60) }], has_customer: false }, []) });
    await openAccount(page);
    ok((await txt(page, "#planName")) === "Finance Premium" && (await txt(page, "#planPill")).includes("สมาชิกเดิม"), "Premium via legacy grant");
    ok((await txt(page, "#factExpiry")).includes("เหลือ 60 วัน") && (await txt(page, "#planPrice")).includes("ฟรี"), "expiry + days left, free");
    ok(await vis(page, "#alertGrant") && (await txt(page, "#upgradeLink")).includes("สมัครแพ็กเกจ"), "subscribe-to-keep prompt");
    await shot(page, "p8_grant");

    console.log("B7 KRW yearly Premium → only KRW options, downgrade labelled");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", ...billing("u-real", { subscription: SUB({ plan_id: "premium", plan_name: "Finance Premium", currency: "KRW", billing_interval: "year", unit_amount_minor: 89000 }), grants: [], has_customer: true }, payments(1, "KRW")) });
    await openAccount(page);
    ok((await txt(page, "#planPrice")).includes("₩89,000") && (await txt(page, "#planPrice")).includes("/ ปี"), "₩89,000 / ปี (zero-decimal)");
    const kopts = await page.$$eval("[data-switch]", bs => bs.map(b => b.dataset.switch + "|" + b.textContent));
    ok(kopts.length >= 2 && kopts.every(o => o.includes("₩")) && kopts.some(o => o.startsWith("plus:month|ดาวน์เกรด")) && kopts.some(o => o.startsWith("premium:month|")), "KRW options: downgrade to Plus, Premium monthly");
    ok((await txt(page, ".pay .a")).includes("₩5,900"), "KRW payment amount");

    console.log("B8 errors are explained, buttons usable again");
    page = await newPage(browser, { action: { status: 429, body: { error: "rate_limited" } }, portal: { status: 409, body: { error: "resume_first" } } });
    await seed(page, member(), { "__mock_plan_u-real": "plus", ...billing("u-real", { subscription: SUB(), grants: [], has_customer: true }, []) });
    await openAccount(page);
    await page.click('[data-switch="premium:month"]'); await page.waitForTimeout(500);
    ok((await txt(page, "#acStatus")).includes("ต่ออายุอัตโนมัติก่อน") && !(await page.$eval('[data-switch="premium:month"]', b => b.disabled)), "409 resume_first explained");
    await page.click('[data-action="resume"], [data-action="cancel"]'); await page.waitForTimeout(150);
    await page.click("#cancelConfirm"); await page.waitForTimeout(500);
    ok((await txt(page, "#acStatus")).includes("บ่อยเกินไป") && !(await page.$eval('[data-action="cancel"]', b => b.disabled)), "429 explained, button re-enabled");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "plus", "__mock_billing_mode": "missing" });
    await openAccount(page);
    ok(await vis(page, "#errorBox") && (await txt(page, "#errorBox")).includes("migration") && await vis(page, "#retryBtn"), "missing SQL function → clear message + retry");

    console.log("B9 back from the portal (?portal=updated) → message + URL cleaned + re-read");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", ...billing("u-real", { subscription: SUB({ plan_id: "premium", plan_name: "Finance Premium", unit_amount_minor: 19900 }), grants: [], has_customer: true }, []) });
    await openAccount(page, "?portal=updated");
    ok((await txt(page, "#acStatus")).includes("เปลี่ยนแพ็กเกจเรียบร้อย") && !page.url().includes("portal="), "message, URL cleaned");
    await page.waitForTimeout(3400);
    ok((await calls(page)).filter(c => c.name === "rpc:get_my_billing").length >= 2, "billing re-read after the redirect (webhook may lag)");

    console.log("B10 links: auth panel → account.html; mobile 360px");
    page = await newPage(browser, {}, { width: 360, height: 780 });
    await seed(page, member(), { "__mock_plan_u-real": "plus", ...billing("u-real", { subscription: SUB({ cancel_at_period_end: true }), grants: [], has_customer: true }, payments(3)) });
    await openAccount(page);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll at 360px");
    const small = await page.$$eval(".btn, .opt", els => els.filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).length);
    ok(small === 0, "all buttons ≥ 44px tall");
    await shot(page, "p8_mobile");
    await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(400);
    ok(await page.$eval("#kfpBillingLink", a => a.getAttribute("href")).catch(() => "") === "account.html", "auth panel plan line links to the billing page");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
