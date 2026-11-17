// Cloudflare Worker (ฟรี) — "ตัวบันทึกราคาทองเบื้องหลัง" + พร็อกซี + GOLD2go
//
// 1) Cron ทุก 1 นาที: ดึงราคา XAU/USD 3 ครั้ง (วินาทีที่ 0/20/40) แล้วเก็บเป็น close/high/low ต่อนาทีใน D1
//    → ทำงานตลอด 24 ชม. แม้ไม่มีใครเปิดเว็บ กราฟจึงไม่ขาดช่วง
// 2) GET /ticks?since=<ms>  → ส่งข้อมูลรายนาทีให้เว็บไปรวมกับกราฟ
// 3) GET /?url=<https...>   → พร็อกซี CORS (เฉพาะโดเมนที่อนุญาต) ใช้เป็น MARKET_PROXY_URL
// 4) GET /                  → GOLD2go priceInfo แคช 5 วิ (ใช้เป็น GOLD2GO_WORKER_URL)
// 5) GET /health            → ดูสถานะ (นาทีล่าสุดที่บันทึก)
// 6) GET /thai              → ราคาสมาคมค้าทองคำ (ทองแท่ง/ทองรูปพรรณ 96.5%)
//    Cron ไปอ่านราคาจากสมาคมเอง (JSON ของเว็บใหม่ → หน้า classic → api.chnwt.dev) (ทุก 2 นาทีช่วง 08:30–18:00 น. เวลาไทย, นอกนั้นทุก 10 นาที)
//    แล้วเก็บไว้ใน D1 → ผู้ใช้กี่คนก็อ่านจาก D1 ต้นทางโดนเรียกแค่จาก Cron นี้ที่เดียว

