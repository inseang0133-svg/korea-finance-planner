/* Phase 25 e2e: automatic, quiet Cloud Sync (kfp-cloud-sync.js) — upload on change, apply other devices'
 * changes without reload, defer redraw while typing, 3-way merge offline/conflicts, deletions, newer-wins,
 * Free plan stays local, empty new device never wipes the Cloud, logout uploads first.
 * Run: node tests/e2e/phase25.test.js */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8825, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { page.errors.push(e.message); console.log("    [pageerror]", e.message); });
  page.on("dialog", d => d.dismiss());
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
const member = () => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", expires_at: 9999999999, user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" });
const iso = ms => new Date(Date.now() + ms).toISOString();
const rec = (m, s) => ({ month: m, salary: s, rate: 0.024, salaryThb: Math.round(s * 0.024), mode: "KRW" });
function cloudRow(at, data) { return JSON.stringify({ user_id: "u-real", updated_at: at, data }); }
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem("kfp_demo", "1");
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => c.name === n), name);
const cloud = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_cloud_u-real") || "null"));
const setCloud = (page, row) => page.evaluate(r => sessionStorage.setItem("__mock_cloud_u-real", r), row);
const local = (page, k) => page.evaluate(k => localStorage.getItem(k), k);
const months = page => page.evaluate(() => JSON.parse(localStorage.getItem("salaryRecords") || "[]").map(r => r.month).sort().join(","));
const marker = page => page.evaluate(() => window.__noReload === 1);
const phase = page => page.evaluate(() => window.kfpCloudSync.status().phase);
async function waitUpload(page, n, ms = 6000) {
  await page.waitForFunction(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => c.name === "upsert:user_data").length >= n, n, { timeout: ms }).catch(() => {});
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("C1 page open: Cloud copy applied, nothing uploaded, base remembered");
    let page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR",
      "__mock_cloud_u-real": cloudRow(iso(-86400000), { salary: "2500000", goal: "2000000", salaryRecords: JSON.stringify([rec("2026-09", 2500000)]), kfp_mode_v1: "KRW" }) });
    await page.goto(`${BASE}/index.html`); await settle(page, 2500);
    await page.evaluate(() => { window.__noReload = 1; });
    ok(await page.inputValue("#salary") === "2500000" && (await months(page)) === "2026-09", "Cloud data on screen");
    ok((await calls(page, "upsert:user_data")).length === 0, "opening the page uploads nothing");
    ok(await page.evaluate(() => !!localStorage.getItem("__kfp_cloud_base_v1") && window.kfpCloudSync.status().active), "auto sync active, synced copy remembered");

    console.log("C2 edit → uploaded by itself (no button, no reload)");
    await page.fill("#salary", "2600000"); await page.click('button[onclick="calculate()"]');
    await waitUpload(page, 1);
    ok(JSON.parse((await cloud(page)).data ? JSON.stringify((await cloud(page)).data) : "{}").salary === "2600000", "new salary reached the Cloud within the debounce");
    await page.fill("#salaryMonth", "2026-10"); await page.fill("#salaryRecord", "2600000"); await page.click('button[onclick="addSalaryRecord()"]');
    await waitUpload(page, 2);
    ok(JSON.parse((await cloud(page)).data.salaryRecords).map(r => r.month).sort().join() === "2026-09,2026-10", "new salary month uploaded too");
    ok(await page.evaluate(() => localStorage.getItem("__kfp_cloud_seen_v1")) === (await cloud(page)).updated_at && await phase(page) === "synced", "device knows it is in step with the Cloud");
    ok(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("__kfp_cloud_dirty_v1") || "{}")).length === 0), "nothing left pending");
    await page.click("#kfpAuthButton"); await settle(page, 300);
    ok(/ซิงก์แล้ว/.test(await page.textContent("#kfpCloudLast")) && /ซิงก์ตอนนี้/.test(await page.textContent("#kfpUploadCloudBtn")), "account panel: 'ซิงก์แล้ว · time' + 'ซิงก์ตอนนี้'");
    await page.keyboard.press("Escape"); await settle(page, 200);

    console.log("C3 another device changed the Cloud → this page updates in place");
    await page.evaluate(() => window.scrollTo(0, 900)); await settle(page, 200);
    const y0 = await page.evaluate(() => window.scrollY);
    const c3 = (await cloud(page)).data;
    await setCloud(page, cloudRow(iso(60000), Object.assign({}, c3, { salary: "2700000",
      salaryRecords: JSON.stringify(JSON.parse(c3.salaryRecords).concat([rec("2026-08", 2400000)])) })));
    await page.evaluate(() => window.kfpCloudSync.pull()); await settle(page, 700);
    ok(await page.inputValue("#salary") === "2700000" && (await months(page)) === "2026-08,2026-09,2026-10", "salary + new month from the other device shown");
    ok(/2026-08|ส\.ค\.|สิงหาคม/.test(await page.textContent("#salaryHistory")) || (await page.$$eval("#salaryHistory *", e => e.length)) > 0, "history list redrawn");
    ok(await marker(page), "no reload");
    ok(Math.abs((await page.evaluate(() => window.scrollY)) - y0) <= 2, "scroll position kept");
    ok(await page.evaluate(() => !window.Chart || window.Chart.defaults.animation !== false), "chart animation setting restored after the quiet redraw");
    ok((await calls(page, "upsert:user_data")).length === 2, "applying someone else's change uploads nothing back");

    console.log("C4 typing: redraw waits until the field is left");
    await page.focus("#salaryRecord");
    await setCloud(page, cloudRow(iso(120000), Object.assign({}, (await cloud(page)).data, { salary: "2800000" })));
    await page.evaluate(() => window.kfpCloudSync.pull()); await settle(page, 600);
    ok(await local(page, "salary") === "2800000" && await page.inputValue("#salary") === "2700000", "data stored, screen untouched while typing");
    await page.evaluate(() => document.activeElement.blur()); await settle(page, 1800);
    ok(await page.inputValue("#salary") === "2800000", "redrawn after leaving the field");

    console.log("C5 offline edits + other device edits → merged, nothing lost, deletions respected");
    await page.evaluate(() => sessionStorage.setItem("__mock_cloud_fail", "1"));
    await page.evaluate(() => { const l = JSON.parse(localStorage.getItem("salaryRecords")); l.push({ month: "2026-11", salary: 2650000, rate: 0.024, salaryThb: 63600, mode: "KRW" }); localStorage.setItem("salaryRecords", JSON.stringify(l)); });
    await settle(page, 2500);
    ok(["pending", "error"].includes(await phase(page)), "offline: waits, data safe on the device");
    const c5 = (await cloud(page)).data;
    const other = JSON.parse(c5.salaryRecords).filter(r => r.month !== "2026-09").concat([rec("2026-07", 2300000)]);   // other device: deleted 09, added 07
    await setCloud(page, cloudRow(iso(180000), Object.assign({}, c5, { salaryRecords: JSON.stringify(other), goal: "5000000" })));
    await page.evaluate(() => { sessionStorage.removeItem("__mock_cloud_fail"); window.dispatchEvent(new Event("online")); });
    await page.waitForFunction(() => JSON.parse(JSON.parse(sessionStorage.getItem("__mock_cloud_u-real")).data.salaryRecords).some(r => r.month === "2026-11"), null, { timeout: 8000 }).catch(() => {});
    ok((await months(page)) === "2026-07,2026-08,2026-10,2026-11", "device: kept its new month, got the other's new month, 09 deleted as on the other device");
    ok(JSON.parse((await cloud(page)).data.salaryRecords).map(r => r.month).sort().join() === "2026-07,2026-08,2026-10,2026-11", "Cloud: same merged list");
    ok(await local(page, "goal") === "5000000" && (await cloud(page)).data.goal === "5000000", "the other device's goal kept");
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem("__kfp_cloud_backup_v1") || "{}").why === "merge"), "values that were merged are kept in a backup");
    ok(await marker(page), "still no reload");

    console.log("C6 same setting changed on both → the newer edit wins");
    await page.evaluate(() => sessionStorage.setItem("__mock_cloud_fail", "1"));
    await page.evaluate(() => localStorage.setItem("goal", "6000000")); await settle(page, 2200);
    await setCloud(page, cloudRow(iso(-3600000 + 240000), Object.assign({}, (await cloud(page)).data, { goal: "7000000" })));   // older than the edit here
    await page.evaluate(() => { sessionStorage.removeItem("__mock_cloud_fail"); window.dispatchEvent(new Event("online")); }); await settle(page, 2500);
    ok(await local(page, "goal") === "6000000" && (await cloud(page)).data.goal === "6000000", "edit here was newer → kept and uploaded");
    await setCloud(page, cloudRow(iso(600000), Object.assign({}, (await cloud(page)).data, { goal: "8000000" })));
    await page.evaluate(() => window.kfpCloudSync.pull()); await settle(page, 800);
    ok(await local(page, "goal") === "8000000", "later edit from the other device applied");
    ok(page.errors.length === 0, "no page errors");

    console.log("C7 logout uploads pending edits first");
    await page.fill("#salary", "2900000"); await page.click('button[onclick="calculate()"]');
    await page.click("#kfpAuthButton"); await settle(page, 200);
    await page.click("#kfpLogoutBtn"); await settle(page, 2500);
    const order = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").map(c => c.name).filter(n => n === "upsert:user_data" || n === "signOut"));
    ok((await cloud(page)).data.salary === "2900000", "last edit reached the Cloud");
    ok(order.lastIndexOf("upsert:user_data") < order.lastIndexOf("signOut"), "upload happened before signing out");
    await page.close();

    console.log("C8 Free plan: stays on the device, never uploads by itself");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "free", __mock_country: "KR",
      "__mock_cloud_u-real": cloudRow(iso(-86400000), { salary: "2500000" }) });
    await page.goto(`${BASE}/index.html`); await settle(page, 2500);
    await page.fill("#salary", "2550000"); await page.click('button[onclick="calculate()"]'); await settle(page, 3000);
    ok((await calls(page, "upsert:user_data")).length === 0 && await local(page, "salary") === "2550000", "Free: edit kept locally, nothing uploaded");
    ok(await phase(page) === "locked" || !(await page.evaluate(() => window.kfpCloudSync.status().active)), "auto sync off for Free");
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("C9 new device (empty) never wipes the Cloud");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "plus", __mock_country: "KR",
      "__mock_cloud_u-real": cloudRow(iso(-3600000), { salary: "3100000", goal: "2000000", salaryRecords: JSON.stringify([rec("2026-10", 3100000)]), kfp_mode_v1: "KRW" }) });
    await page.goto(`${BASE}/index.html`); await settle(page, 4000);
    ok(await page.inputValue("#salary") === "3100000" && (await months(page)) === "2026-10", "Cloud data arrives on the new device");
    ok((await calls(page, "upsert:user_data")).length === 0 && (await cloud(page)).data.salary === "3100000", "nothing uploaded, Cloud intact");

    console.log("C10 first upload when the Cloud is empty");
    await page.evaluate(() => sessionStorage.removeItem("__mock_cloud_u-real"));
    await page.reload(); await settle(page, 3500);
    ok((await cloud(page)) && (await cloud(page)).data.salary === "3100000", "device data becomes the first Cloud copy");
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("C11 Cloud unreachable when the page opens → no upload until the Cloud copy was read");
    page = await newPage(browser);
    await seed(page, member(), { "__mock_plan_u-real": "premium", __mock_country: "KR", __mock_cloud_fail: "1",
      "__mock_cloud_u-real": cloudRow(iso(-3600000), { salary: "4000000" }) });
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    await page.fill("#salary", "4100000"); await page.click('button[onclick="calculate()"]'); await settle(page, 2500);
    ok((await calls(page, "upsert:user_data")).length === 0 && (await cloud(page)).data.salary === "4000000", "offline at open: edit kept, Cloud untouched");
    await page.evaluate(() => { sessionStorage.removeItem("__mock_cloud_fail"); window.dispatchEvent(new Event("online")); }); await settle(page, 3500);
    ok(["4000000", "4100000"].includes((await cloud(page)).data.salary) && await local(page, "salary") === (await cloud(page)).data.salary, "back online: read first, then device and Cloud agree");
    ok(page.errors.length === 0, "no page errors");
    await page.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 25 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
