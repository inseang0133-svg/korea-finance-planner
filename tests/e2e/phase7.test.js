/* Phase 7 e2e: pricing page ↔ create-checkout / create-portal (functions mocked at the network level).
 * Run: node tests/e2e/phase7.test.js */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8800, BASE = `http://localhost:${PORT}`;
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

// fn: { checkout: {status, body} | "404", portal: {...} }
async function newPage(browser, fn = {}) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.fnCalls = [];
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    const m = /\/functions\/v1\/(create-checkout|create-portal)/.exec(u);
    if (m) {
      page.fnCalls.push({ name: m[1], body: r.request().postData(), auth: r.request().headers()["authorization"] });
      const spec = fn[m[1] === "create-checkout" ? "checkout" : "portal"] || { status: 200, body: { url: `${BASE}/manifest.json?stripe=${m[1]}` } };
      if (spec === "404") return r.fulfill({ status: 404, body: "" });
      return r.fulfill({ status: spec.status, contentType: "application/json", body: JSON.stringify(spec.body) });
    }
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const member = (email = "a@gmail.com", id = "u-real") => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-" + email, refresh_token: "rt", user: { id, email, email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": id });
async function openPricing(page, qs = "") { await page.goto(`${BASE}/pricing.html${qs}`); await page.waitForSelector("#plans .plan"); await page.waitForTimeout(1300); }
const txt = (page, sel) => page.textContent(sel).catch(() => "");
async function shot(page, name) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png") }); }

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("K1 guest → login modal, no payment request");
    let page = await newPage(browser);
    await seed(page, {});
    await openPricing(page);
    await page.click("#plus .cta"); await page.waitForTimeout(300);
    ok(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")) && (await txt(page, "#kfpAuthGateMsg")).includes("สมัครแพ็กเกจ"), "login modal (สมัครแพ็กเกจ)");
    ok(page.fnCalls.length === 0, "no create-checkout call");

    console.log("K2 Free member → create-checkout → Stripe Checkout");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await openPricing(page);
    ok((await txt(page, "#plus .cta")).includes("สมัคร Finance Plus") && (await txt(page, "#premium .cta")).includes("สมัคร Finance Premium"), "subscribe buttons");
    await page.click('#segCurrency [data-v="KRW"]');
    await Promise.all([page.waitForURL(/stripe=create-checkout/), page.click("#premium .cta")]);
    const c = page.fnCalls.find(x => x.name === "create-checkout");
    ok(c && JSON.parse(c.body).plan === "premium" && JSON.parse(c.body).interval === "month" && JSON.parse(c.body).currency === "KRW", "sends plan/interval/currency only (no price)");
    ok(c && c.auth === "Bearer at-a@gmail.com", "user access token sent");
    ok(page.url().includes("stripe=create-checkout"), "redirected to Checkout URL");

    console.log("K3 legacy username account → must link a real e-mail first");
    page = await newPage(browser);
    await seed(page, member("john@kfp.example.com", "u-legacy"), { "__mock_plan_u-legacy": "free" });
    await openPricing(page);
    await page.click("#plus .cta"); await page.waitForTimeout(300);
    ok((await txt(page, "#coStatus")).includes("เชื่อมอีเมลจริงก่อนสมัคร") && page.fnCalls.length === 0, "message, no request");
    await page.click("#coStatus button"); await page.waitForTimeout(300);
    ok(await page.isVisible("#kfpLegacyBanner"), "button opens account panel with link-email form");
    await shot(page, "p7_legacy");

    console.log("K4 server says already subscribed → send to the member billing page (Phase 8)");
    page = await newPage(browser, { checkout: { status: 409, body: { error: "already_subscribed", plan: "plus" } } });
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await openPricing(page);
    await page.click("#premium .cta"); await page.waitForTimeout(400);
    ok((await txt(page, "#coStatus")).includes("มีแพ็กเกจที่ชำระเงินอยู่แล้ว"), "explained");
    await Promise.all([page.waitForURL(/account\.html/), page.click("#coStatus button")]);
    ok(page.url().includes("account.html"), "button opens account.html");

    console.log("K5 paying subscriber → manage on account.html / upgrade via the portal confirm screen");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "plus" });
    await openPricing(page);
    ok((await txt(page, "#plus .cta")).includes("จัดการแพ็กเกจ") && await page.$eval("#plus .cta", a => a.getAttribute("href")) === "account.html", "current plan → account.html");
    ok((await txt(page, "#premium .cta")).includes("อัปเกรดเป็น Finance Premium"), "upgrade button");
    await shot(page, "p7_subscriber");
    await Promise.all([page.waitForURL(/stripe=create-portal/), page.click("#premium .cta")]);
    const sw = page.fnCalls[0] && JSON.parse(page.fnCalls[0].body || "{}");
    ok(page.fnCalls.length === 1 && page.fnCalls[0].name === "create-portal" && sw.flow === "switch" && sw.plan === "premium" && sw.interval === "month",
       "upgrade = portal 'switch' flow {premium, month} (no 2nd subscription)");

    console.log("K6 granted plan (legacy 90 days) → can subscribe to keep it");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", "__mock_source": "legacy_launch" });
    await openPricing(page);
    ok((await txt(page, "#premium .cta")).includes("สมัครเพื่อใช้ต่อหลังหมดสิทธิ์"), "renew-after-grant button");
    ok(await page.$('#premium [data-checkout]') !== null, "uses checkout, not portal");

    console.log("K7 price not on sale / functions not deployed / errors");
    page = await newPage(browser, { checkout: "404" });
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await openPricing(page);
    await page.click('#segInterval [data-v="year"]'); await page.click('#segCurrency [data-v="KRW"]');
    ok(await page.$eval("#plus .cta", b => b.disabled) && (await txt(page, "#plus .cta")).includes("ยังไม่เปิดขาย"), "KRW yearly without price → disabled");
    await page.click('#segCurrency [data-v="THB"]');
    await page.click("#plus .cta"); await page.waitForTimeout(400);
    ok((await txt(page, "#coStatus")).includes("ระบบชำระเงินยังไม่เปิด") && !(await page.$eval("#plus .cta", b => b.disabled)), "function missing → friendly message, button usable again");
    page = await newPage(browser, { checkout: { status: 429, body: { error: "rate_limited" } } });
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await openPricing(page);
    await page.click("#plus .cta"); await page.waitForTimeout(400);
    ok((await txt(page, "#coStatus")).includes("ลองหลายครั้งเกินไป"), "rate limit message");

    console.log("K8 back from Stripe: wait for the webhook, never trust the URL");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await openPricing(page, "?checkout=success&session_id=cs_test_123");
    ok((await txt(page, "#coStatus")).includes("กำลังเปิดสิทธิ์") && !page.url().includes("session_id"), "waiting message, URL cleaned");
    ok((await txt(page, "#free")).includes("แพ็กเกจของคุณ"), "still Free until the server says otherwise");
    await shot(page, "p7_waiting");
    await page.evaluate(() => sessionStorage.setItem("__mock_plan_u-real", "plus"));      // webhook processed
    await page.waitForFunction(() => document.getElementById("coStatus").textContent.includes("ชำระเงินสำเร็จ"), null, { timeout: 15000 }).catch(() => {});
    ok((await txt(page, "#coStatus")).includes("ชำระเงินสำเร็จ") && (await txt(page, "#coStatus")).includes("Finance Plus"), "success once entitlements change");
    ok((await txt(page, "#plus")).includes("แพ็กเกจของคุณ"), "Plus card marked current");
    await shot(page, "p7_success");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "free" });
    await openPricing(page, "?checkout=cancel");
    ok((await txt(page, "#coStatus")).includes("ไม่มีการตัดเงิน"), "cancel message");

    console.log("K9 mobile 360px");
    page = await newPage(browser);
    await page.setViewportSize({ width: 360, height: 800 });
    await seed(page, member(), { "__mock_plan_u-real": "plus" });
    await openPricing(page);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
