/* Phase 14 e2e: Free limits (3 salary months, 10 expenses, hidden statistics / contract / goal), admin Reset password,
 * profile Admin Console button, no zoom / sideways scroll / right-click.
 * Supabase mocked (admin_* RPC fixtures in mock-supabase.js, role via sessionStorage __mock_admin_role).
 * Run: node tests/e2e/phase13.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8814, BASE = `http://localhost:${PORT}`;
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
const months = n => Array.from({ length: n }, (_, i) => { const d = new Date(2026, 6 + i, 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); });
const salaryRecs = n => JSON.stringify(months(n).map(m => ({ month: m, salary: 3000000, rate: 0.024 })));
const expenseRecs = n => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: "e" + i, ts: Date.now() - i * 1000, cur: "KRW", name: "item" + i, cat: "", date: "2026-11-1" + (i % 5), amt: 1000, krw: 1000, thb: 24, rate: 0.024 })));
async function home(page, file = "index.html") { await page.goto(`${BASE}/${file}`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(1300); }
const upsell = page => page.evaluate(() => { const d = document.getElementById("kfpUpsell"); return d && !d.hidden ? d.textContent : ""; });
const stored = (page, k) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || "[]").length, k);

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("F1 Free: statistics, contract and savings goal are hidden; one upgrade card instead");
    let page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, Object.assign(member(), { [U + "salaryRecords"]: salaryRecs(2) }), { "__mock_plan_u-real": "free" });
    await home(page);
    ok(!(await vis(page, "#statsGrid")) && !(await vis(page, "#startDate")) && !(await vis(page, "#goal")), "สถิติการเงิน / สัญญาจ้าง / เป้าหมายเงินเก็บ hidden");
    ok(await vis(page, ".kfp-locked-card") && (await txt(page, ".kfp-locked-card")).includes("Finance Plus"), "upgrade card shown");
    ok((await txt(page, "#salaryHistory")).includes("ใช้ไป 2/3 เดือน"), "usage note 2/3");

    console.log("F2 Free: at most 3 salary months");
    await page.fill("#salaryMonth", "2026-12"); await page.fill("#salaryRecord", "3100000");
    await page.click('button[onclick^="addSalaryRecord("]'); await page.waitForTimeout(400);
    ok(await stored(page, "salaryRecords") === 3 && !(await upsell(page)), "3rd month saved");
    ok((await txt(page, "#salaryHistory")).includes("3/3"), "usage note 3/3");
    await page.fill("#salaryMonth", "2027-01"); await page.fill("#salaryRecord", "3200000");
    await page.click('button[onclick^="addSalaryRecord("]'); await page.waitForTimeout(400);
    const u1 = await upsell(page);
    ok(u1.includes("สูงสุด 3 เดือน") && u1.includes("ลบ") && await stored(page, "salaryRecords") === 3, "4th month refused with explanation (delete old or upgrade)");
    ok(await page.$eval('#kfpUpsell [data-up="go"]', a => a.getAttribute("href")) === "pricing.html#plus", "upgrade button → pricing");
    await shot(page, "p14_free_salary_limit");
    await page.click('#kfpUpsell [data-up="close"]');
    await page.fill("#salary", "2900000");
    await page.click('button[onclick^="saveThisMonthSalary("]'); await page.waitForTimeout(400);
    ok((await upsell(page)) !== "" && await stored(page, "salaryRecords") === 3, "“บันทึกเงินเดือนเดือนนี้” also limited");
    await page.click('#kfpUpsell [data-up="close"]');
    page.once("dialog", d => d.accept());
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('#salaryHistory [onclick^="deleteSalaryRecord("]'); await page.waitForTimeout(500);
    const left = await stored(page, "salaryRecords");
    await page.fill("#salaryMonth", "2027-01"); await page.fill("#salaryRecord", "3200000");
    await page.click('button[onclick^="addSalaryRecord("]'); await page.waitForTimeout(400);
    ok(left === 2 && await stored(page, "salaryRecords") === 3, "after deleting one, a new month can be saved");

    console.log("F3 Free: at most 10 expenses, no link to statistics");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, Object.assign(member(), { [U + "kfp_expenses_v1"]: expenseRecs(9) }), { "__mock_plan_u-real": "free" });
    await home(page);
    await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(500);
    ok(!(await vis(page, "#exCat")) && (await txt(page, ".kfp-ex-usage")).includes("9/10"), "no “หักจากการ์ดในสถิติการเงิน”; usage 9/10");
    await page.fill("#exName", "ค่าข้าว"); await page.fill("#exAmt", "9000"); await page.click('[data-act="ex-save"]'); await page.waitForTimeout(400);
    ok(await stored(page, "kfp_expenses_v1") === 10 && (await txt(page, ".kfp-ex-usage")).includes("10/10"), "10th expense saved");
    await page.fill("#exName", "ค่ารถ"); await page.fill("#exAmt", "1500"); await page.click('[data-act="ex-save"]'); await page.waitForTimeout(400);
    const u2 = await upsell(page);
    ok(u2.includes("สูงสุด 10 รายการ") && await stored(page, "kfp_expenses_v1") === 10, "11th refused (delete old or upgrade)");
    await shot(page, "p14_free_expense_limit");

    console.log("F4 Plus: everything back, no limits");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, Object.assign(member(), { [U + "salaryRecords"]: salaryRecs(5), [U + "kfp_expenses_v1"]: expenseRecs(12) }), { "__mock_plan_u-real": "plus" });
    await home(page);
    ok(await vis(page, "#statsGrid") && await vis(page, "#goal") && !(await vis(page, ".kfp-locked-card")), "statistics + goal visible");
    ok(!(await txt(page, "#salaryHistory")).includes("/3"), "no usage note");
    await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(500);
    ok(await vis(page, "#exCat") && !(await vis(page, ".kfp-ex-usage")), "statistics link + no limit in the expense popup");
    await page.fill("#exName", "x"); await page.fill("#exAmt", "100"); await page.click('[data-act="ex-save"]'); await page.waitForTimeout(400);
    ok(await stored(page, "kfp_expenses_v1") === 13, "13th expense saved on Plus");

    console.log("F5 admin: Reset password → red/green line");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "admin" });
    await open(page, "#users");
    await page.click(ROW(5)); await page.waitForTimeout(600);
    ok(await vis(page, '#userActs [data-act="reset_pw"]'), "Reset password button");
    await page.click('#userActs [data-act="reset_pw"]'); await page.waitForTimeout(300);
    ok((await txt(page, "#cfText")).includes("Aa123456"), "dialog says the default password");
    await page.fill("#cfReason", "ลืมรหัสผ่าน"); await page.click("#cfOk"); await page.waitForTimeout(900);
    const fc = page.fnCalls.find(c => c.name === "admin-actions");
    ok(fc && fc.body.action === "reset_password" && fc.body.user_id.endsWith("000000000005") && fc.body.reason === "ลืมรหัสผ่าน", "admin-actions reset_password called");
    const note = await page.evaluate(() => { const n = document.querySelector(".kfa-reset-note"); if (!n) return null;
      return { t: n.textContent, r: getComputedStyle(n.querySelector(".r")).color, g: getComputedStyle(n.querySelector(".g")).color }; });
    ok(note && note.t.replace(/\s+/g, " ").trim() === "reset password : Aa123456", "note text: reset password : Aa123456");
    ok(note && note.r === "rgb(255, 107, 107)" && note.g === "rgb(61, 220, 151)", "red label, green password");
    await shot(page, "p14_reset_pw");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "viewer" });
    await open(page, "#users");
    await page.click(ROW(5)); await page.waitForTimeout(600);
    ok(!(await vis(page, '[data-act="reset_pw"]')), "viewer: no Reset password");

    console.log("F6 profile popup: Admin Console button for staff only");
    for (const [role, tone] of [["owner", "gold"], ["viewer", "silver"], ["", ""]]) {
      page = await newPage(browser, { width: 390, height: 844 });
      await seed(page, member(), { "__mock_admin_role": role, "__mock_plan_u-real": role ? "premium" : "plus" });
      await home(page);
      await page.evaluate(() => window.kfpAuth.open("account")); await page.waitForTimeout(700);
      const a = await page.$eval("#kfpAdminLink", e => ({ href: e.getAttribute("href"), cls: e.className, t: e.textContent, h: e.getBoundingClientRect().height })).catch(() => null);
      if (role) ok(a && a.href === "admin.html" && a.cls.includes(tone) && a.t.includes(role.toUpperCase()) && a.t.includes("Admin Console") && a.h >= 44, `${role}: ${tone} Admin Console button`);
      else ok(!a, "member: no Admin button");
      if (role === "owner") await shot(page, "p14_profile_admin_btn");
    }

    console.log("F7 no zoom, no sideways scroll, no right-click");
    for (const file of ["index.html", "admin.html", "pricing.html", "gold.html"]) {
      page = await newPage(browser, { width: 390, height: 844 }, true);
      await seed(page, member(), { "__mock_admin_role": "owner" });
      await page.goto(`${BASE}/${file}`); await page.waitForTimeout(1300);
      const r = await page.evaluate(() => ({
        vp: document.querySelector('meta[name="viewport"]').content, over: document.documentElement.scrollWidth - window.innerWidth,
        ta: getComputedStyle(document.documentElement).touchAction,
        fs: (() => { const i = document.querySelector("input:not([type=hidden]),select"); return i ? parseFloat(getComputedStyle(i).fontSize) : 16; })() }));
      ok(/maximum-scale=1/.test(r.vp) && /user-scalable=no/.test(r.vp) && r.over <= 0 && /pan-x pan-y/.test(r.ta) && r.fs >= 16,
         `${file}: no zoom (${r.vp.length > 0}), no sideways scroll (${r.over}), inputs ${r.fs}px`);
    }
    page = await newPage(browser);
    await seed(page, member());
    await home(page);
    const g = await page.evaluate(() => {
      const ev = (el, type, init) => { const e = type === "keydown" ? new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init)) : new MouseEvent(type, { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
      return { page: ev(document.querySelector(".card"), "contextmenu"), input: ev(document.querySelector("#salary"), "contextmenu"),
        f12: ev(document.body, "keydown", { key: "F12", code: "F12" }), insp: ev(document.body, "keydown", { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true }),
        mac: ev(document.body, "keydown", { key: "ˆ", code: "KeyI", metaKey: true, altKey: true }), typing: ev(document.querySelector("#salary"), "keydown", { key: "i", code: "KeyI" }) };
    });
    ok(g.page && !g.input, "right-click blocked on the page, allowed in text fields");
    ok(g.f12 && g.insp && g.mac && !g.typing, "F12 / Ctrl+Shift+I / ⌘⌥I blocked, normal typing not");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
