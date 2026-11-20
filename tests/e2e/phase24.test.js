/* Phase 24 e2e: Guided tour ("วิธีใช้งานเว็บไซต์") — welcome, spotlight, controls, keyboard, interactive steps,
 * pop-up steps without saving, page changes, resume, help centre, fallbacks, resize, locked plans, no data changes.
 * Run: node tests/e2e/phase24.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8824, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const SHOTS = process.env.SHOT_DIR || "/tmp/kfp-shots"; fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
async function newPage(browser, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { page.errors.push(e.message); console.log("    [pageerror]", e.message); });
  page.on("dialog", d => { page.errors.push("native dialog: " + d.message()); d.dismiss(); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
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
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const count = page => txt(page, "#ktCount");
const title = page => txt(page, "#ktTitle");
// ready = not busy and the spring animation of the spotlight has finished
async function stepReady(page) { await page.waitForFunction(() => { const r = document.querySelector(".kt-root"); return r && !r.classList.contains("busy"); }, null, { timeout: 8000 }).catch(() => {}); await settle(page, 700); }
async function next(page) { await page.click(".kt-tip .kt-next"); await stepReady(page); }
// spotlight hugs the element: spot = element rect + padding (8 px)
async function spotOn(page, sel) {
  return page.evaluate(sel => {
    const els = [...document.querySelectorAll(sel)].filter(e => e.getBoundingClientRect().width);
    const spot = document.querySelector(".kt-spot"); if (!els.length || !spot) return false;
    const r = els[0].getBoundingClientRect(), s = spot.getBoundingClientRect();
    return Math.abs(s.left - (r.left - 8)) < 3 && Math.abs(s.top - (r.top - 8)) < 3 && Math.abs(s.width - (r.width + 16)) < 3;
  }, sel);
}
async function tipInside(page) {
  return page.evaluate(() => {
    const t = document.querySelector(".kt-tip").getBoundingClientRect(), bar = document.querySelector(".pn .pn-bar");
    const navTop = bar && bar.getBoundingClientRect().height ? bar.getBoundingClientRect().top : innerHeight;
    return t.left >= 0 && t.right <= innerWidth + 0.5 && t.top >= 0 && t.bottom <= navTop + 1;
  });
}
// everything the person owns in storage, minus the tour's own flags
const userData = page => page.evaluate(() => {
  const L = window.__kfpRealLocalStorage, out = {};
  for (let i = 0; i < L.length; i++) { const k = L.key(i); if (!/kfp_tour|__kfp_cloud_|__kfp_ent_cache|rateUpdatedAt|^rate$|kfp_exchange|kfp_gold_(market|daily|intraday|usd|news|thai|last|rec)|sb-|__all_local/.test(k)) out[k] = L.getItem(k); }
  return out;
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("T1 first visit: welcome card, 'ไว้ทีหลัง', remembered, never in other automated tests");
    let page = await newPage(browser);
    await seed(page, {}, { __kfp_tour_auto: "1" });
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector("#ktWelcome.on", { timeout: 8000 }).catch(() => {});
    ok(await vis(page, "#ktWelcome .kt-welcome") && /ยินดีต้อนรับสู่ PLANNER/.test(await txt(page, "#ktWelcome h2")), "welcome shows on the first visit");
    ok(/การจัดการรายได้ การบันทึกการทำงาน การบริหารเงินออม/.test(await txt(page, "#ktWelcome")), "welcome explains what the tour covers");
    ok(await vis(page, '#ktWelcome [data-w="start"]') && await vis(page, '#ktWelcome .kt-w-act [data-w="later"]'), "buttons: เริ่มแนะนำการใช้งาน · ไว้ทีหลัง");
    ok(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-w") === "start"), "focus on the start button");
    await page.screenshot({ path: path.join(SHOTS, "p24_welcome.png") });
    await page.click('#ktWelcome .kt-w-act [data-w="later"]'); await settle(page, 500);
    ok(!(await page.$("#ktWelcome")) && /เปิดคู่มือได้ทุกเมื่อ/.test(await txt(page, ".kt-toast")), "'ไว้ทีหลัง' closes and says where the guide lives");
    ok(await page.evaluate(() => JSON.parse(window.__kfpRealLocalStorage.getItem("kfp_tour_guest_v1")).welcome === "later"), "guest choice stored on this device");
    await page.click("#salary").catch(() => {});
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === "salary"), "site usable right away (not forced through the tour)");
    await page.reload(); await settle(page, 3000);
    ok(!(await page.$("#ktWelcome")), "not shown again after 'later'");
    await page.close();

    page = await newPage(browser);
    await seed(page, {}, {});
    await page.goto(`${BASE}/index.html`); await settle(page, 3500);
    ok(!(await page.$("#ktWelcome")) && await vis(page, ".kt-help-pill"), "automated browsers of other tests never get the pop-up (help button still there)");
    await page.close();

    page = await newPage(browser);
    await seed(page, Object.assign(member(), { "kfp:u:u-real:salaryRecords": JSON.stringify([{ month: "2026-10", salary: 2500000, rate: 0.024 }]) }), { __kfp_tour_auto: "1", "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`); await settle(page, 3500);
    ok(!(await page.$("#ktWelcome")) && await page.$eval(".kt-help-pill", b => b.classList.contains("kt-new")), "existing member with data: no pop-up, only a 'new' dot on the help button");
    await page.close();

    console.log("T2 spotlight, bubble, progress, next / previous / skip / tap / keys / exit");
    page = await newPage(browser);
    await seed(page, member(), { __kfp_tour_auto: "1", "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector("#ktWelcome.on", { timeout: 8000 });
    await page.click('#ktWelcome [data-w="start"]'); await stepReady(page);
    ok(/1<\/b> \/ 7|ขั้นตอน 1 \/ 7/.test(await page.innerHTML("#ktCount")) || /ขั้นตอน 1 \/ 7/.test(await count(page)), "starts the overview: step 1 / 7");
    ok(await page.$eval(".kt-root", r => r.classList.contains("nospot")) && await vis(page, ".kt-dim"), "intro card: whole page dimmed, no spotlight");
    await next(page);
    ok(/ขั้นตอน 2 \/ 7/.test(await count(page)) && /เมนูหลัก/.test(await title(page)), "Next → step 2");
    ok(await spotOn(page, '[data-tour="nav-bar"]'), "spotlight sits exactly on the bottom tab bar");
    ok(await page.$eval(".kt-tip", t => t.getAttribute("data-side")) === "top" && await tipInside(page), "bubble above the tab bar, inside the screen");
    ok(await page.$eval(".kt-prog i", i => parseFloat(i.style.width)) > 28, "progress bar moves");
    const ax = await page.evaluate(() => { const a = document.querySelector(".kt-arrow").getBoundingClientRect(), s = document.querySelector(".kt-spot").getBoundingClientRect(); return a.left + a.width / 2 >= s.left && a.left <= s.right; });
    ok(ax, "arrow points at the highlighted element");
    await page.screenshot({ path: path.join(SHOTS, "p24_step_nav.png") });
    await page.mouse.click(195, 300); await stepReady(page);
    ok(/ขั้นตอน 3 \/ 7/.test(await count(page)), "tap on the dimmed area → next step");
    await page.click(".kt-tip .kt-prev"); await stepReady(page);
    ok(/ขั้นตอน 2 \/ 7/.test(await count(page)), "ย้อนกลับ → previous step");
    await page.keyboard.press("ArrowRight"); await stepReady(page);
    ok(/ขั้นตอน 3 \/ 7/.test(await count(page)), "→ key = next");
    await page.keyboard.press("ArrowLeft"); await stepReady(page);
    ok(/ขั้นตอน 2 \/ 7/.test(await count(page)), "← key = previous");
    await page.click(".kt-tip .kt-skip"); await stepReady(page);
    ok(/ขั้นตอน 3 \/ 7/.test(await count(page)), "ข้าม → skips this step");
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === "ktTitle"), "focus moves to the step title");
    await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
    ok(await page.evaluate(() => !!document.activeElement.closest(".kt-tip")), "Tab stays inside the bubble");
    ok(/ขั้นตอนที่ 3 จาก 7/.test(await txt(page, ".kt-live")), "screen readers hear the step");
    await page.keyboard.press("Escape"); await settle(page, 400);
    ok(!(await page.$(".kt-root")) && !(await page.evaluate(() => document.documentElement.classList.contains("kt-on"))), "Escape exits at once: overlay, spotlight, bubble gone");
    ok(await page.evaluate(() => KfpTour.state().tours.overview.status === "skipped" && !sessionStorage.getItem("kfp_tour_run_v1")), "state = skipped, nothing left running");
    await page.keyboard.press("ArrowRight"); await settle(page, 300);
    ok(!(await page.$(".kt-root")), "keys do nothing after exit (listeners removed)");
    await page.evaluate(() => KfpTour.start("overview")); await stepReady(page);
    await next(page); await next(page);
    await page.click(".kt-tip .kt-x"); await settle(page, 400);
    ok(!(await page.$(".kt-root")), "✕ exits from any step");
    await page.evaluate(() => KfpTour.start("overview")); await stepReady(page);
    for (let i = 0; i < 7; i++) await next(page);
    ok(/จบแล้ว/.test(await title(page)) && await page.evaluate(() => KfpTour.state().tours.overview.status === "done"), "finished: end card + state done");
    ok(await vis(page, '.kt-nx[data-id="home"]'), "end card suggests the next topic");
    await page.click('.kt-nx[data-id="home"]'); await stepReady(page);
    ok(/หน้าหลักและการแบ่งเงินเดือน/.test(await txt(page, ".kt-tname")), "…and starts it");
    ok(page.errors.length === 0, "no page errors");

    console.log("T3 'try it' steps: the real control works and is not taken as Next");
    await page.evaluate(() => { KfpTour.stop(); KfpTour.start("money-tools"); }); await stepReady(page);
    while (!/ตัวแปลงสกุลเงิน/.test(await title(page))) { await next(page); if (!(await page.$(".kt-root"))) break; }
    const before = await count(page);
    await page.fill("#convertAmount", "100000"); await settle(page, 300);
    ok(/2,400|2400/.test(await txt(page, "#convertResult")) && (await count(page)) === before, "typing in the highlighted converter calculates; still the same step");
    await page.mouse.click(10, 10); await settle(page, 300);
    ok((await count(page)) === before, "tapping the dim area on a 'try it' step does not skip");
    await page.keyboard.press("Escape"); await settle(page, 300);
    await page.close();

    console.log("T4 work-record tour: real pop-up screens, real formula, nothing saved");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2500);
    const data0 = await userData(page);
    await page.evaluate(() => KfpTour.start("work")); await stepReady(page);
    ok(await spotOn(page, '[data-tour="work-record"]'), "step 1 highlights the บันทึกการเข้างาน button (data-tour anchor)");
    await next(page);
    ok(await vis(page, ".tl-modal.open .tl-menu") && await spotOn(page, ".tl-modal.open .tl-menu"), "opens the pop-up and highlights its menu");
    await next(page);
    ok(await vis(page, ".tl-modal.open .tl-types") && /×1\.5/.test(await txt(page, "#ktText")), "types screen + the person's real multipliers");
    await next(page); await next(page); await next(page); await next(page);   // hours → OT → night → wage settings
    ok(/ค่าแรงและตัวคูณ/.test(await title(page)) && /10,320 ₩/.test(await txt(page, ".kt-facts")), "wage settings step shows the saved wage");
    await next(page);
    ok(/ระบบคำนวณรายได้/.test(await title(page)) && /82,560 ₩/.test(await txt(page, ".kt-example")) && /30,960 ₩/.test(await txt(page, ".kt-example")) && /113,520 ₩/.test(await txt(page, ".kt-example")),
      "formula example: 8×10,320×1 = 82,560 · 2×10,320×1.5 = 30,960 · total 113,520");
    ok(/113,520/.test(await txt(page, ".tl-modal.open .tl-total")), "matches what the real receipt shows");
    await page.screenshot({ path: path.join(SHOTS, "p24_work_formula.png") });
    await page.evaluate(() => { const b = document.querySelector('.tl-modal.open [data-act="w-save"]'); if (b) b.click(); }); await settle(page, 400);
    ok(!(await page.evaluate(() => localStorage.getItem("kfp_work_records_v1"))), "even a forced click on บันทึก during the tour saves nothing");
    for (let i = 0; i < 6 && !/จบแล้ว/.test(await title(page)); i++) await next(page);
    ok(/จบแล้ว/.test(await title(page)) && !(await vis(page, ".tl-modal.open")), "tour done, pop-up closed again");
    await page.click('.kt-tip [data-k="close"]'); await settle(page, 400);
    { const d1 = await userData(page); const diff = Object.keys({ ...data0, ...d1 }).filter(k => data0[k] !== d1[k]);
      if (diff.length) console.log("    changed keys:", diff.join(", "));
      ok(!diff.length, "no user data changed by the tour"); }
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("T5 tour that lives on another page: travels there and continues; refresh → 'continue' pill");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    await page.click(".kt-help-pill"); await page.waitForSelector("#ktHelp .kt-row", { timeout: 5000 });
    await page.click('#ktHelp .kt-row[data-id="gold"]'); await page.click('#ktHelp [data-h="go"]');
    await page.waitForURL(/gold\.html/, { timeout: 8000 }).catch(() => {});
    await page.waitForSelector(".kt-root .kt-tip", { timeout: 8000 }).catch(() => {}); await stepReady(page);
    ok(/gold\.html/.test(page.url()) && /ขั้นตอน 1 \/ 11/.test(await count(page)) && /พอร์ตทองคำ/.test(await title(page)), "help centre → gold topic → goes to the gold page and starts there");
    await next(page);
    ok(/ตั้งราคาซื้อ/.test(await title(page)) && /31\.1034768 × 15\.244 × 0\.965/.test(await txt(page, ".kt-formula")), "gold formula shown as the page computes it");
    await page.reload(); await settle(page, 2500);
    ok(!(await page.$(".kt-root")) && await vis(page, ".kt-pill.on") && /ระบบทองคำ/.test(await txt(page, ".kt-pill")), "refresh: no stuck overlay — a 'continue' pill instead");
    await page.click('.kt-pill [data-p="go"]'); await stepReady(page);
    ok(/ขั้นตอน 2 \/ 11/.test(await count(page)), "ทำต่อ → same step again");
    await page.keyboard.press("Escape"); await settle(page, 300);
    await page.close();

    console.log("T6 help centre: list, select, restart everything, entry points");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    await page.click(".pn-add"); await settle(page, 400);
    ok(await vis(page, '.pn-act[data-q="help"]'), "+ quick sheet has 'วิธีใช้งานเว็บไซต์'");
    await page.click('.pn-act[data-q="help"]'); await page.waitForSelector("#ktHelp .kt-row", { timeout: 5000 });
    const rows = await page.$$eval("#ktHelp .kt-row b", b => b.map(x => x.textContent));
    ok(rows.length === 10 && rows.includes("ภาพรวมเว็บไซต์") && rows.includes("ระบบทองคำ") && rows.includes("ระบบบัตรเครดิตและหนี้") && rows.includes("บันทึกการเข้างาน") && rows.includes("สรุปรายได้ประจำเดือน") && rows.includes("ระบบบัญชีและสมาชิก") && rows.includes("แพ็กเกจ Premium และการชำระเงิน"),
      "10 topics, all real features: " + rows.join(" · "));
    ok(await vis(page, '#ktHelp [data-h="go"]') && await vis(page, '#ktHelp [data-h="all"]') && await vis(page, '#ktHelp .kt-h-foot [data-h="close"]'), "buttons: ดูหัวข้อที่เลือก · เริ่มแนะนำใหม่ทั้งหมด · ปิดหน้าต่าง");
    await page.screenshot({ path: path.join(SHOTS, "p24_help.png") });
    await page.keyboard.press("ArrowDown"); await settle(page, 100);
    ok((await page.getAttribute("#ktHelp .kt-row.sel", "data-id")) !== null, "arrow keys move the selection");
    await page.keyboard.press("Escape"); await settle(page, 400);
    ok(!(await page.$("#ktHelp")), "Escape closes the help centre");
    await page.click(".kt-help-pill"); await page.waitForSelector("#ktHelp .kt-row", { timeout: 5000 });
    await page.click('#ktHelp [data-h="all"]'); await stepReady(page);
    ok(/ภาพรวมเว็บไซต์/.test(await txt(page, ".kt-tname")) && await page.evaluate(() => Object.keys(KfpTour.state().tours).length === 1), "เริ่มแนะนำใหม่ทั้งหมด: progress reset, starts with the overview");
    for (let i = 0; i < 7; i++) await next(page);
    ok(/หัวข้อถัดไป/.test(await txt(page, ".kt-body")) && await vis(page, '.kt-nx[data-id="home"]'), "the whole course continues topic by topic");
    await page.click('.kt-tip [data-k="close"]'); await settle(page, 300);
    await page.goto(`${BASE}/account.html`); await settle(page, 2000);
    ok(await vis(page, '#helpCard [data-tour-open="help"]') && await vis(page, '#helpCard [data-tour-open="account"]'), "account page: help card with 'เปิดคู่มือ' and 'แนะนำหน้านี้'");
    await page.click('#helpCard [data-tour-open="account"]'); await stepReady(page);
    ok(/ระบบบัญชีและสมาชิก/.test(await txt(page, ".kt-tname")), "…starts the account tour");
    let accTxt = "";
    for (let i = 0; i < 10 && !/จบแล้ว/.test(await title(page)); i++) { accTxt += await txt(page, ".kt-body"); await next(page); }
    ok(/ข้อมูลทั้งหมดยังอยู่/.test(accTxt) && /อ่านอย่างเดียว/.test(accTxt) && /ต่ออายุ/.test(accTxt), "expiry explained: data kept, read-only, renew any time");
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    page = await newPage(browser, { width: 1280, height: 860 });
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/gold.html`); await settle(page, 2000);
    await page.click('.pn-side [data-k="help"]'); await page.waitForSelector("#ktHelp .kt-row", { timeout: 5000 }).catch(() => {});
    ok(await vis(page, "#ktHelp .kt-row"), "desktop sidebar 'วิธีใช้งานเว็บไซต์' opens the help centre");
    await page.keyboard.press("Escape"); await settle(page, 300);

    console.log("T7 resize recalculates; desktop placement beside the element");
    await page.evaluate(() => KfpTour.start("overview")); await stepReady(page); await next(page);
    ok(await spotOn(page, '[data-tour="nav-side"]') && await page.$eval(".kt-tip", t => t.getAttribute("data-side")) === "right", "desktop: sidebar highlighted, bubble to its right " +
      JSON.stringify(await page.evaluate(() => ({ side: document.querySelector(".kt-tip").getAttribute("data-side"), t: document.querySelector("#ktTitle").textContent, s: document.querySelector(".kt-spot").getBoundingClientRect().toJSON(), n: document.querySelector('[data-tour="nav-side"]').getBoundingClientRect().toJSON() }))));
    await page.setViewportSize({ width: 390, height: 844 }); await settle(page, 900);
    ok(await page.evaluate(() => { const s = document.querySelector(".kt-spot").getBoundingClientRect(); return s.width > 0; }) && await tipInside(page), "resize to a phone: spotlight and bubble recomputed inside the screen");
    await page.keyboard.press("Escape"); await settle(page, 300);
    await page.close();

    console.log("T8 missing elements: optional steps skipped, required ones explained in a centred card");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    await page.evaluate(() => {
      KfpTour.register({ id: "t-miss", title: "ทดสอบ", page: "home", steps: [
        { target: "#salary", title: "A" }, { target: "#nope-optional", optional: true, title: "B" }, { target: "#nope-required", title: "C", wait: 300 }, { target: "#rate", title: "D" }] });
      KfpTour.start("t-miss");
    }); await stepReady(page);
    ok(/ขั้นตอน 1 \/ 3/.test(await count(page)), "optional missing step not even counted");
    await next(page);
    ok((await title(page)) === "C" && await vis(page, ".kt-miss") && await page.$eval(".kt-root", r => r.classList.contains("nospot")), "missing required element → centred card with an explanation");
    await next(page);
    ok((await title(page)) === "D" && await spotOn(page, "#rate"), "…and the tour carries on");
    await page.keyboard.press("Escape"); await settle(page, 300);

    console.log("T9 small phone 320 px");
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => KfpTour.start("home")); await stepReady(page);
    let inside = true;
    for (let i = 0; i < 9; i++) { inside = inside && await tipInside(page); await next(page); if (/จบแล้ว/.test(await title(page))) break; }
    ok(inside, "every home step keeps the bubble inside the screen and above the tab bar");
    await page.screenshot({ path: path.join(SHOTS, "p24_320.png") });
    await page.keyboard.press("Escape"); await settle(page, 300);
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("T10 plans: locked topics explain the plan; debt demo is a 'try it' step");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "free", __mock_country: "KR" });
    await page.goto(`${BASE}/index.html`); await settle(page, 2500);
    await page.evaluate(() => KfpTour.start("work")); await stepReady(page);
    ok(/Finance Plus/.test(await title(page) + await txt(page, ".kt-note")) && await page.$eval(".kt-root", r => r.classList.contains("nospot")) && !(await vis(page, ".tl-modal.open")),
      "Free member: work tour explains the plan, never opens the locked pop-up");
    await page.keyboard.press("Escape"); await settle(page, 300);
    await page.click(".kt-help-pill"); await page.waitForSelector("#ktHelp .kt-row", { timeout: 5000 });
    ok(/Finance Plus/.test(await txt(page, '#ktHelp .kt-row[data-id="work"] .kt-chip.lock')) && /Finance Premium/.test(await txt(page, '#ktHelp .kt-row[data-id="debt"] .kt-chip.lock')), "help list marks which plan a topic needs");
    await page.keyboard.press("Escape"); await settle(page, 300);
    await page.goto(`${BASE}/credit-debt.html`); await settle(page, 2500);
    await page.evaluate(() => KfpTour.start("debt")); await stepReady(page);
    ok(/Smart Credit/.test(await title(page)) && await spotOn(page, ".cd-intro"), "locked debt page: intro highlighted");
    await next(page);
    ok(/ลองดูตัวอย่าง/.test(await title(page)) && await page.$eval(".kt-root", r => r.classList.contains("interactive")), "demo button is a 'try it' step");
    await page.click('[data-act="demo-on"]'); await page.waitForFunction(() => /พื้นที่สกุลเงิน/.test((document.querySelector("#ktTitle") || {}).textContent || ""), null, { timeout: 5000 }).catch(() => {});
    ok(/พื้นที่สกุลเงิน/.test(await title(page)), "tapping the real demo button moves the tour on by itself");
    for (let i = 0; i < 9 && !/จบแล้ว/.test(await title(page)); i++) await next(page);
    ok(/จบแล้ว/.test(await title(page)), "debt tour runs to the end on demo data");
    await page.click('.kt-tip [data-k="close"]'); await settle(page, 500);
    ok(await page.evaluate(() => { const t = document.querySelector(".cd-tab.on"); return !!t && t.getAttribute("data-tab") === "cards"; }), "debt page view put back as it was (cards tab)");
    ok(page.errors.length === 0, "no page errors");
    await page.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 24 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
