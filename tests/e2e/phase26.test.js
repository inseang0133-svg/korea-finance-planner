/* Phase 26 e2e: work record — saved default hours, OT "ไม่มี" + 1–8, ±0.5, night-shift premium, payslip formulas.
 * (was: Phase 24 e2e: Guided tour ("วิธีใช้งานเว็บไซต์") — welcome, spotlight, controls, keyboard, interactive steps,
 * pop-up steps without saving, page changes, resume, help centre, fallbacks, resize, locked plans, no data changes.
 * Run: node tests/e2e/phase24.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8826, BASE = `http://localhost:${PORT}`;
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

const act = (page, a, v) => page.click(`.tl-modal.open [data-act="${a}"]` + (v != null ? `[data-v="${v}"]` : ""));
const sv = page => txt(page, "#tlSv");
const defBtn = page => txt(page, ".tl-modal.open .tl-def");
const chips = page => page.$$eval(".tl-modal.open .tl-chip", b => b.map(x => x.textContent.trim() + (x.disabled ? "(off)" : "") + (x.classList.contains("sel") ? "*" : "")));
const wset = page => page.evaluate(() => JSON.parse(localStorage.getItem("kfp_work_settings_v1") || "{}"));
const recs = page => page.evaluate(() => JSON.parse(localStorage.getItem("kfp_work_records_v1") || "[]"));
const view = page => page.getAttribute(".tl-modal.open .tl-view", "data-view").catch(() => "");

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  let page = await newPage(browser);
  await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR" });
  await page.goto(`${BASE}/index.html`); await settle(page, 2500);
  await page.evaluate(() => window.kfpToolsTour.open("work")); await settle(page, 400);

  console.log("W1 formulas match the Korean payslip (시급 10,320)");
  const c = await page.evaluate(() => { const T = window.kfpToolsTour; return { slip: T.calc("normal", 48, 10), hol: T.calc("holiday", 8, 0), night: T.calc("normal", 8, 2, 2), over: T.calc("normal", 4, 0, 9), off: T.calc("day_off", 0, 0, 3) }; });
  ok(c.slip.regInc === 495360, "기본급 = 48 × 10,320 = 495,360");
  ok(c.slip.otInc === 154800, "연장근로수당 = 10 × 10,320 × 1.5 = 154,800");
  ok(c.slip.krw === 650160, "급여액 계 = 650,160 (same as the slip)");
  ok(c.hol.krw === 123840, "휴일근로 = 8 × 10,320 × 1.5 = 123,840");
  ok(c.night.nightInc === 10320 && c.night.krw === 82560 + 30960 + 10320, "야간근로수당 = 2 × 10,320 × 0.5 = 10,320, added on top");
  ok(c.over.night === 4, "night hours can't exceed the hours worked");
  ok(c.off.krw === 0 && c.off.nightInc === 0, "day off earns nothing");

  console.log("W2 hours step: saved default, ±0.5");
  await act(page, "m-today"); await settle(page, 300); await act(page, "type", "normal"); await settle(page, 300);
  ok(await view(page) === "whours" && (await sv(page)).trim() === "8", "new day starts at 8 h");
  ok(/★ ค่าเริ่มต้นของคุณ · 8 ชม\./.test(await defBtn(page)), "button says 8 h is the current default");
  await act(page, "h-adj", "0.5"); ok((await sv(page)).trim() === "8.5", "+ adds 0.5");
  ok(/☆ ตั้ง 8\.5 ชม\. เป็นค่าเริ่มต้น/.test(await defBtn(page)), "button offers to make 8.5 the default");
  await act(page, "h-adj", "-0.5"); await act(page, "h-adj", "-0.5"); ok((await sv(page)).trim() === "7.5", "− subtracts 0.5");
  await act(page, "h-set", "8"); ok((await sv(page)).trim() === "8", "chip 8");
  await act(page, "h-next"); await settle(page, 300);

  console.log("W3 OT step: ไม่มี + 1–8, set 2.5 as default");
  const oc = await chips(page);
  ok(JSON.stringify(oc) === JSON.stringify(["ไม่มี*", "1", "2", "3", "4", "5", "6", "7", "8"]), "chips: ไม่มี, 1–8 · ไม่มี selected (" + oc.join(" ") + ")");
  ok((await sv(page)).trim() === "ไม่มี", "value shows ไม่มี");
  ok(await page.isDisabled('.tl-modal.open [data-act="o-adj"][data-v="-0.5"]'), "− disabled at ไม่มี");
  await act(page, "o-set", "2"); await act(page, "o-adj", "0.5");
  ok((await sv(page)).trim() === "2.5", "2 then + → 2.5");
  await act(page, "o-def"); await settle(page, 200);
  ok((await wset(page)).defOt === 2.5, "default OT 2.5 saved");
  ok(/★ ค่าเริ่มต้นของคุณ · 2\.5 ชม\./.test(await defBtn(page)), "button now shows ★ 2.5 h");
  await act(page, "o-next"); await settle(page, 300);

  console.log("W4 night step + confirm + save");
  ok(await view(page) === "wnight" && (await sv(page)).trim() === "ไม่มี", "night step, ไม่มี by default");
  ok(await page.$eval(".tl-modal.open .tl-steps", e => e.children.length) === 5, "5 steps: ประเภท ชั่วโมง OT กลางคืน ยืนยัน");
  await act(page, "n-set", "2"); await act(page, "n-next"); await settle(page, 300);
  const rc = await txt(page, ".tl-modal.open .tl-receipt");
  ok(/กลางคืน\s*2 ชม\./.test(rc) && /10,320 ₩/.test(rc), "receipt shows night hours and +10,320 ₩");
  ok(/131,580/.test(await txt(page, ".tl-modal.open .tl-total")), "total 82,560 + 38,700 + 10,320 = 131,580");
  await act(page, "w-save"); await settle(page, 400);
  const r1 = (await recs(page))[0] || {};
  ok(r1.night === 2 && r1.nightInc === 10320 && r1.krw === 131580 && r1.ot === 2.5, "record saved with night fields");

  console.log("W5 next record: defaults pre-selected, just press ถัดไป");
  await act(page, "m-past"); await settle(page, 300);
  await page.click('.tl-modal.open [data-act="cal-prev"]'); await settle(page, 200);
  await page.click('.tl-modal.open [data-act="cal-day"]'); await settle(page, 300);
  await act(page, "type", "normal"); await settle(page, 200);
  ok((await sv(page)).trim() === "8", "hours 8 pre-selected");
  await act(page, "h-next"); await settle(page, 200);
  ok((await sv(page)).trim() === "2.5", "OT 2.5 pre-selected (saved default)");
  await act(page, "o-next"); await settle(page, 200);
  ok((await sv(page)).trim() === "ไม่มี", "night ไม่มี (its default)");
  await act(page, "n-next"); await settle(page, 200);
  ok(/121,260/.test(await txt(page, ".tl-modal.open .tl-total")), "82,560 + 38,700 = 121,260");
  await act(page, "w-save"); await settle(page, 300);

  console.log("W6 night chips limited by hours worked; hours minimum 0.5");
  await act(page, "m-past"); await settle(page, 300);
  await page.click('.tl-modal.open [data-act="cal-prev"]'); await settle(page, 200);
  await page.click('.tl-modal.open [data-act="cal-day"][data-v$="-02"]'); await settle(page, 300);
  await act(page, "type", "normal"); await act(page, "h-set", "6"); await act(page, "h-next"); await act(page, "o-set", "0"); await act(page, "o-next"); await settle(page, 200);
  const nc = await chips(page);
  ok(nc.includes("6") && nc.includes("7(off)") && nc.includes("8(off)"), "night 7, 8 disabled when only 6 h worked");
  await act(page, "n-set", "6"); ok(await page.isDisabled('.tl-modal.open [data-act="n-adj"][data-v="0.5"]'), "+ disabled at the limit");
  await page.click('.tl-modal.open .tl-back'); await page.click('.tl-modal.open .tl-back'); await settle(page, 200);
  for (let i = 0; i < 14 && !(await page.isDisabled('.tl-modal.open [data-act="h-adj"][data-v="-0.5"]')); i++) await act(page, "h-adj", "-0.5");
  ok((await sv(page)).trim() === "0.5" && await page.isDisabled('.tl-modal.open [data-act="h-adj"][data-v="-0.5"]'), "hours stop at 0.5");
  await act(page, "close"); await settle(page, 400);

  console.log("W7 settings keep the defaults; night premium editable");
  await page.evaluate(() => window.kfpToolsTour.open("work")); await settle(page, 300);
  await act(page, "m-set"); await settle(page, 300);
  ok(await page.inputValue("#sNight") === "0.5", "night premium field ×0.5");
  ok(/OT 2\.5 ชม\./.test(await txt(page, ".tl-defs")), "settings shows the saved defaults");
  await page.fill("#sWage", "10500"); await act(page, "set-save"); await settle(page, 300);
  let ws = await wset(page);
  ok(ws.wage === 10500 && ws.defOt === 2.5 && ws.night === 0.5, "saving settings keeps default OT");
  await act(page, "m-set"); await settle(page, 200); await act(page, "set-reset"); await settle(page, 200);
  ws = await wset(page);
  ok(ws.wage === 10320 && ws.defOt === 2.5, "reset restores wage/multipliers only");
  await page.fill("#sNight", "0"); await act(page, "set-save"); await settle(page, 300);
  ok((await page.evaluate(() => window.kfpToolsTour.calc("normal", 8, 0, 2))).nightInc === 0, "night premium 0 = company doesn't pay it");

  console.log("W8 summary shows night hours");
  await act(page, "m-sum"); await settle(page, 300);
  ok(/กลางคืน\s*2/.test(await txt(page, ".tl-modal.open .tl-kpis")), "summary KPI: กลางคืน 2 ชม.");
  await page.screenshot({ path: path.join(SHOTS, "p26_summary.png") });

  console.log("W9 tour example never saves a default");
  const before = JSON.stringify(await wset(page));
  await page.evaluate(() => { window.kfpToolsTour.example({ view: "wot", ot: 4 }); });
  await settle(page, 200); await act(page, "o-def"); await settle(page, 200);
  ok(JSON.stringify(await wset(page)) === before, "☆ during the tour example changes nothing");
  await page.evaluate(() => window.kfpToolsTour.close()); await settle(page, 500);

  // screenshots of the new steps
  await page.evaluate(() => window.kfpToolsTour.open("work")); await settle(page, 300);
  await act(page, "m-today"); await act(page, "type", "normal"); await settle(page, 300);
  await page.screenshot({ path: path.join(SHOTS, "p26_hours.png") });
  await act(page, "h-next"); await act(page, "o-set", "2"); await act(page, "o-adj", "0.5"); await settle(page, 300);
  await page.screenshot({ path: path.join(SHOTS, "p26_ot.png") });
  await act(page, "o-next"); await act(page, "n-set", "2"); await settle(page, 300);
  await page.screenshot({ path: path.join(SHOTS, "p26_night.png") });

  await act(page, "close"); await settle(page, 500);

  console.log("W10 calendar colours: day off red, holiday orange, night pink dot");
  await page.evaluate(() => {
    const ym = new Date().toISOString().slice(0, 7);
    const R = [{ date: ym + "-03", type: "day_off", reg: 0, ot: 0, krw: 0 }, { date: ym + "-04", type: "holiday", reg: 8, ot: 0, krw: 123840 },
      { date: ym + "-05", type: "normal", reg: 8, ot: 2, night: 3, krw: 129000 }, { date: ym + "-06", type: "normal", reg: 8, ot: 0, krw: 82560 }];
    localStorage.setItem("kfp_work_records_v1", JSON.stringify(R));
    window.kfpToolsTour.open("work");
  });
  await settle(page, 400); await act(page, "m-hist"); await settle(page, 400);
  const cls = await page.evaluate(() => { const o = {}; document.querySelectorAll('.tl-modal.open .tl-day[data-v]').forEach(b => { o[b.getAttribute("data-v").slice(-2)] = b.className + "|" + b.querySelectorAll(".tl-dots i").length + (b.querySelector("i.nt") ? "nt" : ""); }); return o; });
  const dow = d => new Date(new Date().toISOString().slice(0, 8) + d + "T12:00:00").getDay();
  ok(/dayoff/.test(cls["03"]) && !/ wknd/.test(cls["03"]), "day off → red (" + cls["03"] + ")");
  ok(/ hol/.test(cls["04"]), "holiday worked → orange (" + cls["04"] + ")");
  ok(/ night/.test(cls["05"]) && /2nt$/.test(cls["05"]), "night shift → extra pink dot (" + cls["05"] + ")");
  ok(dow("06") % 6 === 0 ? /wknd/.test(cls["06"]) : / has/.test(cls["06"]) && /1$/.test(cls["06"]), "plain day keeps one dot (" + cls["06"] + ")");
  ok(/วันหยุดแต่ทำงาน/.test(await txt(page, ".tl-modal.open .tl-legend")) && /หยุดงาน/.test(await txt(page, ".tl-modal.open .tl-legend")) && /กะกลางคืน/.test(await txt(page, ".tl-modal.open .tl-legend")), "legend lists the new colours");
  await page.screenshot({ path: path.join(SHOTS, "p26_calendar.png") });
  await act(page, "close"); await settle(page, 500);

  console.log("W11 tour bubble keeps its scroll position");
  await page.setViewportSize({ width: 390, height: 640 });
  await page.evaluate(() => window.KfpTour.start("work")); await settle(page, 1500);
  let kept = null, scrollable = false;
  for (let i = 0; i < 9 && !scrollable; i++) {
    scrollable = await page.evaluate(() => { const b = document.querySelector(".kt-tip .kt-body"); return !!b && b.scrollHeight - b.clientHeight > 40; });
    if (!scrollable) { await page.click(".kt-tip .kt-next"); await settle(page, 1200); }
  }
  ok(scrollable, "found a step whose text scrolls");
  const want = await page.evaluate(() => { const b = document.querySelector(".kt-tip .kt-body"); b.scrollTop = b.scrollHeight; return b.scrollTop; });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await settle(page, 1500);
  kept = await page.evaluate(() => { const b = document.querySelector(".kt-tip .kt-body"); return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight }; });
  ok(want > 20 && kept.top > 20 && kept.top >= Math.min(want, kept.max) - 2, "still at the end of the text after re-layout (" + want + " → " + kept.top + " of " + kept.max + ")");
  // half-way position survives too
  const mid = await page.evaluate(() => { const b = document.querySelector(".kt-tip .kt-body"); b.scrollTop = Math.round((b.scrollHeight - b.clientHeight) / 2); return b.scrollTop; });
  await settle(page, 300); await page.evaluate(() => window.dispatchEvent(new Event("resize"))); await settle(page, 1200);
  const mid2 = await page.evaluate(() => document.querySelector(".kt-tip .kt-body").scrollTop);
  ok(mid > 10 && Math.abs(mid2 - mid) <= 2, "half-way position kept (" + mid + " → " + mid2 + ")");
  await page.mouse.move(195, 200); await page.mouse.wheel(0, -30); await settle(page, 200);
  await page.evaluate(() => window.KfpTour.stop()); await settle(page, 300);

  ok(!page.errors.length, "no page errors" + (page.errors.length ? ": " + page.errors.join(" | ") : ""));
  await browser.close(); server.close();
  console.log(`Phase 26 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
