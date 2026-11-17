/* Phase 19 e2e: PLANNER Product Showcase + guest routing + brand.
 * Does NOT load demo-seed.js — it tests the guest → showcase redirect itself.
 * Run: node tests/e2e/phase19.test.js   (SHOT_DIR=… for screenshots) */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8819, BASE = `http://localhost:${PORT}`;
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

async function newPage(browser, viewport = { width: 390, height: 844 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block", reducedMotion: opts.reducedMotion || "no-preference" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { page.errors.push(e.message); console.log("    [pageerror]", e.message); });
  await page.route("**/*", r => {
    const u = r.request().url();
    if (u.includes("@supabase/supabase-js")) return r.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.includes("/functions/v1/")) return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    if (u.startsWith(BASE)) return r.continue();
    return r.abort();
  });
  return page;
}
const member = () => ({ [TOKEN_KEY]: JSON.stringify({ access_token: "at-a@gmail.com", refresh_token: "rt", expires_at: 9999999999, user: { id: "u-real", email: "a@gmail.com", email_confirmed_at: "2026-01-01" } }), "__kfp_auth_user_v1": "u-real" });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear();
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const file = page => new URL(page.url()).pathname.split("/").pop();
async function shot(page, name, full) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full }); }
const num = s => Number(String(s).replace(/[^\d.-]/g, ""));

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("S1 guest routing");
    let page = await newPage(browser);
    await seed(page);
    await page.goto(`${BASE}/index.html`); await settle(page, 1200);
    ok(file(page) === "showcase.html", "guest opening index.html lands on the showcase");
    ok((await page.title()).startsWith("PLANNER"), "showcase title carries the PLANNER brand");
    ok(!(await page.$("#kfpPreviewBanner")) && !(await page.$("#kfpPreviewPill")), "no PREVIEW MODE banner/pill on the showcase");
    ok((await txt(page, "h1")).includes("เงินทุกก้อนมีที่มา") && (await txt(page, "h1")).includes("ทุกเป้าหมายมีแผน"), "hero headline");
    ok(await vis(page, 'button[data-auth="register"]:has-text("เริ่มจัดการการเงินของฉัน")') && await vis(page, 'a:has-text("สำรวจฟีเจอร์ทั้งหมด")'), "both hero CTAs");
    ok(!(await vis(page, "a[data-member]")), "member-only ‘open my app’ hidden for guests");
    await shot(page, "s1_hero");
    await page.click('a.sc-btn[data-demo]:visible >> nth=0').catch(async () => page.click('.sc-fine a[data-demo]'));
    await settle(page, 1300);
    ok(file(page) === "index.html" && await vis(page, "#kfpPreviewBanner"), "‘ลองแอปจริง’ opens the live demo app in preview mode");
    await page.goto(`${BASE}/index.html`); await settle(page, 1200);
    ok(file(page) === "index.html", "demo choice remembered for this tab (no bounce back)");
    ok(await vis(page, '#kfpPreviewBanner a[data-pv-exit]'), "preview banner links back to the showcase");
    await page.click('#kfpPreviewBanner a[data-pv-exit]'); await settle(page, 1000);
    ok(file(page) === "showcase.html", "exit link returns to the showcase");
    await page.goto(`${BASE}/index.html`); await settle(page, 1000);
    ok(file(page) === "showcase.html", "after leaving the demo, index.html again routes guests to the showcase");
    await page.goto(`${BASE}/index.html?demo=1`); await settle(page, 1200);
    ok(file(page) === "index.html" && await vis(page, "#kfpPreviewBanner"), "index.html?demo=1 deep-link opens the demo app");
    await page.close();

    console.log("S2 members are never redirected");
    page = await newPage(browser);
    await seed(page, member());
    await page.goto(`${BASE}/index.html`); await settle(page, 1500);
    ok(file(page) === "index.html" && !(await vis(page, "#kfpPreviewBanner")), "member opening index.html stays in the app");
    await page.goto(`${BASE}/showcase.html`); await settle(page, 1200);
    ok(await vis(page, "a[data-member]") && !(await vis(page, 'button[data-auth="register"]')), "member on showcase sees ‘เปิดแอปของฉัน’ instead of sign-up");
    ok((await page.$$eval("a[data-demo]", as => as.every(a => a.getAttribute("href") === "index.html"))), "demo links point members to their own app");
    await page.close();

    console.log("S3 sign-up/login from the showcase lands in the app");
    page = await newPage(browser);
    await seed(page);
    await page.goto(`${BASE}/showcase.html`); await settle(page, 1200);
    await page.click('.sc-nav button[data-auth="login"]'); await settle(page, 400);
    ok(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")), "‘เข้าสู่ระบบ’ opens the auth panel");
    ok(!/Korea/.test(await txt(page, "#kfpAuthPanel")), "auth panel no longer says ‘Korea Finance Planner’");
    await page.fill("#kfpUsername", "a@gmail.com"); await page.fill("#kfpPassword", "Passw0rd1");
    await Promise.all([page.waitForEvent("load", { timeout: 8000 }).catch(() => {}), page.click("#kfpLoginBtn")]);
    await settle(page, 2500);
    ok(file(page) === "index.html", "after login the showcase forwards to the app");
    ok(await page.evaluate(() => window.kfpStorage && window.kfpStorage.isMember()), "…in member mode");
    await page.close();

    console.log("S4 demos are interactive and honest (390px)");
    page = await newPage(browser);
    await seed(page);
    await page.goto(`${BASE}/showcase.html`); await settle(page, 800);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal scroll at 390px");
    const demoTags = await page.$$eval(".sc-demo-box .sc-demo, .sc-dash .sc-demo", e => e.length);
    ok(demoTags >= 8, "every demo panel is tagged DEMO DATA (" + demoTags + ")");
    // salary
    await page.locator("#salary").scrollIntoViewIfNeeded(); await settle(page, 600);
    ok((await txt(page, "#salAmt")) === "₩2,500,000" && (await txt(page, "#salVal_save")).startsWith("₩1,000,000") && (await txt(page, "#salVal_save")).includes("฿24,000"), "2.5M ₩ × 40% = ₩1,000,000 ≈ ฿24,000");
    ok(await page.isHidden("#salWarn"), "40/35/15/10 adds up to 100% (no warning)");
    await page.$eval("#sal_save", e => { e.value = 50; e.dispatchEvent(new Event("input", { bubbles: true })); });
    ok((await txt(page, "#salTotPct")) === "110%" && (await txt(page, "#salWarn")).includes("เกิน"), "slider to 50% → total 110% and over-allocation warning");
    await page.$eval("#sal_save", e => { e.value = 40; e.dispatchEvent(new Event("input", { bubbles: true })); });
    // expenses
    await page.locator("#expList").scrollIntoViewIfNeeded(); await settle(page, 1800);
    ok((await txt(page, "#expTotal")) === "₩422,200" && (await txt(page, "#expTotal2")).includes("฿10,133"), "expense total ₩422,200 ≈ ฿10,133");
    // work
    await page.locator("#workCal").scrollIntoViewIfNeeded(); await settle(page, 2200);
    ok((await txt(page, "#wExp")) === "₩2,291,040", "expected wage from the demo calendar = ₩2,291,040");
    ok((await txt(page, "#wDiff")).includes("น้อยกว่า") && (await txt(page, "#wDiff")).includes("₩41,040"), "actual ₩2,250,000 → short by ₩41,040");
    ok((await txt(page, "#work")).includes("ไม่ใช่การรับรองตามกฎหมาย"), "wage disclaimer shown");
    // history toggle
    await page.locator("#histChart").scrollIntoViewIfNeeded(); await settle(page, 800);
    const avgK = await txt(page, "#histAvg");
    await page.click('[data-hist="THB"]'); await settle(page, 300);
    ok(avgK.startsWith("₩") && (await txt(page, "#histAvg")).startsWith("฿"), "history chart toggles ₩ → ฿");
    // countdown ticks
    const s1 = await txt(page, '[data-cd="s"]'); await settle(page, 1300);
    ok(s1 !== (await txt(page, '[data-cd="s"]')), "contract countdown ticks every second");
    ok(/ของสัญญา 3 ปี/.test(await txt(page, "#cdPct")), "contract progress shown");
    // debt: transfer is not double counted
    await page.locator(".sc-debt-demo").scrollIntoViewIfNeeded(); await settle(page, 3200);
    ok((await txt(page, '[data-cc="a"]')) === "฿0" && (await txt(page, '[data-cc="b"]')) === "฿25,000" && (await txt(page, "#debtAfter")) === "฿25,000", "transfer A→B moves ฿20,000; total debt stays ฿25,000");
    // gold
    await page.locator("#goldRows").scrollIntoViewIfNeeded();
    await page.$eval("#goldPx", e => { e.dispatchEvent(new Event("pointerdown")); e.value = 61900; e.dispatchEvent(new Event("input", { bubbles: true })); });
    ok((await txt(page, "#gW")) === "1.75" && (await txt(page, "#gP")) === "+฿4,125" && (await txt(page, "#gAvg")) === "฿59,543", "gold at ฿61,900: P/L +฿4,125, avg cost ฿59,543/บาท");
    const lot3 = await page.$eval("#goldRows tr:nth-child(3) td.pl", e => e.textContent);
    ok(lot3 === "−฿125", "per-round P/L: round #003 is −฿125 while the portfolio is up");
    await page.$eval("#goldPx", e => { e.value = 57000; e.dispatchEvent(new Event("input", { bubbles: true })); });
    ok((await txt(page, "#gP")).startsWith("−"), "drag price down → portfolio P/L turns negative");
    ok((await txt(page, "#gold")).includes("Coming Soon") && (await txt(page, "#gold")).includes("ราคารับซื้อ"), "gold: sale recording marked Coming Soon; valuation assumption stated");
    ok((await txt(page, "#overview")).includes("Coming Soon"), "unified overview page marked Coming Soon");
    await shot(page, "s4_mobile_full", true);
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("S5 audience: Thailand = THB only, Korea features still reachable");
    page = await newPage(browser, { width: 1280, height: 900 });
    await seed(page);
    await page.goto(`${BASE}/showcase.html`); await settle(page, 800);
    await page.click("#audTH"); await settle(page, 300);
    ok(await page.getAttribute("#audTH", "aria-selected") === "true", "TH tab selected");
    ok((await txt(page, "#salAmt")) === "฿35,000" && !(await page.innerText("#salary .sc-demo-box")).includes("₩") && !(await page.innerText("#salary .sc-copy")).includes("₩"), "salary demo is THB-only");
    ok(!(await page.innerText("#expense")).includes("₩") && !(await txt(page, "#expense h2")).includes("วอน"), "expense demo + headline have no KRW");
    ok(await page.isHidden("#work") && await page.isHidden("#contract") && await vis(page, ".sc-kr-teaser"), "Korea-only sections collapse into a teaser (not removed)");
    await page.click('.sc-kr-teaser [data-aud="KR"]'); await settle(page, 900);
    ok(await vis(page, "#work") && await page.getAttribute("#audKR", "aria-selected") === "true", "teaser brings the Korea features back");
    await page.click("#audTH"); await page.reload(); await settle(page, 800);
    ok(await page.getAttribute("#audTH", "aria-selected") === "true", "audience choice remembered in this tab");
    await shot(page, "s5_desktop_th", true);
    await page.close();

    console.log("S6 reduced motion + brand");
    page = await newPage(browser, { width: 390, height: 844 }, { reducedMotion: "reduce" });
    await seed(page);
    await page.goto(`${BASE}/showcase.html`); await settle(page, 600);
    ok(await page.$$eval(".sc-reveal", es => es.every(e => getComputedStyle(e).opacity === "1")), "reduced motion: all content visible without animation");
    await page.close();
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    ok(/^planner/i.test(man.name) && !/เกาหลี$/.test(man.description), "manifest name/description rebranded");
    const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    ok(["showcase.html", "showcase.css", "showcase.js"].every(f => sw.includes(`'${f}'`)), "showcase assets precached by the service worker");
    const titles = ["pricing.html", "account.html", "admin.html", "auth-callback.html", "index.html", "gold.html", "credit-debt.html"]
      .map(f => /<title>([^<]*)<\/title>/.exec(fs.readFileSync(path.join(ROOT, f), "utf8"))[1]);
    ok(titles.every(t => t.includes("PLANNER") && !t.includes("Korea")), "every page title carries PLANNER");
    console.log("S7 logo, app name, icons");
    ok(man.short_name === "Planner" && man.icons.every(i => !/^https?:/.test(i.src) && fs.existsSync(path.join(ROOT, i.src))), "manifest: app name ‘Planner’, icons are local files that exist");
    ok(man.icons.some(i => i.purpose === "maskable"), "maskable icon present");
    const heads = ["pricing.html", "account.html", "admin.html", "auth-callback.html", "index.html", "gold.html", "credit-debt.html", "showcase.html"].map(f => fs.readFileSync(path.join(ROOT, f), "utf8"));
    ok(heads.every(h => h.includes('href="favicon.ico"') && h.includes("apple-touch-icon.png") && h.includes('apple-mobile-web-app-title" content="Planner"')), "favicon + touch icon + ‘Planner’ title on every page");
    ok(["favicon.ico", "assets/brand/planner-logo.png", "assets/brand/apple-touch-icon.png"].every(f => sw.includes(`'${f}'`)), "logo + icons precached");
    page = await newPage(browser);
    await seed(page, {}, { kfp_demo: "1" });
    await page.goto(`${BASE}/index.html`); await settle(page, 1500);
    ok(!(await txt(page, "body")).includes("สู้หน่อยดิว้ะ") && !(await txt(page, "body")).includes("จะได้เติบโตสักที"), "old heading/subtitle gone from the app");
    ok(await page.$eval(".pl-brand .pl-logo img", i => i.complete && i.naturalWidth > 0) && (await txt(page, ".pl-brand-sub")) === "Personal Finance Control Center", "app header shows the P logo + ‘Personal Finance Control Center’");
    ok((await page.$eval(".pl-brand .pl-logo img", i => getComputedStyle(i).animationName)).includes("pl-glow"), "logo glow is animated");
    await page.goto(`${BASE}/showcase.html`); await settle(page, 800);
    ok(await page.$eval(".sc-logo .pl-logo img", i => i.complete && i.naturalWidth > 0) && !(await page.$eval(".sc-logo", e => e.textContent)).includes("P\u200b"), "showcase nav uses the P logo image");
    await page.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
