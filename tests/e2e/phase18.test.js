/* Phase 18 e2e: admin gives plans + add-ons; celebration pop-ups (gift from admin, Stripe purchase).
 * Supabase mocked (admin_* RPC fixtures in mock-supabase.js, role via sessionStorage __mock_admin_role).
 * Run: node tests/e2e/phase18.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
require("./demo-seed");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8818, BASE = `http://localhost:${PORT}`;
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

async function newPage(browser, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.fnCalls = []; page.alerts = 0;
  page.on("dialog", d => { page.alerts++; d.dismiss(); });
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX/i.test(e.message)) console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    const m = /\/functions\/v1\/([a-z-]+)/.exec(u);
    if (m) {
      page.fnCalls.push({ name: m[1], body: JSON.parse(r.request().postData() || "{}"), auth: r.request().headers()["authorization"] });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ changed: true, status: "active", cancel_at_period_end: true }) });
    }
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
const member = () => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
async function open(page, hash = "") { await page.goto(`${BASE}/admin.html${hash}`); await page.waitForTimeout(1100); }
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => !n || c.name === n), name);
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
const ROW = (i) => `[data-user="00000000-0000-4000-8000-${String(i).padStart(12, "0")}"]`;
const notice = (id, kind, items, expires) => ({ id, kind, items, expires_at: expires || null, created_at: new Date().toISOString() });

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("N1 admin: change plan / add-on modal");
    let page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "admin" });
    await open(page);
    await page.click("#tab-users"); await page.waitForTimeout(600);
    await page.click(ROW(1)); await page.waitForTimeout(600);
    ok((await txt(page, '[data-act="set_plan"]')).includes("Add-on"), "button reads เปลี่ยนแพ็กเกจ / Add-on");
    await page.click('[data-act="set_plan"]'); await page.waitForTimeout(250);
    ok((await page.$$("#cfAddons input[type=checkbox]")).length === 6, "six add-on checkboxes");
    ok(await page.inputValue("#cfPlan") === "keep", "plan defaults to ‘ไม่เปลี่ยนแพ็กเกจ’ (no accidental re-grant)");
    await page.fill("#cfReason", "ของขวัญลูกค้า"); await page.click("#cfOk"); await page.waitForTimeout(300);
    ok((await txt(page, "#cfErr")).includes("ยังไม่ได้เลือก") && (await calls(page, "rpc:admin_set_plan")).length === 0 && (await calls(page, "rpc:admin_set_addons")).length === 0, "nothing chosen → nothing sent");
    await page.check('#cfAddons input[value="addon_gold"]'); await page.check('#cfAddons input[value="addon_cloud"]');
    await shot(page, "n1_modal");
    await page.click("#cfOk"); await page.waitForTimeout(800);
    let ad = (await calls(page, "rpc:admin_set_addons")).pop();
    ok(ad && JSON.stringify(ad.args.p_addons) === JSON.stringify(["addon_cloud", "addon_gold"]) && ad.args.p_reason === "ของขวัญลูกค้า", "admin_set_addons(cloud, gold, reason)");
    ok((await calls(page, "rpc:admin_set_plan")).length === 0, "plan untouched when ‘keep’");
    ok((await txt(page, ".toast")).includes("Add-on"), "toast confirms add-ons");
    await page.click('[data-act="set_plan"]'); await page.waitForTimeout(250);
    ok(await page.isChecked('#cfAddons input[value="addon_gold"]') && await page.isChecked('#cfAddons input[value="addon_cloud"]'), "granted add-ons are pre-ticked next time");
    await page.selectOption("#cfPlan", "premium"); await page.uncheck('#cfAddons input[value="addon_cloud"]');
    await page.fill("#cfReason", "อัปเกรด premium"); await page.click("#cfOk"); await page.waitForTimeout(800);
    const sp = (await calls(page, "rpc:admin_set_plan")).pop(); ad = (await calls(page, "rpc:admin_set_addons")).pop();
    ok(sp && sp.args.p_plan === "premium" && ad && JSON.stringify(ad.args.p_addons) === JSON.stringify(["addon_gold"]), "plan + add-on change sent together");

    console.log("N2 member: gift pop-up from the admin (plan + add-ons), shown once");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, member(), { "__mock_plan_u-real": "premium", "__mock_country": "TH",
      "__mock_notices_u-real": JSON.stringify([notice("n-gift", "gift", [{ id: "premium", name: "Finance Premium", kind: "plan" }, { id: "addon_gold", name: "พอร์ตทอง", kind: "addon" }], "2026-12-31T23:59:59Z")]) });
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(3200);
    ok(await vis(page, ".kfn-ov.gift"), "gift pop-up appears on the first visit");
    const g = await txt(page, ".kfn-card");
    ok(g.includes("ของขวัญจากแอดมิน") && g.includes("Finance Premium") && g.includes("พอร์ตทอง") && g.includes("PREMIUM") && g.includes("ADD-ON"), "lists the plan and the add-on");
    ok(g.includes("ใช้ได้ถึง"), "shows the expiry date");
    await shot(page, "n2_gift");
    await page.click(".kfn-go"); await page.waitForTimeout(600);
    ok(!(await vis(page, ".kfn-ov")) && (await calls(page, "rpc:ack_my_notices")).length === 1, "button closes it and marks it seen");
    await page.reload(); await page.waitForTimeout(3000);
    ok(!(await vis(page, ".kfn-ov")), "not shown again after reload");

    console.log("N3 member: Stripe return → purchase pop-up as soon as the webhook lands");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, member(), { "__mock_plan_u-real": "free", "__mock_country": "TH" });
    await page.goto(`${BASE}/pricing.html?checkout=success&session_id=cs_test`); await page.waitForTimeout(1500);
    ok(!(await vis(page, ".kfn-ov")), "no pop-up before the payment is confirmed by the server");
    await page.evaluate(() => { sessionStorage.setItem("__mock_plan_u-real", "plus");
      sessionStorage.setItem("__mock_notices_u-real", JSON.stringify([{ id: "n-buy", kind: "purchase", items: [{ id: "plus", name: "Finance Plus", kind: "plan" }], expires_at: "2026-12-17T00:00:00Z" }])); });
    await page.waitForTimeout(4200);
    ok(await vis(page, ".kfn-ov.purchase"), "purchase pop-up appears after the webhook");
    const p = await txt(page, ".kfn-card");
    ok(p.includes("ชำระเงินสำเร็จ") && p.includes("Finance Plus") && p.includes("PLUS"), "names the purchased plan (PLUS)");
    await shot(page, "n3_purchase");
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    ok(!(await vis(page, ".kfn-ov")) && (await calls(page, "rpc:ack_my_notices")).length === 1, "Esc closes and acknowledges");

    console.log("N4 add-on purchase, two notices queue one after another; guests never ask");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, member(), { "__mock_plan_u-real": "plus", "__mock_country": "KR",
      "__mock_notices_u-real": JSON.stringify([notice("a1", "purchase", [{ id: "addon_gold", name: "พอร์ตทอง", kind: "addon" }]), notice("a2", "gift", [{ id: "addon_cloud", name: "Cloud Sync ข้ามเครื่อง", kind: "addon" }])]) });
    await page.goto(`${BASE}/gold.html`); await page.waitForTimeout(3200);
    ok(await vis(page, ".kfn-ov.purchase") && (await txt(page, ".kfn-card")).includes("พอร์ตทอง"), "first: add-on purchase");
    await page.click(".kfn-go"); await page.waitForTimeout(700);
    ok(await vis(page, ".kfn-ov.gift") && (await txt(page, ".kfn-card")).includes("Cloud Sync"), "then: the gift");
    await page.click(".kfn-x"); await page.waitForTimeout(600);
    ok(!(await vis(page, ".kfn-ov")), "all done");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, {});
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(2500);
    ok((await calls(page, "rpc:get_my_notices")).length === 0 && !(await vis(page, ".kfn-ov")), "guests: no request, no pop-up");
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 18 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
