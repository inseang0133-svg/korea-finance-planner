// Thai Gold Traders Association (สมาคมค้าทองคำ) price parsing — pure functions, unit-tested in tests/edge/thai-gold.test.ts.
// www.goldtraders.or.th became a client-rendered (Next.js) site in 2026, so prices are read from the
// association's own "classic" page, which still publishes them as server-rendered HTML.
export const GTA_URL = "https://classic.goldtraders.or.th/default.aspx";
export const CHNWT_URL = "https://api.chnwt.dev/thai-gold-api/latest";

export type ThaiGold = {
  barBuy: number | null; barSell: number | null; jewelryBuy: number | null; jewelrySell: number | null;
  updatedAt: string | null; source: string;
};

export function toNum(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 1000 && n < 10_000_000 ? n : null;
}

function spanText(html: string, id: string): string | null {
  const re = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)</span>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() || null;
}

// lblOMBuy is the ornament "ฐานภาษี" (tax-base / buy-back reference) price, as on the association page.
export function parseClassic(html: string): ThaiGold | null {
  const p = "DetailPlace_uc_goldprices1_";
  const out: ThaiGold = {
    barBuy: toNum(spanText(html, p + "lblBLBuy")),
    barSell: toNum(spanText(html, p + "lblBLSell")),
    jewelryBuy: toNum(spanText(html, p + "lblOMBuy")),
    jewelrySell: toNum(spanText(html, p + "lblOMSell")),
    updatedAt: spanText(html, p + "lblAsTime"),
    source: "สมาคมค้าทองคำ (goldtraders.or.th)",
  };
  return out.barBuy || out.barSell || out.jewelrySell ? out : null;
}

// deno-lint-ignore no-explicit-any
export function parseChnwt(data: any): ThaiGold | null {
  const p = data?.response?.price ?? {};
  const out: ThaiGold = {
    barBuy: toNum(p.gold_bar?.buy), barSell: toNum(p.gold_bar?.sell),
    jewelryBuy: toNum(p.gold?.buy), jewelrySell: toNum(p.gold?.sell),
    updatedAt: [data?.response?.update_date, data?.response?.update_time].filter(Boolean).join(" ") || null,
    source: "สมาคมค้าทองคำ · api.chnwt.dev",
  };
  return out.barBuy || out.barSell || out.jewelrySell ? out : null;
}

// a bar quote must look sane: sell ≥ buy and within 5 %
export function sane(g: ThaiGold | null): boolean {
  if (!g) return false;
  if (g.barBuy && g.barSell && (g.barSell < g.barBuy || g.barSell > g.barBuy * 1.05)) return false;
  return true;
}
