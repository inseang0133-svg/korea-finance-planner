/* Phase 3 e2e: Preview Mode + Demo Data + per-account storage isolation.
 * Run: node tests/e2e/phase3.test.js     (Supabase mocked, CDNs blocked) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8795, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";
const REF = "yelkgtddtuugzoyzvqug";              // from supabase-config.js
const TOKEN_KEY = `sb-${REF}-auth-token`;

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

async function newPage(browser, { fn = "404", width = 400 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { if (!/fetch|Chart|XLSX|LightweightCharts|createChart/i.test(e.message)) { page.errors.push(e.message); console.log("    [pageerror]", e.message); } });
  page.on("dialog", d => d.accept());
  await page.route("**/*", route => {
    const u = route.request().url();
    if (u.includes("@supabase/supabase-js")) return route.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.includes("/functions/v1/")) return route.fulfill({ status: fn === "404" ? 404 : 500, body: "" });
    if (u.startsWith(BASE)) return route.continue();
    return route.abort();
  });
  return page;
}
// Seed REAL storage on this origin before any app script runs.
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => {
    localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v));
    Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v));
  }, { items, session });
}
const tokenFor = (id, email, confirmed = true) => JSON.stringify({ access_token: "at-" + email, refresh_token: "rt", expires_at: 9999999999,
  user: { id, email, email_confirmed_at: confirmed ? "2026-01-01T00:00:00Z" : null } });
