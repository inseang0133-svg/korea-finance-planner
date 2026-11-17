// Thai Gold Traders Association parser in the Cloudflare Worker (gold-worker/worker.js) — classic page / chnwt fixtures.
// node tests/unit/thai-gold-worker.test.mjs
import { parseChnwt, parseGta as parseClassic, parseGtaJson, saneThai as sane, toNum } from "../../gold-worker/worker.js";
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }

const span = (id, v) => `<span id="DetailPlace_uc_goldprices1_${id}" class="x"><b><font color="#1D2A3B" size="3">${v}</font></b></span>`;
const html = `<html><body><table>
<tr><td>ทองคำแท่ง 96.5%</td><td>${span("lblBLSell", "62,450.00")}</td><td>${span("lblBLBuy", "62,250.00")}</td></tr>
<tr><td>ทองรูปพรรณ 96.5%</td><td>${span("lblOMSell", "63,250.00")}</td><td>${span("lblOMBuy", "61,003.84")}</td></tr>
${span("lblAsTime", "15/11/2569 เวลา 09:21 น. (ครั้งที่ 1)")}
</table></body></html>`;

console.log("T1 classic goldtraders page");
const g = parseClassic(html);
ok(g && g.barBuy === 62250 && g.barSell === 62450, "bar buy/sell");
ok(g.jewelrySell === 63250 && g.jewelryBuy === 61003.84, "ornament sell + tax base");
ok(g.updatedAt === "15/11/2569 เวลา 09:21 น. (ครั้งที่ 1)", "update time text");
ok(sane(g), "sane quote");
ok(parseClassic("<html>Loading latest prices...</html>") === null, "the new client-rendered site yields nothing (not zeros)");

console.log("T2 chnwt wrapper");
const c = parseChnwt({ status: "success", response: { update_date: "02/02/2569", update_time: "เวลา 17:23 น. (ครั้งที่ 69)",
  price: { gold: { buy: "69,523.76", sell: "71,950.00" }, gold_bar: { buy: "70,950.00", sell: "71,150.00" } } } });
ok(c.barBuy === 70950 && c.barSell === 71150 && c.jewelrySell === 71950, "prices");
ok(c.updatedAt === "02/02/2569 เวลา 17:23 น. (ครั้งที่ 69)", "date + time");
ok(parseChnwt({ status: "error" }) === null, "error payload → null");

console.log("T2b association JSON (new site) — the source the official page uses");
const j = parseGtaJson({ goldPriceID: 1, asTime: "2026-11-17T10:21:00", priceSeq: 5, bL_BuyPrice: 61900, bL_SellPrice: 62100,
  oM965_BuyPrice: 60655.16, oM965_SellPrice: 62900, priceChangeFromPrevRow: 50 });
ok(j.barBuy === 61900 && j.barSell === 62100 && j.jewelryBuy === 60655.16 && j.jewelrySell === 62900, "17/11 round 5 = what goldtraders.or.th shows");
ok(j.updatedAt === "17/11/2569 เวลา 10:21 น. (ครั้งที่ 5)" && j.change === 50, "Thai date, round, change");
ok(parseGtaJson([{ asTime: "2026-11-17T10:06:00", priceSeq: 4, bL_BuyPrice: "61,850.00", bL_SellPrice: "62,050.00" },
                 { asTime: "2026-11-17T10:21:00", priceSeq: 5, bL_BuyPrice: "61,900.00", bL_SellPrice: "62,100.00" }]).barBuy === 61900, "array → latest round");
ok(parseGtaJson({}) === null && parseGtaJson(null) === null, "empty → null");

console.log("T3 guards");
ok(toNum("-") === null && toNum("") === null && toNum("12") === null, "placeholders are not prices");
ok(!sane({ barBuy: 62250, barSell: 50000, jewelryBuy: null, jewelrySell: null, updatedAt: null, source: "" }), "sell below buy rejected");
ok(!sane({ barBuy: 62250, barSell: 70000, jewelryBuy: null, jewelrySell: null, updatedAt: null, source: "" }), "spread > 5% rejected");

console.log("T4 worker /thai: cron stores once in D1, every visitor reads the stored copy");
const { default: worker } = await import("../../gold-worker/worker.js");
let upstream = 0, row = null;
const DB = { prepare(sql) { return { bind(...a) { this.a = a; return this; },
  async run() { if (/INSERT INTO thai_gold/.test(sql)) row = { data: this.a[0], fetched_at: this.a[1] }; return {}; },
  async first() { if (/FROM thai_gold/.test(sql)) return row; return null; } }; } };
globalThis.fetch = async (u) => { upstream++;
  if (String(u).includes("/api/GoldPrices/Latest")) return new Response(JSON.stringify({ asTime: "2026-11-17T10:21:00", priceSeq: 5, bL_BuyPrice: 61900, bL_SellPrice: 62100, oM965_BuyPrice: 60655.16, oM965_SellPrice: 62900 }), { status: 200 });
  if (String(u).includes("classic.goldtraders")) return new Response(html, { status: 200 }); return new Response("{}", { status: 500 }); };
const env = { DB };
const realNow = Date.now;
// a cron tick inside Thai business hours (10:00 ICT = 03:00 UTC, even minute)
const RealDate = Date; const fixed = new RealDate("2026-11-17T03:00:05Z");
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } };
await new Promise(res => worker.scheduled({}, env, { waitUntil: p => p.then(res, res) }));
const afterCron = upstream;
ok(row && JSON.parse(row.data).barBuy === 61900, "cron saved the association's own JSON prices (round 5) in D1");
for (let i = 0; i < 25; i++) {
  const r = await worker.fetch(new Request("https://w.example/thai"), env);
  const j = await r.json();
  if (i === 0) ok(r.status === 200 && j.ok && j.barSell === 62100 && j.stale === false, "GET /thai returns the stored prices");
}
ok(upstream === afterCron, "25 visitors → no extra requests to the association (" + (upstream - afterCron) + ")");
globalThis.Date = RealDate;

console.log(`\nthai-gold: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
