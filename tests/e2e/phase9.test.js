/* Phase 9 e2e: gold portfolio ↔ Premium-only Cloud table (kfp-gold-sync.js).
 * Supabase mocked: get_my_gold / save_my_gold keep the "server" copy in sessionStorage __mock_gold_<uid>.
 * Run: node tests/e2e/phase9.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8802, BASE = `http://localhost:${PORT}`;
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

async function newPage(browser, width = 400) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept());
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
const LOT = (id, grams = 15.244, cost = 60000) => ({ id, date: "2026-01-01", time: "", goldType: "96.5", quantity: 1, unit: "baht", grams, costThb: cost, note: "" });
const NS = (k) => "kfp:u:u-real:" + k;
function member(extra) {
  return Object.assign({
    [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }),
    "__kfp_auth_user_v1": "u-real"
  }, extra || {});
}
const serverRow = (lots, version = 1, settings = {}) => ({ "__mock_gold_u-real": JSON.stringify({ lots, settings, version, updated_at: "2026-11-10T03:00:00Z" }) });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
async function open(page, file = "gold.html", wait = 1800) { await page.goto(`${BASE}/${file}`); await page.waitForSelector("#kfpAuthButton"); await page.waitForTimeout(wait); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => !n || c.name === n), name);
const server_ = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_gold_u-real") || "null"));
const localLots = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("kfp_gold_lots_v1") || "[]"));
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
async function addLot(page, q = "0.5", cost = "31000") {
  await page.fill("#quantity", q); await page.fill("#cost", cost);
  await page.click('#lotForm [type="submit"]');
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("G1 guest (Preview) → demo gold, never touches the Cloud table");
    let page = await newPage(browser);
    await seed(page, {});
    await open(page);
    ok(await vis(page, ".gold-hero") && (await localLots(page)).length > 0, "demo portfolio shown");
    ok((await calls(page, "rpc:get_my_gold")).length === 0 && (await calls(page, "rpc:save_my_gold")).length === 0 && !(await vis(page, "#kfpGoldSync")), "no gold RPC, no sync chip");

    console.log("G2 Premium, first time: device gold uploaded (base 0); login does not wipe it");
    page = await newPage(browser);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("g1")]), [NS("kfp_gold_settings_v1")]: '{"valuationSource":"market"}', [NS("salary")]: "2500000" }),
      { "__mock_cloud_u-real": JSON.stringify({ user_id: "u-real", data: { salary: "2600000" }, updated_at: "2026-11-12T00:00:00Z" }) });
    await open(page);
    let srv = await server_(page);
    const save1 = (await calls(page, "rpc:save_my_gold"))[0];
    ok(save1 && save1.args.p_base_version === 0 && srv && srv.version === 1 && srv.lots.length === 1 && srv.lots[0].id === "g1", "first save: base 0 → server v1 with the device lot");
    ok(srv && srv.settings.valuationSource === "market", "settings synced");
    ok((await localLots(page)).length === 1 && await page.evaluate(() => localStorage.getItem("salary")) === "2600000", "Cloud user_data applied (salary) but local gold kept");
    ok((await txt(page, "#kfpGoldSync")).includes("ซิงก์กับ Cloud แล้ว"), "chip: synced");
    await shot(page, "p9_synced");

    console.log("G3 add a lot → debounced save with the last version; auto price refresh is not a change");
    await addLot(page);
    await page.waitForTimeout(400);
    ok((await txt(page, "#kfpGoldSync")).includes("กำลังบันทึก"), "chip: saving");
    await page.waitForTimeout(1800);
    srv = await server_(page);
    const saves = await calls(page, "rpc:save_my_gold");
    ok(saves.length === 2 && saves[1].args.p_base_version === 1 && srv.version === 2 && srv.lots.length === 2, "one save (base 1) → server v2, 2 lots");
    const autoRefresh = (price) => page.evaluate((price) => {   // what gold.js saveGold2goAutoPrice() writes on each auto refresh
      const s = JSON.parse(localStorage.getItem("kfp_gold_settings_v1") || "{}");
      Object.assign(s, { valuationSource: "gold2go", gold2goBuyBaht: price, gold2goReceiveBaht: price, gold2goSellBaht: price + 300, gold2goUpdatedAt: new Date().toISOString(), gold2goPriceMode: "auto", gold2goPriceSource: "test" });
      localStorage.setItem("kfp_gold_settings_v1", JSON.stringify(s)); window.kfpGoldSync.changed(); }, price);
    await autoRefresh(71234); await page.waitForTimeout(1800);           // first time: mode/source really changed → 1 save
    const afterFirst = (await calls(page, "rpc:save_my_gold")).length;
    await autoRefresh(71900); await page.waitForTimeout(1800);
    await autoRefresh(72050); await page.waitForTimeout(1800);
    ok(afterFirst === 3 && (await calls(page, "rpc:save_my_gold")).length === 3, "later auto GOLD2go price refreshes → no upload");
    ok(!("gold2goReceiveBaht" in (await server_(page)).settings), "auto prices never stored on the server");
    await page.evaluate(() => { window.kfpAuth.open("account"); });
    await page.waitForTimeout(300);
    await page.click("#kfpUploadCloudBtn"); await page.waitForTimeout(500);
    const up = (await calls(page, "upsert:user_data")).pop();
    ok(up && up.args.data.salary && !("kfp_gold_lots_v1" in up.args.data) && !("kfp_gold_settings_v1" in up.args.data), "user_data upload never contains gold (Premium too)");

    console.log("G4 second device (no local gold) → Cloud copy applied, nothing uploaded");
    page = await newPage(browser);
    await seed(page, member(), serverRow([LOT("a"), LOT("b"), LOT("c")], 7));
    await open(page);
    ok((await localLots(page)).map(l => l.id).join() === "a,b,c" && (await calls(page, "rpc:save_my_gold")).length === 0, "3 lots from Cloud, no save");
    ok((await txt(page, "#lotSummary")).includes("ทั้งหมด 3 รอบ"), "portfolio re-rendered (3 lots)");
    ok(JSON.parse(await page.evaluate(() => localStorage.getItem("__kfp_gold_sync_v1"))).v === 7, "sync meta = server version 7");

    console.log("G5 other device changed Cloud, this one did not → updated silently");
    await page.evaluate(() => { const r = JSON.parse(sessionStorage.getItem("__mock_gold_u-real")); r.lots.push({ id: "d", grams: 1, costThb: 4000 }); r.version = 8; sessionStorage.setItem("__mock_gold_u-real", JSON.stringify(r)); });
    await open(page);
    ok((await localLots(page)).length === 4 && !(await vis(page, "#kfpGoldConflict")) && (await txt(page, "#lotSummary")).includes("4 รอบ"), "4 lots, no conflict prompt");

    console.log("G6 both changed (unknown history) → member chooses; other copy backed up");
    page = await newPage(browser);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("phone1"), LOT("phone2")]) }), serverRow([LOT("pc1")], 3));
    await open(page);
    ok(await vis(page, "#kfpGoldConflict") && (await txt(page, "#kfpGcCloud")).includes("1 รอบ") && (await txt(page, "#kfpGcLocal")).includes("2 รอบ"), "conflict card: Cloud 1 lot vs device 2 lots");
    ok((await calls(page, "rpc:save_my_gold")).length === 0 && (await localLots(page)).length === 2, "nothing overwritten while undecided");
    await shot(page, "p9_conflict");
    await page.click('[data-gold-choice="cloud"]'); await page.waitForTimeout(400);
    let bk = JSON.parse(await page.evaluate(() => localStorage.getItem("__kfp_gold_backup_v1")));
    ok((await localLots(page)).map(l => l.id).join() === "pc1" && !(await vis(page, "#kfpGoldConflict")), "use Cloud → device now has the Cloud lot");
    ok(bk && bk.from === "device" && bk.lots.length === 2, "device copy backed up");
    page = await newPage(browser);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("phone1"), LOT("phone2")]) }), serverRow([LOT("pc1")], 3));
    await open(page);
    await page.click('[data-gold-choice="device"]'); await page.waitForTimeout(600);
    srv = await server_(page); bk = JSON.parse(await page.evaluate(() => localStorage.getItem("__kfp_gold_backup_v1")));
    const forced = (await calls(page, "rpc:save_my_gold")).pop();
    ok(forced && forced.args.p_base_version === null && srv.version === 4 && srv.lots.length === 2, "use device → forced save (base null), Cloud v4 = 2 lots");
    ok(bk && bk.from === "cloud" && bk.lots[0].id === "pc1" && (await txt(page, "#kfpGoldSync")).includes("บันทึกข้อมูลเครื่องนี้"), "Cloud copy backed up, chip explains");

    console.log("G7 another device saved meanwhile → server refuses the stale version → chooser");
    await page.evaluate(() => { const r = JSON.parse(sessionStorage.getItem("__mock_gold_u-real")); r.lots = [{ id: "tablet", grams: 2, costThb: 9000 }]; r.version = 9; sessionStorage.setItem("__mock_gold_u-real", JSON.stringify(r)); });
    await addLot(page); await page.waitForTimeout(2000);
    ok(await vis(page, "#kfpGoldConflict") && (await server_(page)).version === 9 && (await localLots(page)).length === 3, "conflict shown, Cloud v9 untouched, device keeps its 3 lots");

    console.log("G8 offline → kept on the device, uploaded when back online");
    page = await newPage(browser);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("x")]), [NS("__kfp_gold_sync_v1")]: '{"v":0,"h":"none"}' }), { "__mock_gold_mode": "offline" });
    await open(page);
    ok((await txt(page, "#kfpGoldSync")).includes("ออฟไลน์") && (await localLots(page)).length === 1, "chip: offline, data still here");
    await page.evaluate(() => { sessionStorage.removeItem("__mock_gold_mode"); window.dispatchEvent(new Event("online")); });
    await page.waitForTimeout(800);
    srv = await server_(page);
    ok(srv && srv.lots.length === 1 && srv.lots[0].id === "x" && (await txt(page, "#kfpGoldSync")).includes("ซิงก์"), "uploaded after reconnect");

    console.log("G9 Plus member: upgrade screen, gold kept on Cloud (count only), nothing sent");
    page = await newPage(browser);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("local")]) }), { "__mock_plan_u-real": "plus", ...serverRow([LOT("a"), LOT("b"), LOT("c")], 5) });
    await open(page);
    ok(await vis(page, "#kfpGoldUpsell") && (await txt(page, "#kfpUpStored")).includes("3 รอบ"), "upsell says 3 lots are kept");
    ok((await calls(page, "rpc:save_my_gold")).length === 0 && (await localLots(page)).map(l => l.id).join() === "local", "no upload, device copy untouched");
    await shot(page, "p9_plus_upsell");

    console.log("G10 plan ends while the page is open → server refuses → upgrade screen");
    page = await newPage(browser);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("g1")]) }), serverRow([LOT("g1")], 2));
    await open(page);
    ok(await vis(page, ".gold-hero") && (await txt(page, "#kfpGoldSync")).includes("ซิงก์"), "Premium: synced");
    await page.evaluate(() => sessionStorage.setItem("__mock_plan_u-real", "free"));
    await addLot(page); await page.waitForTimeout(2200);
    ok((await server_(page)).version === 2 && await vis(page, "#kfpGoldUpsell") && !(await vis(page, ".gold-container")), "save refused (premium_required) → upgrade screen, Cloud unchanged");
    ok((await localLots(page)).length === 2, "the new lot is still on this device");

    console.log("G11 index: gold summary only with Premium");
    const snap = { [NS("kfp_gold_portfolio_snapshot_v1")]: JSON.stringify({ value: 123456, pl: 2000, pct: 1.6, ts: Date.now() }) };
    page = await newPage(browser);
    await seed(page, member(snap), { "__mock_plan_u-real": "free" });
    await open(page, "index.html");
    ok(!(await vis(page, "#goldPortfolioInfo")), "Free: gold value hidden on the home page");
    page = await newPage(browser);
    await seed(page, member(snap), { "__mock_plan_u-real": "premium" });
    await open(page, "index.html");
    ok(await vis(page, "#goldPortfolioInfo"), "Premium: shown");

    console.log("G12 mobile 360px: chip + conflict fit");
    page = await newPage(browser, 360);
    await seed(page, member({ [NS("kfp_gold_lots_v1")]: JSON.stringify([LOT("m1")]) }), serverRow([LOT("pc")], 2));
    await open(page);
    ok(await vis(page, "#kfpGoldConflict") && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll");
    const small = await page.$$eval(".kfp-gc-btn", bs => bs.filter(b => b.getBoundingClientRect().height < 44).length);
    ok(small === 0, "chooser buttons ≥ 44px");
    await shot(page, "p9_mobile_conflict");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