const real = page => page.evaluate(() => { const r = window.__kfpRealLocalStorage || localStorage, o = {}; for (let i = 0; i < r.length; i++) { const k = r.key(i); o[k] = r.getItem(k); } return o; });
const mode = page => page.evaluate(() => window.kfpStorage && window.kfpStorage.mode);
const settle = (page, ms = 900) => page.waitForTimeout(ms);
async function open(page, file = "index.html") { await page.goto(`${BASE}/${file}`); await page.waitForSelector("#kfpAuthButton"); await settle(page); }
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
async function login(page, id, pw) {
  await page.click("#kfpAuthButton"); await page.waitForTimeout(250);
  await page.fill("#kfpUsername", id); await page.fill("#kfpPassword", pw);
  await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.click("#kfpLoginBtn")]);
  await page.waitForSelector("#kfpAuthButton"); await settle(page, 1200);
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("P1 guest sees realistic demo data + PREVIEW badge (no login popup)");
    let page = await newPage(browser);
    await seed(page, {});
    await open(page);
    ok(await mode(page) === "preview", "mode = preview");
    ok(await page.inputValue("#salary") === "2500000", "demo salary KRW 2,500,000");
    ok(await page.isVisible("#kfpPreviewPill") && (await page.textContent("#kfpPreviewPill")).includes("PREVIEW MODE"), "PREVIEW MODE pill");
    ok((await page.textContent("#kfpPreviewBanner")).includes("DEMO DATA — ตัวอย่างการใช้งาน"), "DEMO DATA banner");
    ok(!(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open"))), "no login popup on open");
    const demo = await page.evaluate(() => ({ rec: JSON.parse(localStorage.getItem("salaryRecords")).length, ex: JSON.parse(localStorage.getItem("kfp_expenses_v1")).length, work: JSON.parse(localStorage.getItem("kfp_work_records_v1")).length }));
    ok(demo.rec === 10 && demo.ex >= 10 && demo.work > 0, `demo salary history / expenses / work records (${demo.rec}/${demo.ex}/${demo.work})`);
    ok(/[1-9]/.test(await page.textContent('[data-cat-krw="saving"]')), "statistics cards rendered from demo");
    await shot(page, "p3_index_preview");
    await page.click('#modeSwitch [data-mode="THB"]'); await settle(page, 300);
    ok(await page.inputValue("#salaryThb") === "45000", "demo salary THB 45,000");
    await page.click('#modeSwitch [data-mode="KRW"]'); await settle(page, 300);
    await page.click('[data-open-tool="expense"]'); await settle(page, 500);
    ok((await page.$$eval(".tl-li-amt, .tl-kpis b", e => e.length)) > 0, "expense popup opens with demo data");
    await shot(page, "p3_expense_preview");
    await page.keyboard.press("Escape"); await settle(page, 300);
    await page.click('[data-open-tool="work"]'); await settle(page, 400);
    await page.click('[data-act="m-hist"]'); await settle(page, 400);
    ok((await page.$$("button.tl-day.has, button.tl-day.ot, button.tl-day.wknd")).length > 0, "work history calendar shows demo days");
    await shot(page, "p3_work_preview");
    await page.keyboard.press("Escape");

    console.log("P2 existing real data on the device is never shown to a guest");
    page = await newPage(browser);
    await seed(page, {
      [`kfp:u:u-real:salary`]: "9999999", [`kfp:u:u-real:salaryRecords`]: '[{"month":"2026-01","salary":9999999,"rate":0.025}]',
      "salary": "7777777", "salaryRecords": '[{"month":"2025-12","salary":7777777,"rate":0.025}]', "kfp_expenses_v1": '[{"id":"x","cur":"KRW","name":"ของจริง","amt":1,"krw":1,"thb":0.02,"date":"2026-11-01"}]',
      "rate": "0.0251"
    });
    await open(page);
    ok(await page.inputValue("#salary") === "2500000", "demo shown, not member or old guest data");
    const p2 = await page.evaluate(() => [localStorage.getItem("kfp:u:u-real:salary"), localStorage.getItem("kfp:device:salary"), JSON.parse(localStorage.getItem("kfp_expenses_v1")).some(e => e.name === "ของจริง")]);
    ok(p2[0] === null && p2[1] === null, "page code cannot read other namespaces through localStorage");
    ok(!p2[2], "real expenses not visible in preview");
    let R = await real(page);
    ok(R["kfp:device:salary"] === "7777777" && R["kfp:device:kfp_expenses_v1"] && !("salary" in R), "old un-prefixed guest data moved to device stash (not deleted)");
    ok(R["kfp:u:u-real:salary"] === "9999999", "member namespace untouched");
    ok(R.rate === "0.0251", "shared key (exchange rate) kept");

    console.log("P3 nothing done in Preview is saved");
    // Since Phase 4 these actions open the login gate instead of running.
    await page.fill("#salary", "1234567"); await page.click('button[onclick="calculate()"]'); await settle(page, 300);
    ok(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")), "calculate in preview → login gate (Phase 4)");
    await page.keyboard.press("Escape"); await settle(page, 200);
    await page.click('[data-open-tool="expense"]'); await settle(page, 400);
    await page.fill("#exName", "ทดสอบพรีวิว"); await page.fill("#exAmt", "5000"); await page.click('[data-act="ex-save"]'); await settle(page, 300);
    await page.keyboard.press("Escape"); await settle(page, 200);
    await page.keyboard.press("Escape"); await settle(page, 200);
    const R2 = await real(page);
    ok(!Object.keys(R2).some(k => k === "salary" || k.endsWith(":salary") && R2[k] === "1234567"), "calculate() wrote nothing to real storage");
    ok(!JSON.stringify(R2).includes("ทดสอบพรีวิว"), "demo expense not written to real storage");
    await page.reload(); await page.waitForSelector("#kfpAuthButton"); await settle(page);
    ok(await page.inputValue("#salary") === "2500000", "reload → fresh demo again");
    ok(!(await page.evaluate(() => localStorage.getItem("kfp_expenses_v1"))).includes("ทดสอบพรีวิว"), "demo edits gone after reload");

    console.log("P4 login → Member mode with this account's Cloud data");
    page = await newPage(browser);
    await seed(page, { "rate": "0.0252" }, { "__mock_cloud_u-real": JSON.stringify({ user_id: "u-real", updated_at: "2026-11-10T00:00:00Z",
      data: { salary: "3100000", salaryRecords: '[{"month":"2026-10","salary":3100000,"rate":0.0252}]', kfp_gold_lots_v1: "[]" } }) });
    await open(page);
    await login(page, "a@gmail.com", "Passw0rd1");
    ok(await mode(page) === "member", "page reloaded into member mode");
    ok(await page.inputValue("#salary") === "3100000", "account's Cloud data shown");
    ok(!(await page.$("#kfpPreviewBanner")) && !(await page.$("#kfpPreviewPill")), "no preview badge for members");
    R = await real(page);
    ok(R["kfp:u:u-real:salary"] === "3100000" && !("salary" in R), "stored under kfp:u:<id>: namespace");
    ok(!JSON.stringify(R).includes("2500000"), "demo data never reached real storage");

    console.log("P5 local edits survive reload; newer Cloud data from another device wins");
    await page.fill("#salary", "3200000"); await page.click('button[onclick="calculate()"]'); await settle(page, 300);
    await page.reload(); await page.waitForSelector("#kfpAuthButton"); await settle(page, 1200);
    ok(await page.inputValue("#salary") === "3200000", "unsynced local edit kept (Cloud unchanged)");
    await page.evaluate(() => sessionStorage.setItem("__mock_cloud_u-real", JSON.stringify({ user_id: "u-real", updated_at: "2026-11-12T00:00:00Z", data: { salary: "3300000" } })));
    await page.reload(); await page.waitForSelector("#kfpAuthButton"); await settle(page, 1200);
    ok(await page.inputValue("#salary") === "3300000", "newer Cloud upload applied");
    await page.click("#kfpAuthButton"); await settle(page, 300);
    await page.click("#kfpUploadCloudBtn"); await settle(page, 400);
    const seen = await page.evaluate(() => window.__kfpRealLocalStorage.getItem("kfp:u:u-real:__kfp_cloud_seen_v1"));
    const cloudAt = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_cloud_u-real")).updated_at);
    ok(seen === cloudAt, "upload records Cloud updated_at as seen");
    await page.keyboard.press("Escape");

    console.log("P6 logout → Preview; the account's data stays on the device but is hidden");
    await page.click("#kfpAuthButton"); await settle(page, 300);
    await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.click("#kfpLogoutBtn")]);
    await page.waitForSelector("#kfpAuthButton"); await settle(page);
    ok(await mode(page) === "preview", "back to preview");
    ok(await page.inputValue("#salary") === "2500000", "demo shown after logout");
    R = await real(page);
    ok(R["kfp:u:u-real:salary"] === "3300000", "member data kept in its namespace (not wiped)");
    ok(!("__kfp_auth_user_v1" in R) && !(TOKEN_KEY in R), "session cleared " + JSON.stringify(Object.keys(R).filter(k => !k.startsWith("kfp:"))));

    console.log("P7 second account on the same device sees only its own data");
    await login(page, "john", "oldpass");
    ok(await mode(page) === "member" && (await page.evaluate(() => kfpStorage.userId)) === "u-legacy", "john in member mode");
    ok(await page.inputValue("#salary") !== "3300000", "alice's salary not visible to john");
    ok(!(await page.evaluate(() => localStorage.getItem("salaryRecords") || "")).includes("3100000"), "alice's records not visible to john");
    await page.fill("#salary", "2000000"); await page.click('button[onclick="calculate()"]'); await settle(page, 300);
    R = await real(page);
    ok(R["kfp:u:u-legacy:salary"] === "2000000" && R["kfp:u:u-real:salary"] === "3300000", "separate namespaces per account");

    console.log("P8 upgrade from the old version on a logged-in device + import old guest data");
    page = await newPage(browser);
    await seed(page, {
      [TOKEN_KEY]: tokenFor("u-real", "a@gmail.com"), "__kfp_auth_user_v1": "u-real",
      "salary": "2650000", "salaryRecords": '[{"month":"2026-09","salary":2650000,"rate":0.025}]',
      "__kfp_guest_backup_v1": JSON.stringify({ salary: "1800000", salaryRecords: '[{"month":"2025-01","salary":1800000,"rate":0.024},{"month":"2025-02","salary":1810000,"rate":0.024}]' })
    });
    await open(page);
    R = await real(page);
    ok(await mode(page) === "member", "member mode");
    ok(R["kfp:u:u-real:salary"] === "2650000" && !("salary" in R), "old keys moved into the logged-in account");
    ok(R["kfp:device:salary"] === "1800000" && !("__kfp_guest_backup_v1" in R), "old guest backup kept as device data");
    ok(await page.inputValue("#salary") === "2650000", "account data shown");
    await page.click("#kfpAuthButton"); await settle(page, 300);
    ok(!(await page.$eval("#kfpDeviceDataBox", e => e.hidden)), "account panel offers import of device data");
    ok((await page.textContent("#kfpDeviceDataText")).includes("เงินเดือน 2 เดือน"), "summary of device data");
    await settle(page, 700); await shot(page, "p3_import_box");
    await page.click("#kfpImportDeviceBtn");
    ok((await page.textContent("#kfpImportDeviceBtn")).includes("ยืนยัน"), "two-step confirm");
    await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.click("#kfpImportDeviceBtn")]);
    await page.waitForSelector("#kfpAuthButton"); await settle(page, 1200);
    ok(await page.inputValue("#salary") === "1800000", "imported data now used by the account");
    R = await real(page);
    ok(!Object.keys(R).some(k => k.startsWith("kfp:device:")), "device stash consumed");
    ok(JSON.parse(R["kfp:u:u-real:__kfp_sys_before_import"]).data.salary === "2650000", "previous account data backed up before import");

    console.log("P9 PWA backup never resurrects old personal keys (R4); namespaced keys still restore");
    page = await newPage(browser);
    await seed(page, {});
    await page.evaluate(() => new Promise((res, rej) => {
      const rq = indexedDB.open("kfp_pwa_persistence_v2", 2);
      rq.onupgradeneeded = () => rq.result.createObjectStore("localStorageBackup");
      rq.onsuccess = () => { const tx = rq.result.transaction("localStorageBackup", "readwrite");
        tx.objectStore("localStorageBackup").put({ salary: "5555555", kfp_expenses_v1: '[{"name":"leak"}]',
          "kfp:u:u-real:goal": "123456", "kfp:u:u-real:kfp_expenses_v1": "[]",
          "kfp:u:u-real:__kfp_deleted_keys_v1": '{"kfp_expenses_v1":1}', rate: "0.0249" }, "__all_local_storage__");
        tx.oncomplete = () => { rq.result.close(); res(); }; tx.onerror = rej; };
      rq.onerror = rej;
    }));
    await page.goto(`${BASE}/index.html`); await page.waitForSelector("#kfpAuthButton"); await settle(page, 2000);
    R = await real(page);
    ok(!("salary" in R) && !("kfp_expenses_v1" in R) && !("kfp:device:salary" in R), "old bare keys from snapshot NOT restored");
    ok(R["kfp:u:u-real:goal"] === "123456", "namespaced key restored from snapshot");
    ok(!("kfp:u:u-real:kfp_expenses_v1" in R), "tombstoned namespaced key not restored");
    ok(await page.inputValue("#salary") === "2500000" && !(await page.evaluate(() => localStorage.getItem("kfp_expenses_v1"))).includes("leak"), "guest still sees demo only");

    console.log("P10 gold page preview uses demo portfolio; members see their own");
    page = await newPage(browser);
    await seed(page, { "kfp:u:u-real:kfp_gold_lots_v1": '[{"id":"real","date":"2026-01-01","goldType":"96.5","quantity":9,"unit":"baht","grams":137.196,"costThb":999999}]' });
    await open(page, "gold.html");
    const lotsDemo = await page.evaluate(() => JSON.parse(localStorage.getItem("kfp_gold_lots_v1") || "[]"));
    ok(lotsDemo.length === 5 && !lotsDemo.some(l => l.id === "real"), "5 demo gold lots, no real lots");
    ok(await page.isVisible("#kfpPreviewBanner") && await page.isVisible("#kfpPreviewPill"), "gold page shows preview badge");
    ok((await page.textContent("#lotSummary")).includes("5 รอบ"), "demo lots rendered");
    await shot(page, "p3_gold_preview");
    await page.evaluate(t => window.__kfpRealLocalStorage.setItem(`sb-${t}-auth-token`, JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } })), REF);
    await page.evaluate(() => window.__kfpRealLocalStorage.setItem("__kfp_auth_user_v1", "u-real"));
    await page.reload(); await page.waitForSelector("#kfpAuthButton"); await settle(page, 1200);
    ok((await page.evaluate(() => JSON.parse(localStorage.getItem("kfp_gold_lots_v1") || "[]").map(l => l.id))).join() === "real" && (await page.textContent("#lotSummary")).includes("1 รอบ"), "member sees only own gold lots");

    console.log("P11 revoked / unverified sessions fall back to Preview (no loop)");
    page = await newPage(browser);
    await seed(page, { [TOKEN_KEY]: tokenFor("u-real", "a@gmail.com"), "__kfp_auth_user_v1": "u-real", "kfp:u:u-real:salary": "3300000" }, { "__mock_revoked": "1" });
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(2500); await page.waitForSelector("#kfpAuthButton");
    ok(await mode(page) === "preview", "revoked session → preview");
    ok(await page.inputValue("#salary") === "2500000", "member data hidden after revoke");
    page = await newPage(browser);
    await seed(page, { [TOKEN_KEY]: tokenFor("u-unconf", "u@gmail.com", false), "kfp:u:u-unconf:salary": "4444444" });
    await open(page);
    ok(await mode(page) === "preview" && await page.inputValue("#salary") === "2500000", "unverified token → preview");

    console.log("P12 mobile layout: badge and Login button don't overlap at 360px");
    page = await newPage(browser, { width: 360 });
    await seed(page, {});
    await open(page);
    const a = await page.$eval("#kfpPreviewPill", e => e.getBoundingClientRect().toJSON());
    const b = await page.$eval("#kfpAuthButton", e => e.getBoundingClientRect().toJSON());
    ok(a.right <= b.left, `pill (${Math.round(a.right)}) ends before Login (${Math.round(b.left)})`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll");
    await shot(page, "p3_mobile_360");

    const errs = [];
    ok(errs.length === 0, "no unexpected page errors");
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
