// Thai Gold Traders Association parser (supabase/functions/_shared/thai-gold.ts) — fixtures in the classic page / chnwt formats.
import { parseChnwt, parseClassic, sane, toNum } from "../../supabase/functions/_shared/thai-gold.ts";
let pass = 0, fail = 0;
function ok(c: unknown, n: string) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }

const span = (id: string, v: string) => `<span id="DetailPlace_uc_goldprices1_${id}" class="x"><b><font color="#1D2A3B" size="3">${v}</font></b></span>`;
const html = `<html><body><table>
<tr><td>ทองคำแท่ง 96.5%</td><td>${span("lblBLSell", "62,450.00")}</td><td>${span("lblBLBuy", "62,250.00")}</td></tr>
<tr><td>ทองรูปพรรณ 96.5%</td><td>${span("lblOMSell", "63,250.00")}</td><td>${span("lblOMBuy", "61,003.84")}</td></tr>
${span("lblAsTime", "15/11/2569 เวลา 09:21 น. (ครั้งที่ 1)")}
</table></body></html>`;

console.log("T1 classic goldtraders page");
const g = parseClassic(html)!;
ok(g && g.barBuy === 62250 && g.barSell === 62450, "bar buy/sell");
ok(g.jewelrySell === 63250 && g.jewelryBuy === 61003.84, "ornament sell + tax base");
ok(g.updatedAt === "15/11/2569 เวลา 09:21 น. (ครั้งที่ 1)", "update time text");
ok(sane(g), "sane quote");
ok(parseClassic("<html>Loading latest prices...</html>") === null, "the new client-rendered site yields nothing (not zeros)");

console.log("T2 chnwt wrapper");
const c = parseChnwt({ status: "success", response: { update_date: "02/02/2569", update_time: "เวลา 17:23 น. (ครั้งที่ 69)",
  price: { gold: { buy: "69,523.76", sell: "71,950.00" }, gold_bar: { buy: "70,950.00", sell: "71,150.00" } } } })!;
ok(c.barBuy === 70950 && c.barSell === 71150 && c.jewelrySell === 71950, "prices");
ok(c.updatedAt === "02/02/2569 เวลา 17:23 น. (ครั้งที่ 69)", "date + time");
ok(parseChnwt({ status: "error" }) === null, "error payload → null");

console.log("T3 guards");
ok(toNum("-") === null && toNum("") === null && toNum("12") === null, "placeholders are not prices");
ok(!sane({ barBuy: 62250, barSell: 50000, jewelryBuy: null, jewelrySell: null, updatedAt: null, source: "" }), "sell below buy rejected");
ok(!sane({ barBuy: 62250, barSell: 70000, jewelryBuy: null, jewelrySell: null, updatedAt: null, source: "" }), "spread > 5% rejected");

console.log(`\nthai-gold: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
