// Cloudflare Worker (ฟรี) — "ตัวบันทึกราคาทองเบื้องหลัง" + พร็อกซี + GOLD2go
//
// 1) Cron ทุก 1 นาที: ดึงราคา XAU/USD 3 ครั้ง (วินาทีที่ 0/20/40) แล้วเก็บเป็น close/high/low ต่อนาทีใน D1
//    → ทำงานตลอด 24 ชม. แม้ไม่มีใครเปิดเว็บ กราฟจึงไม่ขาดช่วง
// 2) GET /ticks?since=<ms>  → ส่งข้อมูลรายนาทีให้เว็บไปรวมกับกราฟ
// 3) GET /?url=<https...>   → พร็อกซี CORS (เฉพาะโดเมนที่อนุญาต) ใช้เป็น MARKET_PROXY_URL
// 4) GET /                  → GOLD2go priceInfo แคช 5 วิ (ใช้เป็น GOLD2GO_WORKER_URL)
// 5) GET /health            → ดูสถานะ (นาทีล่าสุดที่บันทึก)

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(record(env));
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
