/* Phase 13 e2e: staff roles in the admin drawer + role/plan badge on index.html and gold.html.
 * Supabase mocked (admin_* RPC fixtures in mock-supabase.js, role via sessionStorage __mock_admin_role).
 * Run: node tests/e2e/phase13.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8813, BASE = `http://localhost:${PORT}`;
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
async function badge(page) {
  return page.evaluate(() => {
    const b = document.getElementById("kfpBadge");
    if (!b || b.hidden) return null;
    const pill = b.querySelector(".kfb-pill:not(.kfb-plan .kfb-pill)"), plan = b.querySelector(".kfb-plan");
    const r = b.getBoundingClientRect(), chip = document.getElementById("kfpAuthRoot");
    return { role: pill ? pill.textContent : "", roleCls: pill ? pill.className : "", plan: plan ? plan.textContent : "",
      planCls: plan ? plan.innerHTML : "", href: plan ? plan.getAttribute("href") : "", left: r.left, top: r.top, right: r.right,
      chipLeft: chip ? chip.getBoundingClientRect().left : 9999, tap: plan ? plan.getBoundingClientRect().height : 0 };
  });
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("R1 owner sets a member's role from the drawer");
    let page = await newPage(browser);
    await seed(page, member(), { "__mock_admin_role": "owner" });
    await open(page, "#users");
    await page.click(ROW(2)); await page.waitForTimeout(600);
    const roleBtn = await txt(page, '#userActs [data-act="set_role"]');
    ok(await vis(page, '#userActs [data-act="set_role"]') && /บทบาท: (สมาชิก|Admin|Viewer)/.test(roleBtn), "role button visible for owner (" + roleBtn.trim() + ")");
    await page.click('#userActs [data-act="set_role"]'); await page.waitForTimeout(300);
    ok((await page.$eval("#cfRole", s => s.value)) === "viewer" && (await txt(page, "#cfText")).includes("ไม่จำกัด"), "dialog: default Viewer, explains unlimited Premium");
    await page.fill("#cfReason", "ช่วยดูข้อมูล"); await page.click("#cfOk"); await page.waitForTimeout(700);
    let rc = await page.evaluate(() => window.__mockRoleCalls || []);
    ok(rc.length === 1 && rc[0].p_role === "viewer" && rc[0].p_reason === "ช่วยดูข้อมูล", "admin_set_role(viewer) called with reason");
    ok((await txt(page, "#drIds")).toLowerCase().includes("viewer") && (await txt(page, '#userActs [data-act="set_role"]')).includes("Viewer"), "drawer shows Viewer after reload");
    await page.click('#userActs [data-act="set_role"]'); await page.waitForTimeout(300);
    await page.selectOption("#cfRole", "admin"); await page.waitForTimeout(100);
    ok(await page.$eval("#cf", d => d.classList.contains("danger")) && await vis(page, "#cfTypeBox"), "promoting to Admin needs typed confirmation");
    await page.fill("#cfReason", "เลื่อนเป็นแอดมิน"); await page.click("#cfOk"); await page.waitForTimeout(300);
    ok((await txt(page, "#cfErr")).includes("พิมพ์อีเมล"), "refused without typed e-mail");
    const want = await txt(page, "#cfTypeWant");
    await page.fill("#cfType", want); await page.click("#cfOk"); await page.waitForTimeout(700);
    rc = await page.evaluate(() => window.__mockRoleCalls || []);
    ok(rc.length === 2 && rc[1].p_role === "admin", "admin_set_role(admin) called");
    await shot(page, "p13_role_drawer");

    console.log("R2 admin (not owner) and viewer get no role button");
    for (const role of ["admin", "viewer"]) {
      page = await newPage(browser);
      await seed(page, member(), { "__mock_admin_role": role });
      await open(page, "#users");
      await page.click(ROW(2)); await page.waitForTimeout(600);
      ok(!(await vis(page, '[data-act="set_role"]')), role + ": no role button");
      if (role === "viewer") ok((await txt(page, "#actLocked")).includes("ดูได้อย่างเดียว") && !(await vis(page, "#userActs")), "viewer: read-only notice, no action buttons");
    }

    console.log("R3 badge on index.html / gold.html follows role + plan");
    const cases = [
      ["owner", "premium", "OWNER", "gold", "PREMIUM"],
      ["viewer", "premium", "VIEWER", "silver", "PREMIUM"],
      ["", "plus", "", "", "PLUS"],
      ["", "free", "", "", "FREE"],
      ["admin", "premium", "ADMIN", "gold", "PREMIUM"]
    ];
    for (const [role, plan, roleTxt, roleCls, planTxt] of cases) {
      page = await newPage(browser, { width: 390, height: 844 });
      await seed(page, member(), { "__mock_admin_role": role, "__mock_plan_u-real": plan });
      await page.goto(`${BASE}/index.html`); await page.waitForTimeout(2200);
      const b = await badge(page);
      ok(b && b.role === roleTxt && (!roleCls || b.roleCls.includes(roleCls)) && b.plan === planTxt && b.href === "pricing.html",
         `${role || "member"}/${plan}: ${roleTxt || "(no role)"} ${planTxt} → pricing.html`);
      if (plan === "free") ok(b && b.planCls.includes("kfb-text free") && !b.planCls.includes("kfb-pill"), "FREE = green text, no pill");
      if (plan === "plus") ok(b && b.planCls.includes("kfb-text plus"), "PLUS = blue text");
      if (plan === "premium") ok(b && b.planCls.includes("kfb-pill gold"), "PREMIUM = gold pill");
      ok(b && b.left >= 0 && b.top >= 0 && b.right < b.chipLeft && b.tap >= 44, "top-left, clear of the account chip, 44px tap target");
      if (role === "owner") await shot(page, "p13_badge_owner");
      if (plan === "free") {
        await page.click("#kfpBadge .kfb-plan"); await page.waitForTimeout(800);
        ok(page.url().endsWith("/pricing.html"), "tap FREE → pricing.html");
      }
    }
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, member(), { "__mock_admin_role": "viewer", "__mock_plan_u-real": "premium" });
    await page.goto(`${BASE}/gold.html`); await page.waitForTimeout(1500);
    const g = await badge(page);
    ok(g && g.role === "VIEWER" && g.plan === "PREMIUM", "gold.html shows the badge too");
    await shot(page, "p13_badge_gold");

    console.log("R4 guests (preview) see no badge");
    page = await newPage(browser, { width: 390, height: 844 });
    await seed(page, {});
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(1300);
    ok((await badge(page)) === null, "no badge for guests");
  } finally { await browser.close(); server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
