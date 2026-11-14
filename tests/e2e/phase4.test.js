/* Phase 4 e2e: Global Login Gate.
 * Every saving / editing / deleting / calculating / exporting control is blocked for guests
 * (original handler never runs) and opens the auth modal; viewing controls stay free;
 * members are unaffected.   Run: node tests/e2e/phase4.test.js */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8796, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const MSG = "กรุณาเข้าสู่ระบบหรือสมัครสมาชิกเพื่อใช้งานฟีเจอร์นี้";

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

async function newPage(browser, { blockAuth = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: "block", acceptDownloads: true });
  const page = await ctx.newPage();
  page.dialogs = [];
  page.on("dialog", d => { page.dialogs.push(d.message()); d.accept(); });
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX|LightweightCharts|createChart|kfpAuth/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", route => {
    const u = route.request().url();
    if (u.includes("@supabase/supabase-js")) return route.fulfill({ contentType: "text/javascript", body: MOCK });
    if (blockAuth && /\/auth\.js/.test(u)) return route.abort();
    if (u.includes("/functions/v1/")) return route.fulfill({ status: 404, body: "" });
    if (u.startsWith(BASE)) return route.continue();
    return route.abort();
  });
  return page;
}
async function seed(page, items) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(items => { localStorage.clear(); sessionStorage.clear(); Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); }, items);
}
const member = () => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" });
async function open(page, file = "index.html") { await page.goto(`${BASE}/${file}`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(900); }
const modalOpen = page => page.$eval("#kfpAuthPanel", e => e.classList.contains("open")).catch(() => false);
const gateText = page => page.$eval("#kfpAuthGateMsg", e => e.hidden ? "" : e.textContent).catch(() => "");
async function closeModal(page) { if (await modalOpen(page)) { await page.click("#kfpAuthX"); await page.waitForTimeout(150); } }
const ls = (page, k) => page.evaluate(k => localStorage.getItem(k), k);
// Spy on global functions used by inline onclick="" handlers.
async function spy(page, names) {
  await page.evaluate(names => { window.__ran = []; names.forEach(n => { const f = window[n]; window[n] = function () { window.__ran.push(n); return f && f.apply(this, arguments); }; }); }, names);
}
const ran = page => page.evaluate(() => window.__ran || []);
async function shot(page, name) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png") }); }

async function expectGated(page, label, clickFn, sideEffect) {
  await closeModal(page);
  const before = sideEffect ? await sideEffect() : null;
  await clickFn();
  await page.waitForTimeout(250);
  const txt = await gateText(page);
  const after = sideEffect ? await sideEffect() : null;
  ok(await modalOpen(page) && txt.includes(MSG) && (!sideEffect || JSON.stringify(before) === JSON.stringify(after)),
     `${label} → login modal, nothing changed${txt.includes("ฟีเจอร์:") ? " (" + txt.split("ฟีเจอร์: ")[1] + ")" : ""}`);
  await closeModal(page);
}
async function expectFree(page, label, clickFn) {
  await closeModal(page);
  await clickFn(); await page.waitForTimeout(250);
  ok(!(await modalOpen(page)), `${label} → no gate`);
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("G1 index.html: guest actions are gated, handlers never run");
    let page = await newPage(browser);
    await seed(page, {});
    await open(page);
    await spy(page, ["calculate", "saveThisMonthSalary", "addSalaryRecord", "deleteSalaryRecord", "exportExcel", "saveContract", "setContractDuration", "deleteContract",
                     "updateExchangeRate", "convertCurrency", "swapConverter"]);
    await expectGated(page, "คำนวณ", () => page.click('button[onclick^="calculate("]'));
    await shot(page, "p4_gate_modal_pre");
    await page.click('button[onclick^="calculate("]'); await page.waitForTimeout(700); await shot(page, "p4_gate_modal"); await closeModal(page);
    await expectGated(page, "บันทึกเงินเดือนเดือนนี้", () => page.click('button[onclick^="saveThisMonthSalary("]'));
    await expectGated(page, "เพิ่มประวัติเงินเดือน", () => page.click('button[onclick^="addSalaryRecord("]'));
    await expectGated(page, "ลบประวัติเงินเดือน", () => page.click('button[onclick^="deleteSalaryRecord("]'), () => ls(page, "salaryRecords"));
    await expectGated(page, "Export Excel", () => page.click('button[onclick^="exportExcel("]'));
    await expectGated(page, "บันทึกสัญญา", () => page.click('button[onclick^="saveContract("]'));
    await expectGated(page, "ตั้งระยะสัญญา", () => page.click('button[onclick^="setContractDuration("]'));
    await expectGated(page, "ลบสัญญา", () => page.click('button[onclick^="deleteContract("]'), () => ls(page, "contractStartDate"));
    const r1 = await ran(page);
    ok(!r1.some(n => n !== "updateExchangeRate"), "no gated handler ran: " + JSON.stringify(r1));
    ok(page.dialogs.length === 0, "no alert()/confirm() from original handlers");

    console.log("G2 keyboard activation is gated too");
    await page.focus('button[onclick^="calculate("]'); await page.keyboard.press("Enter"); await page.waitForTimeout(250);
    ok(await modalOpen(page) && !(await ran(page)).includes("calculate"), "Enter on Calculate → modal, not run");
    await closeModal(page);

    console.log("G3 viewing / calculator controls stay free for guests");
    await expectFree(page, "เครื่องแปลงเงิน", () => page.click('button[onclick^="convertCurrency("]'));
    ok((await ran(page)).includes("convertCurrency"), "converter actually ran");
    await expectFree(page, "สลับ วอน/บาท", () => page.click('#modeSwitch [data-mode="THB"]'));
    await page.click('#modeSwitch [data-mode="KRW"]');
    await expectFree(page, "เปิดจัดการแบ่งเงิน", () => page.click("#btnManageAlloc"));
    await expectGated(page, "บันทึกการแบ่งเงิน", () => page.click("#allocSave"), () => ls(page, "kfp_alloc_v1"));
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);

    console.log("G4 work / expense popups: browse freely, actions gated");
    await expectFree(page, "เปิด popup บันทึกการเข้างาน", () => page.click('[data-open-tool="work"]'));
    await expectGated(page, "บันทึกเข้างานวันนี้", () => page.click('[data-act="m-today"]'));
    ok(await page.$('[data-view="wmenu"]') !== null, "work popup stayed on the menu (wizard not started)");
    await expectGated(page, "บันทึกเข้างานย้อนหลัง", () => page.click('[data-act="m-past"]'));
    await expectFree(page, "ประวัติการทำงาน", () => page.click('[data-act="m-hist"]'));
    await page.click("button.tl-day.has, button.tl-day.ot, button.tl-day.wknd"); await page.waitForTimeout(250);
    ok(await page.$('[data-view="wdetail"]') !== null, "can open a day's details");
    const wr = () => ls(page, "kfp_work_records_v1");
    await expectGated(page, "แก้ไขวันทำงาน", () => page.click('[data-act="w-edit"]'), wr);
    await expectGated(page, "ลบวันทำงาน", () => page.click('[data-act="w-del"]'), wr);
    ok(await page.$('[data-act="w-del-yes"]') === null, "delete confirmation never armed");
    await page.click(".tl-back"); await page.waitForTimeout(150); await page.click(".tl-back"); await page.waitForTimeout(150);
    await expectFree(page, "สรุปรายได้", () => page.click('[data-act="m-sum"]'));
    const dd = () => ls(page, "kfp_work_deductions_v1");
    await page.fill("#dedName", "ทดสอบ"); await page.fill("#dedAmt", "1000");
    await expectGated(page, "เพิ่มรายการหัก", () => page.click('[data-act="ded-add"]'), dd);
    await expectGated(page, "ลบรายการหัก", () => page.click('[data-act="ded-del"]'), dd);
    await expectGated(page, "บันทึกยอดเงินจริง", () => page.click('[data-act="rcv-save"]'), () => ls(page, "kfp_work_received_v1"));
    await page.click(".tl-back"); await page.waitForTimeout(150);
    await expectFree(page, "ตั้งค่า (ดู)", () => page.click('[data-act="m-set"]'));
    await expectGated(page, "บันทึกการตั้งค่า", () => page.click('[data-act="set-save"]'), () => ls(page, "kfp_work_settings_v1"));
    await expectGated(page, "คืนค่าเริ่มต้น", () => page.click('[data-act="set-reset"]'), () => ls(page, "kfp_work_settings_v1"));

    console.log("G5 Escape on the login modal does not also close the popup underneath");
    await page.click('[data-act="set-save"]'); await page.waitForTimeout(250);
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    ok(!(await modalOpen(page)) && await page.isVisible("#kfpTools"), "modal closed, work popup still open");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(400);
    const ex = () => ls(page, "kfp_expenses_v1");
    await page.fill("#exName", "ทดสอบ"); await page.fill("#exAmt", "1000");
    await expectGated(page, "บันทึกรายจ่าย", () => page.click('[data-act="ex-save"]'), ex);
    await expectFree(page, "สลับไปประวัติรายจ่าย", () => page.click('[data-act="ex-tab"][data-v="history"]'));
    await expectFree(page, "เลื่อนเดือน", () => page.click('[data-act="exm-prev"]'));
    await page.click('[data-act="exm-next"]'); await page.waitForTimeout(200);
    await expectGated(page, "แก้ไขรายจ่าย", () => page.click('[data-act="ex-edit"]'), ex);
    await expectGated(page, "ลบรายจ่าย", () => page.click('[data-act="ex-del"]'), ex);
    ok(await page.$('[data-act="ex-del-yes"]') === null, "expense delete never armed");
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);

    console.log("G6 modal content: message, Login + Create Account, switch, forgot, close");
    await page.click('button[onclick^="exportExcel("]'); await page.waitForTimeout(250);
    ok((await gateText(page)).includes("Export Excel"), "names the blocked feature");
    ok(await page.isVisible("#kfpLoginBtn") && await page.isVisible("#kfpOpenAddBtn"), "Login + Create Account buttons");
    await page.click("#kfpOpenAddBtn"); await page.waitForTimeout(200);
    ok(await page.isVisible("#kfpNewEmail") && (await gateText(page)).includes(MSG), "switched to register, message kept");
    await page.click("#kfpBackLoginBtn"); await page.click("#kfpOpenForgotBtn"); await page.waitForTimeout(150);
    ok(await page.isVisible("#kfpForgotEmail"), "forgot password reachable");
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    ok(!(await modalOpen(page)), "Escape closes");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(200);
    ok((await gateText(page)) === "", "opening Login normally shows no gate message");
    await closeModal(page);
    ok(await page.evaluate(() => requireAuth("ทดสอบ API")) === false && await modalOpen(page), "requireAuth() API returns false + opens modal");
    await closeModal(page);
    await page.evaluate(() => { const b = document.createElement("button"); b.id = "optIn"; b.textContent = "x"; b.setAttribute("data-requires-auth", "ฟีเจอร์ใหม่"); b.onclick = () => { window.__optin = 1; }; document.body.appendChild(b); });
    await expectGated(page, "data-requires-auth opt-in", () => page.click("#optIn"));
    ok(!(await page.evaluate(() => window.__optin)), "opt-in handler not run");

    console.log("G7 gold.html: guest actions gated, tools free");
    page = await newPage(browser);
    await seed(page, {});
    await open(page, "gold.html");
    const lots = () => ls(page, "kfp_gold_lots_v1");
    await page.fill("#quantity", "1"); await page.fill("#cost", "60000");
    await expectGated(page, "บันทึกการซื้อทอง (ปุ่ม)", () => page.click('#lotForm button[type="submit"]'), lots);
    await expectGated(page, "บันทึกการซื้อทอง (Enter)", async () => { await page.focus("#cost"); await page.keyboard.press("Enter"); }, lots);
    await expectGated(page, "ลบรอบซื้อ", () => page.click(".delete-lot"), lots);
    await expectGated(page, "ลบทั้งหมด", () => page.click("#clearGoldBtn"), lots);
    let downloaded = false; page.once("download", () => { downloaded = true; });
    await expectGated(page, "Export ทอง", () => page.click("#exportGoldBtn"));
    await page.waitForTimeout(300);
    ok(!downloaded, "no file downloaded");
    const st = () => ls(page, "kfp_gold_settings_v1");
    await expectGated(page, "บันทึกราคา GOLD2go", () => page.click("#saveGold2goQuoteBtn"), st);
    await expectGated(page, "ดึงราคา Auto", () => page.click("#autoGold2goBtn"), st);
    const before = await page.inputValue("#valuationSource");
    await expectGated(page, "เปลี่ยนแหล่งราคา (select)", () => page.selectOption("#valuationSource", before === "market" ? "gold2go" : "market"), st);
    ok(await page.inputValue("#valuationSource") === before, "select reverted to previous value");
    ok(page.dialogs.length === 0, "no confirm()/alert() from gold handlers");
    await expectFree(page, "เครื่องคิดราคาทอง", () => page.click("#buyCalcBtn"));
    await expectFree(page, "จำลองขาย", () => page.click(".simulate-btn"));
    await expectFree(page, "ปุ่มกราฟ", () => page.click("#chartFitBtn"));
    await shot(page, "p4_gold_gate");

    console.log("G8 members: gate never interferes");
    page = await newPage(browser);
    await seed(page, member());
    await open(page);
    ok(await page.evaluate(() => kfpStorage.mode) === "member", "member mode");
    await spy(page, ["calculate", "saveThisMonthSalary"]);
    await page.fill("#salary", "2700000");
    await page.click('button[onclick^="calculate("]'); await page.waitForTimeout(300);
    ok(!(await modalOpen(page)) && (await ran(page)).includes("calculate") && await ls(page, "salary") === "2700000", "calculate runs and saves");
    await page.click('[data-open-tool="expense"]'); await page.waitForTimeout(400);
    await page.fill("#exName", "ค่าข้าว"); await page.fill("#exAmt", "9000"); await page.click('[data-act="ex-save"]'); await page.waitForTimeout(300);
    ok((await ls(page, "kfp_expenses_v1") || "").includes("ค่าข้าว"), "expense saved");
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    await page.click('[data-open-tool="work"]'); await page.waitForTimeout(300);
    await page.click('[data-act="m-today"]'); await page.waitForTimeout(250);
    ok(await page.$('[data-view="wtype"]') !== null, "work wizard starts");
    await page.keyboard.press("Escape"); await page.waitForTimeout(250);
    ok(await page.evaluate(() => requireAuth("x")) === true, "requireAuth() → true for members");
    page = await newPage(browser);
    await seed(page, member());
    await open(page, "gold.html");
    await page.fill("#quantity", "0.25"); await page.fill("#cost", "16000");
    await page.click('#lotForm button[type="submit"]'); await page.waitForTimeout(300);
    ok(JSON.parse(await ls(page, "kfp_gold_lots_v1") || "[]").length === 1 && !(await modalOpen(page)), "member can add a gold lot");
    await page.selectOption("#valuationSource", "market"); await page.waitForTimeout(200);
    ok(JSON.parse(await ls(page, "kfp_gold_settings_v1") || "{}").valuationSource === "market", "member select change saved");

    console.log("G9 login from the gate → member, action now works");
    page = await newPage(browser);
    await seed(page, {});
    await open(page);
    await page.click('button[onclick^="saveThisMonthSalary("]'); await page.waitForTimeout(250);
    await page.fill("#kfpUsername", "a@gmail.com"); await page.fill("#kfpPassword", "Passw0rd1");
    await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.click("#kfpLoginBtn")]);
    await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(1200);
    ok(await page.evaluate(() => kfpStorage.mode) === "member", "now member");
    await page.fill("#salary", "2600000");
    await page.click('button[onclick^="saveThisMonthSalary("]'); await page.waitForTimeout(300);
    ok(!(await modalOpen(page)) && (await ls(page, "salaryRecords") || "").includes("2600000"), "saveThisMonthSalary works after login");
    console.log("G10 failed login does not unlock anything");
    page = await newPage(browser);
    await seed(page, {});
    await open(page);
    await page.click('button[onclick^="calculate("]'); await page.waitForTimeout(200);
    await page.fill("#kfpUsername", "a@gmail.com"); await page.fill("#kfpPassword", "wrong");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(500);
    await closeModal(page);
    await spy(page, ["calculate"]);
    await page.click('button[onclick^="calculate("]'); await page.waitForTimeout(250);
    ok(await modalOpen(page) && !(await ran(page)).includes("calculate"), "still gated after wrong password");

    console.log("G11 auth.js unavailable → fallback dialog, still blocked");
    page = await newPage(browser, { blockAuth: true });
    await seed(page, {});
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(900);
    await spy(page, ["calculate"]);
    await page.click('button[onclick^="calculate("]'); await page.waitForTimeout(250);
    ok(await page.isVisible("#kfpGateFallback") && (await page.textContent("#kfpGateFallback")).includes(MSG), "fallback dialog shown");
    ok(!(await ran(page)).includes("calculate"), "action still blocked");
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
