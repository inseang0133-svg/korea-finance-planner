// Cloudflare Worker (ฟรี) — ตัวกลางให้เว็บเรียก GOLD2go priceInfo ได้โดยไม่ติด CORS
// วิธีใช้: Cloudflare Dashboard → Workers → Create → วางโค้ดนี้ → Deploy
// แล้วนำ URL ของ worker ไปใส่ที่ GOLD2GO_WORKER_URL ใน gold.js
export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      const r = await fetch("https://gold2go-api.intergold.co.th/api/trade/priceInfo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: "{}"
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: cors });
    }
  }
};
