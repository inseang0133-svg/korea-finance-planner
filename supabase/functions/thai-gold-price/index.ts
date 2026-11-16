// thai-gold-price · public read-only proxy for the Thai Gold Traders Association price board.
//
// GET → 200 { ok:true, barBuy, barSell, jewelryBuy, jewelrySell, updatedAt, source, fetchedAt, stale }
//       503 { ok:false, error }
// No user data, no secrets. Cached in memory 60 s (stale copy served up to 12 h if both sources fail).
// Deploy: supabase functions deploy thai-gold-price --no-verify-jwt
import { CHNWT_URL, GTA_URL, parseChnwt, parseClassic, sane, type ThaiGold } from "../_shared/thai-gold.ts";

const ORIGINS = ["https://planer.com.de", "https://www.planer.com.de", "http://localhost:8765"]
  .concat((Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const FRESH_MS = 60_000, STALE_MS = 12 * 3600_000;
let cache: { at: number; data: ThaiGold } | null = null;
let inflight: Promise<ThaiGold> | null = null;

function headers(req: Request, maxAge: number): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAge}`,
  };
}

async function get(url: string, ms = 8000): Promise<Response> {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Mozilla/5.0 (KoreaFinancePlanner price reader)", "Accept-Language": "th,en" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(t); }
}

async function load(): Promise<ThaiGold> {
  const errs: string[] = [];
  try {
    const g = parseClassic(await (await get(GTA_URL)).text());
    if (sane(g)) return g!;
    errs.push("classic: unparsed");
  } catch (e) { errs.push("classic: " + (e as Error).message); }
  try {
    const g = parseChnwt(await (await get(CHNWT_URL)).json());
    if (sane(g)) return g!;
    errs.push("chnwt: unparsed");
  } catch (e) { errs.push("chnwt: " + (e as Error).message); }
  throw new Error(errs.join("; "));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: headers(req, 0) });
  if (req.method !== "GET") return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: headers(req, 0) });
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) {
    return new Response(JSON.stringify({ ok: true, ...cache.data, fetchedAt: new Date(cache.at).toISOString(), stale: false }), { headers: headers(req, 60) });
  }
  try {
    inflight ??= load().finally(() => { inflight = null; });
    const data = await inflight;
    cache = { at: Date.now(), data };
    return new Response(JSON.stringify({ ok: true, ...data, fetchedAt: new Date(cache.at).toISOString(), stale: false }), { headers: headers(req, 60) });
  } catch (e) {
    if (cache && now - cache.at < STALE_MS) {
      return new Response(JSON.stringify({ ok: true, ...cache.data, fetchedAt: new Date(cache.at).toISOString(), stale: true }), { headers: headers(req, 30) });
    }
    console.error("thai-gold-price", (e as Error).message);
    return new Response(JSON.stringify({ ok: false, error: "source_unavailable" }), { status: 503, headers: headers(req, 15) });
  }
});