const KEEP_MS = 35 * 86400000;
const MAX_ROWS = 60000;
const PROXY_OK = ["xaus.com", "api.gold-api.com", "api.frankfurter.app", "open.er-api.com", "api.chnwt.dev", "api.goldprice.dev"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// แคชราคา GOLD2go ไว้ในหน่วยความจำของ Worker (Cache API ใช้บน workers.dev ไม่ได้)
// หลายคน/หลายแท็บที่ poll พร้อมกันจะได้ผลเดิมภายใน GOLD2GO_TTL_MS โดยไม่ยิงต้นทางซ้ำ
const GOLD2GO_TTL_MS = 5000;
let g2gCache = null;      // { t, status, body }
let g2gInflight = null;   // Promise ระหว่างกำลังดึง (กันยิงซ้ำพร้อมกัน)
async function getGold2go() {
  if (g2gCache && Date.now() - g2gCache.t < GOLD2GO_TTL_MS) return g2gCache;
  if (g2gInflight) return g2gInflight;
  g2gInflight = (async () => {
    try {
      const r = await fetch("https://gold2go-api.intergold.co.th/api/trade/priceInfo", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(8000)
      });
      const entry = { t: Date.now(), status: r.status, body: await r.text() };
      if (r.ok) g2gCache = entry;          // แคชเฉพาะที่สำเร็จ
      else if (g2gCache) return g2gCache;  // ต้นทางพัง → ใช้ค่าล่าสุดที่เคยได้ดีกว่าโชว์ error
      return entry;
    } catch (e) {
      if (g2gCache) return g2gCache;
      throw e;
    } finally { g2gInflight = null; }
  })();
  return g2gInflight;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
const SOURCES = [
  async () => {
    const d = await getJSON("https://xaus.com/api/v1/spot?currency=THB&unit=gram&compact=1&fresh=" + Date.now());
    const v = Number(d?.spot_usd_oz);
    if (!(v > 0)) throw new Error("xaus invalid");
    return v;
  },
  async () => {
    const d = await getJSON("https://api.gold-api.com/price/XAU?fresh=" + Date.now());
    const v = Number(d?.price);
    if (!(v > 0)) throw new Error("gold-api invalid");
    return v;
  }
];
async function samplePrice() {
  for (const src of SOURCES) {
    try { return await src(); } catch (_) { /* ลองแหล่งถัดไป */ }
  }
  return null;
}

async function record(env) {
  const prices = [];
  for (let i = 0; i < 3; i++) {
    const p = await samplePrice();
    if (p) prices.push(p);
    if (i < 2) await sleep(20000);
  }
  if (!prices.length) return;
  const b = Math.floor((Date.now() - 30000) / 60000) * 60000; // นาทีที่ cron เริ่มทำงาน (รันจบที่ ~:40 จึงลบ 30 วิ ให้ตกนาทีเดิม)
  const c = prices[prices.length - 1], h = Math.max(...prices), l = Math.min(...prices);
  await env.DB.prepare(
    `INSERT INTO ticks (b, c, h, l) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(b) DO UPDATE SET c = excluded.c, h = MAX(h, excluded.h), l = MIN(l, excluded.l)`
  ).bind(b, c, h, l).run();
  if (new Date().getUTCMinutes() === 0) {
    await env.DB.prepare("DELETE FROM ticks WHERE b < ?1").bind(Date.now() - KEEP_MS).run();
  }
}

// ---------- ราคาสมาคมค้าทองคำ (Thai Gold Traders Association) ----------
// www.goldtraders.or.th เปลี่ยนเป็นเว็บที่โหลดราคาภายหลัง (Next.js) → อ่านจากหน้า classic ที่ยังเป็น HTML ปกติ
// แหล่งหลัก: JSON ที่หน้าเว็บใหม่ของสมาคมใช้เอง (อัปเดตทุกครั้งที่ประกาศ)
// สำรอง: หน้า classic (บางครั้งอัปเดตช้ากว่าหน้าใหม่หลายรอบ) แล้วค่อย api.chnwt.dev
const GTA_JSON_URL = "https://www.goldtraders.or.th/api/GoldPrices/Latest?readjson=false";
const GTA_URL = "https://classic.goldtraders.or.th/default.aspx";
const CHNWT_URL = "https://api.chnwt.dev/thai-gold-api/latest";
const THAI_STALE_MS = 20 * 60000;  // เก่ากว่านี้ (cron ไม่ทำงาน) → ให้ /thai ดึงสดเองครั้งเดียว แล้วแคชในหน่วยความจำ
let thaiMem = null, thaiInflight = null;

export function toNum(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 1000 && n < 10000000 ? n : null;
}
function spanText(html, id) {
  const m = new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)</span>`, "i").exec(html);
  return m ? (m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() || null) : null;
}
// lblOMBuy = ทองรูปพรรณ "ฐานภาษี" ตามที่หน้าสมาคมแสดง
export function parseGta(html) {
  const p = "DetailPlace_uc_goldprices1_";
  const o = { barBuy: toNum(spanText(html, p + "lblBLBuy")), barSell: toNum(spanText(html, p + "lblBLSell")),
              jewelryBuy: toNum(spanText(html, p + "lblOMBuy")), jewelrySell: toNum(spanText(html, p + "lblOMSell")),
              updatedAt: spanText(html, p + "lblAsTime"), source: "สมาคมค้าทองคำ (goldtraders.or.th)" };
  return o.barBuy || o.barSell || o.jewelrySell ? o : null;
}
// { asTime:"2026-11-17T10:21:00", priceSeq:5, bL_BuyPrice, bL_SellPrice, oM965_BuyPrice (ฐานภาษี), oM965_SellPrice, priceChangeFromPrevRow, ... }
export function parseGtaJson(d) {
  if (Array.isArray(d)) d = d.slice().sort((a, b) => String(a?.asTime || "").localeCompare(String(b?.asTime || ""))).pop();
  if (!d || typeof d !== "object") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(d.asTime || ""));
  const seq = d.priceSeq ?? d.seq;
  const o = { barBuy: toNum(d.bL_BuyPrice), barSell: toNum(d.bL_SellPrice), jewelryBuy: toNum(d.oM965_BuyPrice), jewelrySell: toNum(d.oM965_SellPrice),
              updatedAt: m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543} เวลา ${m[4]}:${m[5]} น.` + (seq ? ` (ครั้งที่ ${seq})` : "") : null,
              asTime: d.asTime || null, round: seq ?? null,
              change: Number.isFinite(Number(d.priceChangeFromPrevRow)) ? Number(d.priceChangeFromPrevRow) : null,
              source: "สมาคมค้าทองคำ (goldtraders.or.th)" };
  return o.barBuy || o.barSell || o.jewelrySell ? o : null;
}
export function parseChnwt(d) {
  const p = d?.response?.price || {};
  const o = { barBuy: toNum(p.gold_bar?.buy), barSell: toNum(p.gold_bar?.sell), jewelryBuy: toNum(p.gold?.buy), jewelrySell: toNum(p.gold?.sell),
              updatedAt: [d?.response?.update_date, d?.response?.update_time].filter(Boolean).join(" ") || null,
              source: "สมาคมค้าทองคำ · api.chnwt.dev" };
  return o.barBuy || o.barSell || o.jewelrySell ? o : null;
}
export function saneThai(g) {
  return !!g && !(g.barBuy && g.barSell && (g.barSell < g.barBuy || g.barSell > g.barBuy * 1.05));
}
async function fetchThai() {
  const errs = [];
  try {
    const r = await fetch(GTA_JSON_URL, { headers: { "User-Agent": "Mozilla/5.0 (gold-recorder; price board reader)", "Accept": "application/json", "Referer": "https://www.goldtraders.or.th/" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const g = parseGtaJson(await r.json());
    if (saneThai(g)) return g;
    errs.push("gta-json: unparsed");
  } catch (e) { errs.push("gta-json: " + e.message); }
  try {
    const r = await fetch(GTA_URL, { headers: { "User-Agent": "Mozilla/5.0 (gold-recorder; price board reader)", "Accept-Language": "th,en" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const g = parseGta(await r.text());
    if (saneThai(g)) return g;
    errs.push("classic: unparsed");
  } catch (e) { errs.push("classic: " + e.message); }
  try {
    const g = parseChnwt(await getJSON(CHNWT_URL));
    if (saneThai(g)) return g;
    errs.push("chnwt: unparsed");
  } catch (e) { errs.push("chnwt: " + e.message); }
  throw new Error(errs.join("; "));
}
async function ensureThaiTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS thai_gold (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, fetched_at INTEGER NOT NULL)").run();
}
async function saveThai(env, g) {
  await ensureThaiTable(env);
  await env.DB.prepare("INSERT INTO thai_gold (id, data, fetched_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at")
    .bind(JSON.stringify(g), Date.now()).run();
}
async function readThai(env) {
  try {
    const row = await env.DB.prepare("SELECT data, fetched_at FROM thai_gold WHERE id = 1").first();
    return row ? { data: JSON.parse(row.data), at: row.fetched_at } : null;
  } catch (_) { return null; }  // ตารางยังไม่ถูกสร้าง (cron ยังไม่รันรอบแรก)
}
function thaiDue(now = new Date()) {
  const m = (now.getUTCHours() * 60 + now.getUTCMinutes() + 7 * 60) % 1440;   // นาทีของวัน เวลาไทย (UTC+7)
  const busy = m >= 8 * 60 + 30 && m <= 18 * 60;
  return busy ? now.getUTCMinutes() % 2 === 0 : now.getUTCMinutes() % 10 === 0;
}
async function refreshThai(env) {
  if (!env.DB || !thaiDue()) return;
  try { await saveThai(env, await fetchThai()); } catch (e) { console.log("thai gold refresh failed:", e.message); }
}
async function getThai(env) {
  const now = Date.now();
  const row = env.DB ? await readThai(env) : null;
  if (row && now - row.at < THAI_STALE_MS) return { ...row.data, fetchedAt: new Date(row.at).toISOString(), stale: false };
  if (thaiMem && now - thaiMem.at < 120000) return { ...thaiMem.data, fetchedAt: new Date(thaiMem.at).toISOString(), stale: false };
  try {
    thaiInflight ??= fetchThai().finally(() => { thaiInflight = null; });
    const g = await thaiInflight;
    thaiMem = { at: Date.now(), data: g };
    if (env.DB) saveThai(env, g).catch(() => {});
    return { ...g, fetchedAt: new Date(thaiMem.at).toISOString(), stale: false };
  } catch (e) {
    if (row) return { ...row.data, fetchedAt: new Date(row.at).toISOString(), stale: true };   // ต้นทางล่ม → ค่าล่าสุดที่เคยได้
    throw e;
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(record(env));
    ctx.waitUntil(refreshThai(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/ticks") {
      if (!env.DB) return json({ error: "D1 binding DB missing" }, 500);
      const since = Math.max(Number(url.searchParams.get("since")) || 0, Date.now() - KEEP_MS);
      const { results } = await env.DB.prepare(
        "SELECT b, c, h, l FROM ticks WHERE b >= ?1 ORDER BY b ASC LIMIT ?2"
      ).bind(since, MAX_ROWS).all();
      return json({ now: Date.now(), rows: (results || []).map(r => [r.b, r.c, r.h, r.l]) }, 200, { "Cache-Control": "public, max-age=10" });
    }

    if (url.pathname === "/health") {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, 500);
      const row = await env.DB.prepare("SELECT b, c FROM ticks ORDER BY b DESC LIMIT 1").first();
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM ticks").first();
      return json({ ok: true, lastMinute: row ? new Date(row.b).toISOString() : null, lastPrice: row?.c ?? null, rows: cnt?.n ?? 0 });
    }

    if (url.pathname === "/thai") {
      try {
        return json({ ok: true, ...(await getThai(env)) }, 200, { "Cache-Control": "public, max-age=60" });
      } catch (e) {
        return json({ ok: false, error: "source_unavailable", detail: String(e.message || e) }, 503);
      }
    }

    const target = url.searchParams.get("url");
    if (target) {
      let u; try { u = new URL(target); } catch (_) { return new Response("bad url", { status: 400, headers: CORS }); }
      if (u.protocol !== "https:" || !PROXY_OK.includes(u.hostname)) return new Response("forbidden", { status: 403, headers: CORS });
      const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
      return new Response(await r.text(), { status: r.status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    try {
      const g = await getGold2go();
      return new Response(g.body, {
        status: g.status,
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Cache-Age": String(Date.now() - g.t) }
      });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }
};
