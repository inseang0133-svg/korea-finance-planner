/* Phase 21 e2e: chat with admin (member) · unread badge on "บัญชี" · admin inbox + announcements.
 * Run: node tests/e2e/phase21.test.js */
const { chromium } = require("playwright");
require("./demo-seed");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8821, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": (TYPES[path.extname(p)] || "application/octet-stream") + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }
async function newPage(browser, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { page.errors.push(e.message); console.log("    [pageerror]", e.message); });
  page.on("dialog", d => { page.errors.push("native dialog: " + d.message()); d.dismiss(); });
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
const T0 = Date.now(), iso = m => new Date(T0 + m * 60000).toISOString();
const STORE = () => JSON.stringify({ seq: 0, threads: { "u-real": { status: "open", last_message_at: iso(-30), user_read_at: iso(-50) } },
  messages: [{ id: "m1", user_id: "u-real", sender: "user", body: "กราฟไม่ขึ้นครับ", created_at: iso(-60) },
             { id: "m2", user_id: "u-real", sender: "admin", body: "แก้แล้วครับ <img src=x onerror=window.__xss=1>", created_at: iso(-30) }],
  anns: [{ id: "a1", title: "ฟีเจอร์ใหม่", body: "แชทกับแอดมินได้แล้ว", kind: "success", created_at: iso(-10), expires_at: null, deleted_at: null }] });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem("kfp_demo", "1");
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const badge = page => page.evaluate(() => { const b = [...document.querySelectorAll('.pn-item[data-k="account"] .pn-badge')].find(x => x.offsetParent !== null); return b ? b.textContent : ""; });
const store = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_support") || "{}"));

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("C1 guest");
    let page = await newPage(browser);
    await seed(page);
    await page.goto(`${BASE}/account.html`); await settle(page, 1500);
    ok(await vis(page, "#supportCard") && (await badge(page)) === "", "account page shows the contact card; no badge for guests");
    await page.click("#supportCard [data-support-open]"); await settle(page, 600);
    ok(await vis(page, ".ks-panel") && /เข้าสู่ระบบ/.test(await txt(page, ".ks-body")) && !(await vis(page, "#ksForm")), "guest sees a log-in prompt instead of the composer");
    await page.click("[data-ks-login]"); await settle(page, 500);
    ok(!(await vis(page, ".ks-panel")) && await page.$eval("#kfpAuthPanel", e => e.classList.contains("open")), "log-in button closes chat and opens the auth panel");
    await page.close();

    console.log("C2 member: red badge → open chat → badge clears");
    page = await newPage(browser);
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE() });
    await page.goto(`${BASE}/index.html`); await settle(page, 2200);
    ok((await badge(page)) === "2", "badge on บัญชี = 2 (1 reply + 1 announcement)");
    ok(await page.getAttribute('.pn .pn-item[data-k="account"]', "href") === "account.html#support" && /ข้อความใหม่ 2/.test(await page.getAttribute('.pn .pn-item[data-k="account"]', "aria-label")), "tab links straight to the chat, announced to screen readers");
    await page.click('.pn .pn-item[data-k="account"]');
    await page.waitForURL(/account\.html#support/, { timeout: 4000 }).catch(() => {}); await settle(page, 2200);
    ok(await vis(page, ".ks-panel"), "account.html#support opens the chat");
    const body = await txt(page, "#ksBody");
    ok(/กราฟไม่ขึ้นครับ/.test(body) && /ฟีเจอร์ใหม่/.test(body) && await vis(page, ".ks-new"), "conversation + announcement + ‘ข้อความใหม่’ divider");
    ok(/<img src=x/.test(await txt(page, ".ks-them:not(.ks-hello) .ks-bubble p")) && !(await page.$(".ks-body img[src='x']")) && !(await page.evaluate(() => window.__xss)), "staff text rendered as plain text (no HTML)");
    ok((await badge(page)) === "" && (await store(page)).threads["u-real"].ann_read_at, "reading in the chat clears the badge (marked read on the server)");
    ok(await page.isHidden("#supportCount"), "account card counter cleared too");

    console.log("C3 send");
    await page.fill("#ksText", "ขอบคุณครับ ใช้ได้แล้ว");
    await page.click(".ks-send"); await settle(page, 800);
    ok((await page.$$eval(".ks-me .ks-bubble p", ps => ps.map(p => p.textContent))).includes("ขอบคุณครับ ใช้ได้แล้ว") && (await store(page)).messages.some(m => m.body === "ขอบคุณครับ ใช้ได้แล้ว"), "message sent and shown");
    ok((await page.$eval("#ksText", e => e.value)) === "" && await page.$eval(".ks-send", b => b.disabled), "composer cleared, send disabled while empty");
    await page.evaluate(() => sessionStorage.setItem("__mock_support_fail", "1"));
    await page.fill("#ksText", "ลองอีกครั้ง"); await page.click(".ks-send"); await settle(page, 700);
    ok(await vis(page, ".ks-failed .ks-retry") && /ส่งบ่อยเกินไป/.test(await txt(page, ".ks-failed")), "failed send shows a retry (rate limit message)");
    await page.evaluate(() => sessionStorage.removeItem("__mock_support_fail"));
    await page.click(".ks-retry"); await settle(page, 800);
    ok(!(await page.$(".ks-failed")) && (await store(page)).messages.some(m => m.body === "ลองอีกครั้ง"), "retry sends it");
    await page.keyboard.press("Escape"); await settle(page, 500);
    ok(!(await vis(page, ".ks-panel")) && !/#support/.test(page.url()), "Escape closes the chat and drops #support");

    console.log("C4 quick sheet + admin reply cycle");
    await page.goto(`${BASE}/index.html`); await settle(page, 1800);
    await page.click(".pn .pn-add"); await settle(page, 500);
    await page.click('#pnSheet [data-q="support"]'); await settle(page, 1200);
    ok(await vis(page, ".ks-panel"), "‘ติดต่อแอดมิน / Feedback’ in the + sheet opens the chat");
    await page.keyboard.press("Escape"); await settle(page, 400);
    await page.evaluate(() => sessionStorage.setItem("__mock_admin_role", "owner"));
    await page.goto(`${BASE}/admin.html#messages`); await settle(page, 2200);
    ok((await txt(page, "#msgTabCount")) === "3" && await vis(page, '[data-thread="u-real"].unread'), "admin: tab count 3 (member's 3 messages), thread marked unread");
    await page.click('[data-thread="u-real"]'); await settle(page, 1000);
    ok(/ขอบคุณครับ ใช้ได้แล้ว/.test(await txt(page, "#spMsgs")) && /a@gmail\.com/.test(await txt(page, ".sp-head")), "admin reads the conversation");
    ok(await page.isHidden("#msgTabCount"), "opening it clears the staff unread count");
    await page.click('.sp-quick [data-quick]');
    ok((await page.$eval("#spText", e => e.value)).length > 5, "quick reply fills the composer");
    await page.fill("#spText", "ยินดีครับ <b>มีอะไรทักได้เลย</b>");
    await page.click("#spSend"); await settle(page, 1000);
    ok(/มีอะไรทักได้เลย/.test(await txt(page, "#spMsgs")) && !(await page.$("#spMsgs b")), "reply shown, as text");
    await page.click("#spStatus"); await settle(page, 900);
    ok((await store(page)).threads["u-real"].status === "closed" && /ปิดเรื่องแล้ว/.test(await txt(page, "#spMsgs")), "close thread");

    console.log("C5 announcement to everyone");
    await page.goto(`${BASE}/admin.html#announce`); await settle(page, 1500);
    await page.fill("#annTitle", "ปิดปรับปรุงคืนนี้"); await page.fill("#annBody", "23:00–23:30 ระบบจะใช้งานไม่ได้ชั่วคราว");
    await page.selectOption("#annKind", "warning");
    await page.click("#annSend"); await settle(page, 300);
    ok(/ยืนยัน/.test(await txt(page, "#annSend")) && (await store(page)).anns.length === 1, "first tap only arms the button (no native dialog)");
    await page.click("#annSend"); await settle(page, 900);
    ok((await store(page)).anns.length === 2 && /ปิดปรับปรุงคืนนี้/.test(await txt(page, "#annList")), "second tap sends; listed");
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    ok((await badge(page)) === "2", "member badge: admin reply + new announcement = 2");
    await page.goto(`${BASE}/admin.html#announce`); await settle(page, 1500);
    await page.click("[data-ann-del]"); await page.click("[data-ann-del]"); await settle(page, 900);
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    ok((await badge(page)) === "1", "deleted announcement no longer counts");
    ok(page.errors.length === 0, "no page errors / native dialogs");
    await page.close();

    console.log("C6 viewer is read-only");
    page = await newPage(browser, { width: 1366, height: 860 });
    await seed(page, member(), { __mock_admin_role: "viewer", __mock_support: STORE() });
    await page.goto(`${BASE}/admin.html#messages`); await settle(page, 2000);
    await page.click('[data-thread="u-real"]'); await settle(page, 900);
    ok(!(await page.$("#spForm")) && await vis(page, ".sp-ro") && !(await page.$("#spStatus")), "no composer / status button for viewer");
    await page.goto(`${BASE}/admin.html#announce`); await settle(page, 1200);
    ok(await page.$eval("#annSend", b => b.disabled) && await vis(page, "#annRO") && !(await page.$("[data-ann-del]")), "announce form disabled, no delete");

    console.log("C7 desktop sidebar + Enter to send");
    await page.goto(`${BASE}/index.html`); await settle(page, 2000);
    ok(await vis(page, '.pn-side .pn-item[data-k="support"] .pn-badge') && (await txt(page, '.pn-side .pn-item[data-k="support"] .pn-badge')) === "2", "sidebar ‘ข้อความถึงแอดมิน’ carries the badge");
    await page.click('.pn-side .pn-item[data-k="support"]'); await settle(page, 1500);
    ok(await vis(page, ".ks-panel") && await page.evaluate(() => document.activeElement.id === "ksText"), "opens as a drawer, focus in the composer");
    await page.keyboard.type("บรรทัดแรก"); await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift"); await page.keyboard.type("บรรทัดสอง");
    await page.keyboard.press("Enter"); await settle(page, 800);
    ok((await store(page)).messages.some(m => m.body === "บรรทัดแรก\nบรรทัดสอง"), "Enter sends, Shift+Enter makes a new line");
    await page.close();

    console.log("C8 before the migration exists");
    page = await newPage(browser);
    await seed(page, member(), { __mock_support_mode: "missing" });
    await page.goto(`${BASE}/account.html`); await settle(page, 1800);
    ok((await badge(page)) === "", "no badge when the server has no chat yet");
    await page.click("#supportCard [data-support-open]"); await settle(page, 1000);
    ok(/กำลังเปิดใช้งาน/.test(await txt(page, ".ks-body")) && page.errors.length === 0, "friendly ‘coming online’ state, no errors");
    await page.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 21 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
