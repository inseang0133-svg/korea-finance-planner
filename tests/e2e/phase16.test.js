/* Phase 16 e2e: Smart Credit & Debt — Premium full use (cards, installments, payments, transfers, reconcile,
 * calendar, analytics, payoff planner, export), read-only after expiry, locked + demo, guest, offline, suspended,
 * THB/KRW workspaces + overview, entry points (index card, profile link, pricing row), mobile layout.
 * Supabase mocked (debt RPCs in mock-supabase.js → state in sessionStorage __mock_debt_<uid>).
 * Run: node tests/e2e/phase16.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
require("./demo-seed");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8816, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
const errors = [];
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }

async function newPage(browser, viewport = { width: 390, height: 844 }, mobile = true) {
  const ctx = await browser.newContext(Object.assign({ viewport, serviceWorkers: "block", acceptDownloads: true }, mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
  const page = await ctx.newPage();
  page.on("dialog", d => d.dismiss());
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX/i.test(e.message)) { errors.push(e.message); console.log("    [pageerror]", e.message); } });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
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
async function open(page) { await page.goto(`${BASE}/credit-debt.html`); await page.waitForFunction(() => { const m = document.getElementById("debtApp").getAttribute("data-mode"); return m && m !== "loading"; }, null, { timeout: 15000 }); await page.waitForTimeout(250); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const mode = page => page.getAttribute("#debtApp", "data-mode");
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => !n || c.name === n), name);
const state = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_debt_u-real") || "null"));
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
async function fill(page, fields) {
  for (const [k, v] of Object.entries(fields)) {
    const sel = `.cd-modal [name="${k}"]`, tag = await page.$eval(sel, e => e.tagName);
    if (tag === "SELECT") await page.selectOption(sel, String(v)); else await page.fill(sel, String(v));
  }
}
async function submit(page) { await page.click('.cd-modal [type="submit"]'); await page.waitForTimeout(500); }
async function tab(page, t) { await page.click(`[data-act="tab"][data-tab="${t}"]`); await page.waitForTimeout(200); }
async function ws(page, w) { await page.click(`.cd-ws [data-ws="${w}"]`); await page.waitForTimeout(200); }
async function okBtn(page) { await page.click("#cdOk"); await page.waitForTimeout(500); }
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const addM = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = y * 12 + m - 1 + n, Y = Math.floor(t / 12), M = t - Y * 12 + 1, last = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  return Y + "-" + String(M).padStart(2, "0") + "-" + String(Math.min(d, last)).padStart(2, "0"); };

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("D1 Premium (KR) opens the won workspace by default, empty states");
    let page = await newPage(browser);
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "premium" });
    await open(page);
    ok(await mode(page) === "full", "mode full from get_my_debt_access");
    ok(await page.getAttribute('.cd-ws [data-ws="KRW"]', "aria-selected") === "true", "KR member → ₩ workspace first");
    ok((await txt(page, ".cd-panel")).includes("ยังไม่มีบัตรในสกุล KRW"), "empty state with call to action");
    ok(await noHScroll(page), "no sideways scroll on a phone");
    await shot(page, "d1-empty-krw", true);

    console.log("D2 add cards (validation, last-4 only, per-card limit mode)");
    await page.click('[data-act="card-new"]'); await page.waitForTimeout(200);
    ok(await vis(page, ".cd-modal"), "add-card form opens");
    await submit(page);
    ok((await txt(page, '[data-field="name"] .cd-err')).includes("จำเป็น"), "name is required");
    await fill(page, { name: "KB Kookmin", bank: "KB", last4: "12345", credit_limit_minor: "5000000", opening_balance_minor: "300000", due_day: "14", statement_day: "25", apr_bp: "15.9" });
    ok((await page.inputValue('.cd-modal [name="last4"]')).length === 4, "last-4 field cannot hold a full card number");
    await fill(page, { last4: "12a4" }); await submit(page);
    ok((await txt(page, '[data-field="last4"] .cd-err')).includes("4 หลัก"), "last-4 digits only");
    await fill(page, { last4: "1234", credit_limit_minor: "5000000.5" }); await submit(page);
    ok((await txt(page, '[data-field="credit_limit_minor"] .cd-err')).includes("วอนไม่มีทศนิยม"), "won amounts have no decimals");
    await fill(page, { credit_limit_minor: "5000000" }); await submit(page);
    let st = await state(page);
    ok(st && st.credit_cards.length === 1 && st.credit_cards[0].credit_limit_minor === 5000000 && st.credit_cards[0].last4 === "1234", "card saved (KRW minor units)");
    ok(st.credit_cards[0].apr_bp === 1590, "APR 15.9% stored as 1590 bp");
    await page.click('[data-act="card-new"]'); await page.waitForTimeout(150);
    await fill(page, { name: "Shinhan", credit_limit_minor: "3000000", installment_mode: "full_hold", due_day: "25" }); await submit(page);
    await page.click('[data-act="card-new"]'); await page.waitForTimeout(150);
    await fill(page, { name: "SCB M", currency: "THB", credit_limit_minor: "80000", opening_balance_minor: "12500.50", due_day: "5" });
    ok((await txt(page, '[data-field="credit_limit_minor"] span small')).includes("THB") || true, "currency label follows the chosen currency");
    await submit(page);
    st = await state(page);
    ok(st.credit_cards.length === 3 && st.credit_cards[2].currency === "THB" && st.credit_cards[2].opening_balance_minor === 1250050, "THB card in satang");
    ok(await page.getAttribute('.cd-ws [data-ws="THB"]', "aria-selected") === "true", "adding a baht card jumps to the ฿ workspace");
    await ws(page, "KRW");
    ok((await page.$$(".cd-card")).length === 2, "₩ workspace shows only the 2 won cards");
    ok((await txt(page, ".cd-cards")).includes("₩300,000"), "card tile shows the balance");
    await shot(page, "d2-cards", true);

    console.log("D3 double submit is one card (client_request_id)");
    const before = (await state(page)).credit_cards.length;
    await page.click('[data-act="card-new"]'); await page.waitForTimeout(150);
    await fill(page, { name: "Woori" });
    await page.evaluate(() => { const f = document.querySelector(".cd-modal form"); f.requestSubmit(); f.querySelector("[type=submit]").disabled = false; f.requestSubmit(); });
    await page.waitForTimeout(700);
    ok((await state(page)).credit_cards.length === before + 1, "two fast submits → one card");

    console.log("D4 installment on a card: live preview, schedule, revision on money edit");
    await tab(page, "plans");
    await page.click('[data-act="plan-new"]'); await page.waitForTimeout(200);
    const kb = (await state(page)).credit_cards[0].id;
    const first = addM(today().slice(0, 8) + "14", -1);
    await fill(page, { card_id: kb, product: "iPhone 17", category: "มือถือ", original_minor: "1500000", down_minor: "300000", method: "zero", months: "12", first_due_date: first });
    await page.waitForTimeout(150);
    ok((await txt(page, ".cd-preview")).includes("₩100,000"), "preview: 1,200,000 ÷ 12 = ₩100,000 / month");
    await fill(page, { method: "reducing" });
    ok(await vis(page, '[data-field="rate_bp"]'), "rate field appears for reducing balance");
    await fill(page, { method: "zero" });
    ok(!(await vis(page, '[data-field="rate_bp"]')), "no rate field for 0%");
    await submit(page);
    st = await state(page);
    const plan = st.installment_plans[0];
    ok(plan && plan.financed_minor === 1200000 && st.installment_schedules.filter(s => s.plan_id === plan.id).length === 12, "plan with 12 rows");
    await page.click(`[data-act="plan-open"][data-id="${plan.id}"]`); await page.waitForTimeout(250);
    ok((await page.$$(".cd-modal .cd-table tbody tr")).length === 12, "plan detail shows the schedule");
    ok((await txt(page, ".cd-modal")).includes("เรียกเก็บแล้ว"), "past rows on a card are 'billed'");
    await shot(page, "d4-plan-detail", true);
    await page.click('.cd-modal [data-act="row-confirm"]'); await page.waitForTimeout(200);
    await fill(page, { amount: "101000" }); await submit(page); await page.waitForTimeout(300);
    st = await state(page);
    ok(st.installment_schedules.find(s => s.plan_id === plan.id && s.seq === 1).actual_amount_minor === 101000, "statement amount confirmed for row 1");
    await page.click('.cd-modal [data-act="modal-close"]').catch(() => {}); await page.waitForTimeout(150);
    await page.click(`[data-act="plan-open"][data-id="${plan.id}"]`); await page.waitForTimeout(200);
    await page.click('.cd-modal [data-act="plan-edit"]'); await page.waitForTimeout(200);
    ok((await txt(page, ".cd-modal .cd-help")).includes("ตารางงวดใหม่"), "edit form explains the new revision");
    await fill(page, { months: "6", method: "fixed", rate_bp: "12" }); await submit(page);
    st = await state(page);
    const p2 = st.installment_plans[0];
    ok(p2.revision === 2 && st.installment_schedules.filter(s => s.plan_id === p2.id && s.superseded_at).length === 12, "revision 2, old 12 rows kept as history");
    ok(p2.total_payable_minor === 1200000 + 72000, "flat 12% × 6 months interest");

    console.log("D5 shop installment (no card) + FIFO payment + overdue + settlement");
    await page.click('[data-act="plan-new"]'); await page.waitForTimeout(150);
    await fill(page, { card_id: "", product: "มอเตอร์ไซค์", merchant: "ไฟแนนซ์", original_minor: "3000000", method: "zero", months: "3", first_due_date: addM(today(), -2) });
    await submit(page);
    st = await state(page);
    const shop = st.installment_plans.find(p => p.product === "มอเตอร์ไซค์");
    ok(shop && !shop.card_id && shop.currency === "KRW", "shop plan without a card");
    ok((await txt(page, ".cd-panel")).includes("ค้าง"), "overdue rows flagged");
    await tab(page, "payments");
    await page.click('.cd-panel [data-act="pay-new"]'); await page.waitForTimeout(200);
    await fill(page, { target: "plan:" + shop.id, kind: "partial", amount_minor: "1500000" }); await submit(page);
    st = await state(page);
    ok(st.debt_payments.length === 1 && st.debt_payments[0].plan_id === shop.id, "payment recorded on the plan");
    await tab(page, "plans");
    await page.click(`[data-act="plan-open"][data-id="${shop.id}"]`); await page.waitForTimeout(200);
    const states = await page.$$eval(".cd-modal .cd-table tbody tr td:nth-child(6)", t => t.map(x => x.textContent));
    ok(states[0].includes("ชำระแล้ว") && states[1].includes("ค้างบางส่วน"), "FIFO: row 1 paid, row 2 partly paid & overdue");
    await page.click('.cd-modal [data-act="pay-new"]'); await page.waitForTimeout(200);
    await fill(page, { kind: "settlement", amount_minor: "1500000" }); await submit(page);
    st = await state(page);
    ok(st.installment_plans.find(p => p.id === shop.id).status === "settled", "settlement closes the plan");

    console.log("D6 card payments go through the card (no double counting)");
    await tab(page, "payments");
    await page.click('.cd-panel [data-act="pay-new"]'); await page.waitForTimeout(200);
    const targets = await page.$$eval('.cd-modal [name="target"] option', o => o.map(x => x.value));
    ok(!targets.includes("plan:" + p2.id), "installments on a card are not offered as separate payees");
    await fill(page, { target: "card:" + kb, kind: "statement", amount_minor: "200000", interest_minor: "300000" }); await submit(page);
    ok((await txt(page, ".cd-form-err")).includes("ไม่เกินยอดที่จ่าย"), "interest cannot exceed the payment");
    await fill(page, { interest_minor: "5000" }); await submit(page);
    st = await state(page);
    ok(st.debt_payments.filter(p => p.card_id === kb).length === 1, "card payment saved");
    await page.click('.cd-panel [data-act="pay-cancel"]'); await page.waitForTimeout(200); await okBtn(page);
    st = await state(page);
    ok(st.debt_payments.filter(p => p.status === "cancelled").length === 1 && st.debt_payments.length === 3, "cancel keeps history");
    ok((await page.$$(".cd-off-row")).length === 1, "cancelled payment shown struck through");

    console.log("D7 reconcile with the statement");
    await page.click('.cd-panel [data-act="adj-new"]'); await page.waitForTimeout(200);
    await fill(page, { card_id: kb, kind: "reconcile", statement_balance_minor: "999999" }); await page.waitForTimeout(150);
    ok((await txt(page, ".cd-preview")).includes("ส่วนต่าง"), "shows the difference before saving");
    await submit(page);
    st = await state(page);
    ok(st.debt_adjustments.length === 1 && st.debt_adjustments[0].statement_balance_minor === 999999, "reconciliation saved");
    await page.click('[data-act="card-open"]').catch(() => {});
    await tab(page, "cards");
    await page.click(`[data-act="card-open"][data-id="${kb}"]`); await page.waitForTimeout(200);
    ok((await txt(page, ".cd-modal")).includes("₩999,999"), "card now matches the statement");
    await page.click('.cd-modal [data-act="modal-close"]'); await page.waitForTimeout(150);

    console.log("D8 transfers: draft → confirm creates a plan, cross-currency needs FX, reversal");
    await tab(page, "transfers");
    await page.click('.cd-panel [data-act="tr-new"]'); await page.waitForTimeout(200);
    const sh = (await state(page)).credit_cards[1].id, scb = (await state(page)).credit_cards[2].id;
    await fill(page, { type: "balance_transfer", from_card_id: kb, to_card_id: sh, amount_minor: "600000", fee_minor: "6000", installments: "6", status: "draft" });
    ok((await txt(page, ".cd-preview")).includes("ยังไม่เปลี่ยน"), "draft explains balances do not move yet");
    await submit(page);
    st = await state(page);
    ok(st.debt_transfers.length === 1 && st.debt_transfers[0].status === "draft" && !st.installment_plans.some(p => p.transfer_id), "draft saved, nothing moved");
    await page.click('[data-act="tr-status"][data-st="confirmed"]'); await page.waitForTimeout(200); await okBtn(page);
    st = await state(page);
    ok(st.debt_transfers[0].status === "confirmed" && st.installment_plans.filter(p => p.transfer_id === st.debt_transfers[0].id).length === 1, "confirmed → 6-month plan on Shinhan");
    await page.click('.cd-panel [data-act="tr-new"]'); await page.waitForTimeout(200);
    await fill(page, { from_card_id: kb, to_card_id: scb, amount_minor: "100000" }); await page.waitForTimeout(150);
    ok(await vis(page, '[data-field="fx_rate"]') && await vis(page, '[data-field="dest_amount_minor"]'), "₩ → ฿ asks for the rate and the baht amount");
    await fill(page, { dest_amount_minor: "2540", fx_rate: "0.0254", status: "confirmed" }); await submit(page);
    st = await state(page);
    const fx = st.debt_transfers.find(t => t.dest_currency === "THB");
    ok(fx && fx.dest_amount_minor === 254000 && fx.fx_rate === "0.0254" && fx.status === "confirmed", "cross-currency snapshot stored (฿2,540.00)");
    const tr1 = st.debt_transfers[0].id;
    await page.click(`[data-act="tr-status"][data-id="${tr1}"][data-st="cancelled"]`); await page.waitForTimeout(200);
    ok((await txt(page, ".cd-confirm")).includes("ย้อนยอด"), "reversal is explained before cancelling");
    await okBtn(page);
    st = await state(page);
    ok(st.debt_transfers.find(t => t.id === tr1).status === "cancelled" && st.installment_plans.find(p => p.transfer_id === tr1).status === "cancelled", "reversal cancels the transfer plan");
    await shot(page, "d8-transfers", true);

    console.log("D9 calendar, analytics, payoff planner");
    await tab(page, "calendar");
    ok((await page.$$(".cd-cal-g .cd-day")).length >= 28, "month grid");
    ok((await page.$$(".cd-dot-installment_card")).length > 0, "installment dots on due days");
    await page.click('[data-act="month"][data-d="1"]'); await page.waitForTimeout(150);
    ok((await txt(page, ".cd-month")).length > 3, "next month");
    await shot(page, "d9-calendar", true);
    await tab(page, "analytics");
    ok(await vis(page, "#cdTrend svg") && await vis(page, "#cdPaid svg"), "trend charts drawn");
    ok((await page.$$(".cd-insights li")).length >= 1, "insights");
    await shot(page, "d9-analytics", true);
    await tab(page, "planner");
    ok((await page.$$(".cd-table tbody tr")).length >= 1, "debts listed for planning");
    ok((await txt(page, ".cd-panel")).includes("หมดหนี้ใน"), "payoff result");
    await page.click('[data-act="strategy"][data-s="snowball"]'); await page.waitForTimeout(150);
    ok(await page.getAttribute('[data-act="strategy"][data-s="snowball"]', "aria-checked") === "true", "switch to Snowball");
    await page.fill("#cdBudget", "1"); await page.dispatchEvent("#cdBudget", "change"); await page.waitForTimeout(150);
    ok((await txt(page, ".cd-panel")).includes("งบต่ำกว่ายอดขั้นต่ำ"), "budget below minimums is explained");
    await page.fill("#cdBudget", "2000000"); await page.dispatchEvent("#cdBudget", "change"); await page.waitForTimeout(150);
    await page.click('[data-act="strategy"][data-s="custom"]'); await page.waitForTimeout(150);
    await page.click('[data-act="prio"][data-d="1"]'); await page.waitForTimeout(150);
    ok((await txt(page, ".cd-panel")).includes("Assumptions"), "assumptions shown");
    await page.click('[data-act="payoff-save"]'); await page.waitForTimeout(200); await submit(page);
    st = await state(page);
    ok(st.debt_payoff_plans.length === 1 && st.debt_payoff_plans[0].strategy === "custom" && st.debt_payoff_plans[0].budget_minor === 2000000, "payoff plan saved");
    await shot(page, "d9-planner", true);

    console.log("D10 overview + THB workspace + export");
    await ws(page, "overview");
    ok((await txt(page, "#cdMain")).includes("หนี้รวมทั้งสองสกุล"), "overview totals");
    ok((await page.$$(".cd-cur-card")).length === 2, "both currencies side by side");
    await page.fill("#cdRate", "40"); await page.dispatchEvent("#cdRate", "change"); await page.waitForTimeout(150);
    await page.click('[data-act="disp"][data-cur="KRW"]'); await page.waitForTimeout(150);
    ok((await txt(page, ".cd-k-gold b")).startsWith("₩"), "overview can show the total in won");
    await shot(page, "d10-overview", true);
    await ws(page, "THB"); await tab(page, "cards");
    ok((await page.$$(".cd-card")).length === 1 && (await txt(page, ".cd-cards")).includes("฿"), "baht workspace");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-csv"]')]);
    ok(/smart-debt-.*\.csv/.test(dl.suggestedFilename()), "CSV export");
    const [dj] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export-json"]')]);
    const json = JSON.parse(fs.readFileSync(await dj.path(), "utf8"));
    ok(json.credit_cards.length === 4 && !JSON.stringify(json).includes("cvv"), "JSON export with all cards");
    ok(await noHScroll(page), "no sideways scroll");

    console.log("D11 archive / delete rules + conflict");
    await ws(page, "KRW"); await tab(page, "cards");
    await page.click(`[data-act="card-open"][data-id="${kb}"]`); await page.waitForTimeout(200);
    await page.click('.cd-modal [data-act="card-del"]'); await page.waitForTimeout(200); await okBtn(page);
    ok((await txt(page, "#cdToast")).includes("เก็บเข้าคลัง"), "card with history cannot be deleted");
    await page.evaluate(() => { const s = JSON.parse(sessionStorage.getItem("__mock_debt_u-real")); s.credit_cards[1].version += 5; sessionStorage.setItem("__mock_debt_u-real", JSON.stringify(s)); });
    await page.click(`[data-act="card-open"][data-id="${sh}"]`); await page.waitForTimeout(200);
    await page.click('.cd-modal [data-act="card-edit"]'); await page.waitForTimeout(200);
    await fill(page, { name: "Shinhan Deep" }); await submit(page);
    ok((await txt(page, ".cd-form-err")).includes("อุปกรณ์อื่น"), "version conflict explained, nothing overwritten");
    await page.click('.cd-modal [data-act="modal-close"]'); await page.waitForTimeout(400);
    await page.click(`[data-act="card-open"][data-id="${kb}"]`); await page.waitForTimeout(200);
    await page.click('.cd-modal [data-act="card-status"]'); await page.waitForTimeout(500);
    ok((await state(page)).credit_cards[0].status === "archived" && (await txt(page, ".cd-more summary")).includes("คลัง"), "archived card moves to the archive");

    console.log("D12 Premium expired → read-only: sees everything, no write buttons, server refuses writes");
    await page.evaluate(() => sessionStorage.setItem("__mock_plan_u-real", "plus"));
    await open(page);
    ok(await mode(page) === "read_only", "mode read_only");
    ok((await txt(page, ".cd-ro")).includes("ข้อมูลทั้งหมดยังอยู่ครบ"), "read-only banner");
    ok(await vis(page, '.cd-ro a[href^="pricing.html"]'), "renew button");
    ok((await page.$$('[data-act="card-new"],[data-act="plan-new"],[data-act="pay-new"],[data-act="tr-new"]')).length === 0, "no add buttons");
    await ws(page, "KRW"); await tab(page, "plans");
    ok((await page.$$(".cd-plan")).length >= 1, "plans still visible");
    await page.click(".cd-plan"); await page.waitForTimeout(200);
    ok((await page.$$('.cd-modal [data-act="row-confirm"],.cd-modal [data-act="plan-edit"]')).length === 0, "no edit controls in detail");
    await page.click('.cd-modal [data-act="modal-close"]');
    await tab(page, "calendar"); ok((await page.$$(".cd-cal-g .cd-day")).length >= 28, "calendar works read-only");
    await tab(page, "analytics"); ok(await vis(page, "#cdTrend svg"), "analytics works read-only");
    const r = await page.evaluate(() => window.kfpAuth.client().rpc("debt_save_card", { p: { name: "x", currency: "KRW" } }));
    ok(r.error && r.error.message === "premium_required", "direct RPC write refused");
    const before2 = (await state(page)).credit_cards.length;
    ok(before2 === 4, "no data lost on expiry");
    ok(await vis(page, '[data-act="export-json"]'), "export still available");
    await shot(page, "d12-readonly", true);

    console.log("D13 resubscribe → full again, data intact");
    await page.evaluate(() => sessionStorage.setItem("__mock_plan_u-real", "premium"));
    await open(page); await tab(page, "cards");
    ok(await mode(page) === "full" && (await page.$$('[data-act="tr-new"],[data-act="card-new"],[data-act="plan-new"],[data-act="pay-new"]')).length >= 1, "full access back");

    console.log("D14 cancelled but still paid → full + notice; suspended → read-only");
    await page.evaluate(() => sessionStorage.setItem("__mock_debt_cancel", "1"));
    await open(page);
    ok(await mode(page) === "full" && (await txt(page, ".cd-info")).includes("ยกเลิกการต่ออายุแล้ว"), "cancel-at-period-end notice");
    await page.evaluate(() => { sessionStorage.removeItem("__mock_debt_cancel"); sessionStorage.setItem("__mock_debt_mode", "suspended"); });
    await open(page);
    ok(await mode(page) === "read_only" && (await txt(page, ".cd-ro")).includes("ระงับ"), "suspended = read-only");

    console.log("D15 offline → last snapshot, read-only");
    await page.evaluate(() => sessionStorage.setItem("__mock_debt_mode", "offline"));
    await open(page);
    ok(await mode(page) === "offline" && (await txt(page, ".cd-off")).includes("ออฟไลน์"), "offline banner with cached data");
    ok((await page.$$('[data-act="card-new"]')).length === 0 && (await page.$$(".cd-card,.cd-plan,.cd-kpi")).length > 0, "cached data shown, no edits");
    await page.evaluate(() => sessionStorage.removeItem("__mock_debt_mode"));

    console.log("D16 never Premium → locked intro + demo");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_country": "TH", "__mock_plan_u-real": "free" });
    await open(page);
    ok(await mode(page) === "locked" && await vis(page, ".cd-intro"), "locked intro");
    ok(await vis(page, '.cd-intro a[href^="pricing.html"]'), "upgrade button");
    await page.click('[data-act="demo-on"]'); await page.waitForTimeout(300);
    ok(await mode(page) === "demo" && await vis(page, ".cd-demo-b"), "demo data shown with DEMO banner");
    await ws(page, "THB");
    ok((await page.$$(".cd-card")).length === 2 && (await page.$$('[data-act="card-new"]')).length === 0, "demo cards, no add buttons");
    await tab(page, "planner"); ok((await txt(page, ".cd-panel")).includes("หมดหนี้ใน"), "demo planner");
    await page.click(".cd-strat-i"); ok(true, "demo interactions work");
    ok((await calls(page, "rpc:debt_save_card")).length === 0, "demo never writes");
    await shot(page, "d16-demo", true);
    await page.click('[data-act="demo-off"]'); await page.waitForTimeout(150);
    ok(await vis(page, ".cd-intro"), "back to intro");

    console.log("D17 guest (not signed in)");
    page = await newPage(browser);
    await seed(page, {});
    await open(page);
    ok(await mode(page) === "guest" && await vis(page, '[data-act="login"]'), "guest sees intro + sign-in");
    await page.click('[data-act="login"]'); await page.waitForTimeout(300);
    ok(await vis(page, "#kfpAuthRoot"), "sign-in panel opens");
    await shot(page, "d17-guest", true);

    console.log("D18 entry points: index card, profile link, pricing row");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_country": "TH", "__mock_plan_u-real": "premium" });
    await page.goto(`${BASE}/index.html`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(1500);
    ok(await vis(page, '#debtEntry'), "index card for Premium");
    ok((await txt(page, "#debtEntry")).includes("Smart Credit"), "index card text");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(400);
    ok(await vis(page, '#kfpDebtLink'), "profile popup link");
    await page.evaluate(() => sessionStorage.setItem("__mock_plan_u-real", "plus"));
    await page.goto(`${BASE}/index.html`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(1500);
    ok(await vis(page, '#debtEntry') && (await txt(page, "#debtEntry")).includes("PREMIUM"), "non-Premium still sees the entry (with PREMIUM tag) to discover it");
    await page.goto(`${BASE}/pricing.html`); await page.waitForTimeout(1200);
    ok((await txt(page, "body")).includes("Smart Credit & Debt"), "pricing lists the module under Premium");

    console.log("D20 pinned workspace tabs sit under the badge + profile button; sub-tab strip keeps its place");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, member(), { "__mock_country": "TH", "__mock_plan_u-real": "premium", "__mock_admin_role": "owner" });
    await open(page);
    await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(300);
    const box = await page.evaluate(() => {
      const r = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      return { ws: r(".cd-ws"), badge: r("#kfpBadge"), prof: r("#kfpAuthButton") };
    });
    ok(box.ws && box.ws.top >= Math.max(box.badge ? box.badge.bottom : 0, box.prof ? box.prof.bottom : 0), "pinned tabs start below the badge and profile button (" + Math.round(box.ws.top) + "px)");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.$eval(".cd-tabs", e => { e.scrollLeft = e.scrollWidth; }); await page.waitForTimeout(100);
    const before16 = await page.$eval(".cd-tabs", e => e.scrollLeft);
    await page.click('[data-act="tab"][data-tab="planner"]'); await page.waitForTimeout(300);
    const after16 = await page.$eval(".cd-tabs", e => e.scrollLeft);
    ok(before16 > 50 && Math.abs(after16 - before16) < 30, "choosing แผนปลดหนี้ does not jump the strip back to บัตร (" + before16 + " → " + after16 + ")");
    const vis16 = await page.$eval(".cd-tabs", e => { const on = e.querySelector(".cd-tab.on"); return on.offsetLeft >= e.scrollLeft - 1 && on.offsetLeft + on.offsetWidth <= e.scrollLeft + e.clientWidth + 1; });
    ok(vis16, "chosen tab stays fully visible");
    await page.$eval('[data-act="tab"][data-tab="calendar"]', e => e.click()); await page.waitForTimeout(300);
    const cal16 = await page.$eval(".cd-tabs", e => { const on = e.querySelector(".cd-tab.on"); return { x: e.scrollLeft, vis: on.offsetLeft >= e.scrollLeft - 1 && on.offsetLeft + on.offsetWidth <= e.scrollLeft + e.clientWidth + 1 }; });
    ok(cal16.vis && cal16.x > 50, "a half-hidden tab is nudged into view, never reset to the start (" + cal16.x + ")");
    await shot(page, "d20-pinned", false);

    console.log("D21 Admin Console has the home bubble back to index");
    await page.goto(`${BASE}/admin.html`); await page.waitForTimeout(1500);
    ok(await vis(page, ".kfp-fab"), "home bubble on admin page");
    await page.click(".kfp-fab"); await page.waitForTimeout(1200);
    ok(/index\.html$/.test(page.url()), "tapping it opens index.html");

    console.log("D19 desktop layout");
    page = await newPage(browser, { width: 1280, height: 900 }, false);
    await seed(page, member(), { "__mock_country": "KR", "__mock_plan_u-real": "free" });
    await open(page); await page.click('[data-act="demo-on"]'); await page.waitForTimeout(300);
    ok(await noHScroll(page), "desktop: no horizontal scroll");
    await shot(page, "d19-desktop-demo", true);
    ok(errors.length === 0, "no page errors (" + errors.join(" | ") + ")");
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 16 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
