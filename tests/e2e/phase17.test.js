/* Phase 17 e2e: gold page — association prices come from our Cloudflare Worker (/thai), and the chart's
 * P/L label + break-even line use exactly the same numbers as the round card.
 * External network is mocked: worker /thai, GOLD2go price (worker root), spot sources.
 * Run: node tests/e2e/phase17.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8817, BASE = `http://localhost:${PORT}`, OUT = process.env.SHOT_DIR || "";
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
const THAI = { ok: true, barBuy: 62250, barSell: 62450, jewelryBuy: 61003.84, jewelrySell: 63250, updatedAt: "17/11/2569 เวลา 09:21 น. (ครั้งที่ 1)", source: "สมาคมค้าทองคำ (goldtraders.or.th)", stale: false };

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  const thaiHits = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", d => d.dismiss());
    await page.route("**/*", r => {
      const u = r.request().url();
      if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
      if (u.startsWith(BASE)) return r.continue();
      if (u.includes("workers.dev/thai")) { thaiHits.push(u); return r.fulfill({ contentType: "application/json", body: JSON.stringify(THAI) }); }
      if (u.includes("xaus.com/api/v1/spot")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ xau: { price: 3858.90 * 33.88 / 31.1034768 / 0.9999 }, spot_usd_oz: 3858.90, fx_rate: 33.88, updated_at: new Date().toISOString() }) });
      return r.abort();
    });
    await page.goto(`${BASE}/manifest.json`);
    await page.evaluate(([k]) => { localStorage.clear(); sessionStorage.clear();
      localStorage.setItem(k, JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }));
      localStorage.setItem("__kfp_auth_user_v1", "u-real"); sessionStorage.setItem("__mock_plan_u-real", "premium"); sessionStorage.setItem("__mock_country", "TH"); }, [TOKEN_KEY]);
    await page.goto(`${BASE}/gold.html`); await page.waitForTimeout(3500);

    console.log("G1 association prices from the Cloudflare Worker /thai");
    ok(thaiHits.length >= 1, "page asks the worker /thai (" + thaiHits.length + " call)");
    const bar = (await page.textContent("#thaiBarBuy")).replace(/[^\d.,]/g, "");
    ok(bar.includes("62,250"), "สมาคมฯ ทองแท่ง รับซื้อ shows ฿62,250 (" + bar + ")");
    ok((await page.textContent("#thaiJewelrySell")).includes("63,250"), "ทองรูปพรรณ ขายออก shows ฿63,250");

    console.log("G2 chart P/L = round card P/L, chart line = card break-even spot");
    const r = await page.evaluate(() => {
      const { calculateLot, lotBreakEvenUsdOz, lotBuyUsdOz, lotEntryHTML, loadSettings, saveSettings, state } = window.__kfpGoldTest;
      // a GOLD2go 96.5% round like the user's #004: 2.579285 g, cost ฿10,470.60
      const lot = { id: "t1", date: "2026-11-16", time: "15:03", goldType: 96.5, unit: "gram", quantity: 2.579285, grams: 2.579285, costThb: 10470.60, buyPriceThbGram: 10470.60 / 2.579285 };
      const s = loadSettings(); s.valuationSource = "gold2go"; s.gold2goBuyBaht = 61814; saveSettings(s);
      state.spotUsdOz = 3858.90; state.usdThb = 33.88; state.priceThbGram = 3858.90 * 33.88 / 31.1034768;
      const calc = calculateLot(lot);
      const be = lotBreakEvenUsdOz(calc, lotBuyUsdOz(lot));
      const html = lotEntryHTML(calc);
      const m = /Spot คุ้มทุน ≈ \$([\d,]+\.\d+)/.exec(html.replace(/<[^>]+>/g, " "));
      const old = (state.priceThbGram * (96.5 / 99.99) - lot.buyPriceThbGram) * lot.grams;   // the previous chart formula
      return { pl: calc.pl, be: be && be.usd, calibrated: be && be.calibrated, card: m ? Number(m[1].replace(/,/g, "")) : null, old };
    });
    ok(Math.abs(r.pl - (-11.67)) < 0.6, "round P/L ≈ −฿11.67 like the card (" + r.pl.toFixed(2) + ")");
    ok(r.calibrated && r.card && Math.abs(r.be - r.card) < 0.01, "chart line sits at the card's break-even spot ($" + (r.be || 0).toFixed(2) + " vs card $" + r.card + ")");
    ok(Math.abs(r.old - r.pl) > 1, "old chart formula differed from the card (" + r.old.toFixed(2) + " vs " + r.pl.toFixed(2) + ") — now fixed");
    const src = fs.readFileSync(path.join(ROOT, "gold.js"), "utf8");
    ok(/const pl = calc\.pl;/.test(src) && /series\.priceToCoordinate\(be\.usd\)/.test(src), "overlay draws label from calculateLot() and line at the break-even spot");
    ok(errors.length === 0, "no page errors (" + errors.join(" | ") + ")");
    if (OUT) await page.screenshot({ path: path.join(OUT, "g17.png"), fullPage: false });
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 17 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
