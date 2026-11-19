/* Phase 23 e2e: pictures in the support chat — shrink in the browser, private upload, signed links (cached),
 * lightbox, errors + retry, quota, admin view, close → files deleted, viewer read-only, old-server fallback.
 * Run: node tests/e2e/phase23.test.js */
const { chromium } = require("playwright");
require("./demo-seed");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8823, BASE = `http://localhost:${PORT}`;
const TOKEN_KEY = "sb-yelkgtddtuugzoyzvqug-auth-token";
const SHOTS = process.env.SHOT_DIR || "/tmp/kfp-shots"; fs.mkdirSync(SHOTS, { recursive: true });
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
const STORE = () => JSON.stringify({ seq: 0, threads: { "u-real": { status: "open", last_message_at: iso(-30), user_read_at: iso(-20), ann_read_at: iso(-20) } },
  messages: [{ id: "m1", user_id: "u-real", sender: "user", body: "จ่ายเงินแล้วแต่ยังเป็น Free ครับ", created_at: iso(-60) },
             { id: "m2", user_id: "u-real", sender: "admin", body: "รบกวนส่งภาพหน้าจอเพิ่มเติมได้ไหมครับ", created_at: iso(-30) }], anns: [] });
async function seed(page, items, session) {
  await page.goto(`${BASE}/manifest.json`);
  await page.evaluate(({ items, session }) => { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem("kfp_demo", "1");
    Object.entries(items || {}).forEach(([k, v]) => localStorage.setItem(k, v)); Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v)); }, { items, session });
}
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const vis = (page, sel) => page.isVisible(sel).catch(() => false);
const txt = (page, sel) => page.textContent(sel).catch(() => "");
const calls = (page, name) => page.evaluate(n => JSON.parse(sessionStorage.getItem("__mock_calls") || "[]").filter(c => c.name === n), name);
const store = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_storage") || "{}"));
const support = page => page.evaluate(() => JSON.parse(sessionStorage.getItem("__mock_support") || "{}"));

// a 3000×2000 camera-like JPEG (~1–2 MB) with a fake EXIF block carrying a "GPS" marker
async function bigPhoto(page) {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 3000; c.height = 2000; const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 3000, 2000); g.addColorStop(0, "#2a6"); g.addColorStop(1, "#a62"); x.fillStyle = g; x.fillRect(0, 0, 3000, 2000);
    for (let i = 0; i < 9000; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,${30 + (i % 50)}%)`; x.fillRect((i * 97) % 3000, (i * 53) % 2000, 18, 18); }
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.95));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    const note = new TextEncoder().encode("Exif\0\0GPSLatitude=37.5665N;GPSLongitude=126.9780E;SECRET-HOME-LOCATION");
    const seg = new Uint8Array(4 + note.length); seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = (note.length + 2) >> 8; seg[3] = (note.length + 2) & 255; seg.set(note, 4);
    const out = new Uint8Array(u8.length + seg.length); out.set(u8.slice(0, 2)); out.set(seg, 2); out.set(u8.slice(2), 2 + seg.length);
    let s = ""; for (let i = 0; i < out.length; i += 32768) s += String.fromCharCode.apply(null, out.subarray(i, i + 32768));
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}
async function openChat(page) { await page.evaluate(() => window.kfpSupport.open()); await page.waitForSelector(".ks-panel", { state: "visible" }); await settle(page, 900); }
async function pick(page, file) { await page.setInputFiles(".ks-file", file); }

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("G1 member attaches a phone photo: shrunk, GPS stripped, private upload, shown at once");
    let page = await newPage(browser);
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE() });
    await page.goto(`${BASE}/account.html`); await settle(page, 1800);
    await openChat(page);
    ok(await vis(page, ".ks-attach") && /แนบรูป/.test(await page.getAttribute(".ks-attach", "aria-label")), "attach button shown (server has pictures on)");
    ok(await page.getAttribute("#ksText", "placeholder") === "พิมพ์ข้อความ…", "shorter placeholder next to the attach button (fits 320 px)");
    const photo = await bigPhoto(page);
    ok(photo.length > 700000 && photo.includes("SECRET-HOME-LOCATION"), `test photo is big and carries EXIF (${Math.round(photo.length / 1024)} KB)`);
    await pick(page, { name: "IMG_0412.jpg", mimeType: "image/jpeg", buffer: photo });
    await page.waitForFunction(() => /รูปพร้อมส่ง/.test(document.querySelector(".ks-att b").textContent), null, { timeout: 8000 }).catch(() => {});
    ok(await vis(page, ".ks-att") && /ย่อจาก/.test(await txt(page, ".ks-att small")) && /GPS/.test(await txt(page, ".ks-att small")), "preview: size, 'shrunk from', GPS removed, deleted on close");
    ok(!(await page.$eval(".ks-send", b => b.disabled)), "send enabled with a picture and no text");
    await page.screenshot({ path: path.join(SHOTS, "p23_preview.png") });
    await page.fill("#ksText", "สลิปครับ <img src=x onerror=window.__xss=1>");
    await page.click(".ks-send");
    await page.waitForFunction(() => { const r = [...document.querySelectorAll(".ks-row.ks-me")].pop(); return r && !r.classList.contains("ks-pending") && /\d/.test(r.querySelector("time").textContent); }, null, { timeout: 8000 }).catch(() => {});
    const up = (await calls(page, "storage:upload"))[0] || { args: {} };
    ok(/^u-real\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/.test(up.args.path || ""), "uploaded into own folder as <uuid>.webp: " + up.args.path);
    ok(up.args.type === "image/webp" && up.args.size < 450 * 1024 && up.args.cacheControl === "31536000", `WebP ${Math.round((up.args.size || 0) / 1024)} KB (was ${Math.round(photo.length / 1024)} KB), cached a year`);
    const st = await store(page), saved = st[up.args.path];
    ok(saved && !Buffer.from(saved.url.split(",")[1], "base64").toString("latin1").includes("SECRET-HOME-LOCATION"), "stored file no longer contains the EXIF/GPS block");
    const send = (await calls(page, "rpc:support_send_image"))[0] || { args: {} };
    ok(send.args.p_path === up.args.path && send.args.p_w === 1280 && send.args.p_h === 853 && /สลิปครับ/.test(send.args.p_body), "message sent with path, size 1280×853, caption");
    const last = await page.$eval(".ks-row.ks-me:last-of-type", r => ({ img: !!r.querySelector(".ks-img img[src]"), cap: r.querySelector("p") && r.querySelector("p").textContent }));
    ok(last.img && /<img src=x/.test(last.cap) && !(await page.evaluate(() => window.__xss)), "own picture shown from memory; caption is plain text");
    ok((await calls(page, "storage:sign")).length === 0, "no download/sign needed for a picture just sent");
    ok(!(await vis(page, ".ks-att")) && (await page.inputValue("#ksText")) === "", "composer cleared");

    console.log("G2 reopening: one signed-link batch, reused for the whole session");
    await page.reload(); await settle(page, 1800); await openChat(page);
    ok(await page.$eval(".ks-img img", i => !!i.getAttribute("src") && i.complete && i.naturalWidth > 0), "picture loads from a signed link after reload");
    const ar = await page.$eval(".ks-img", b => b.style.aspectRatio);
    ok(/1280 \/ 853/.test(ar), "space reserved with the real aspect ratio (no layout jump): " + ar);
    const signs1 = (await calls(page, "storage:sign")).length;
    await page.goto(`${BASE}/index.html`); await settle(page, 1600); await openChat(page);
    ok(signs1 === 1 && (await calls(page, "storage:sign")).length === 1, "another page in the same session reuses the cached link (1 sign call total)");

    console.log("G3 full-size view");
    await page.click(".ks-img"); await settle(page, 300);
    ok(await vis(page, ".ks-lb") && await page.$eval(".ks-lb img", i => !!i.src), "tap → full-size picture");
    await page.keyboard.press("Escape"); await settle(page, 300);
    ok(!(await vis(page, ".ks-lb")) && await vis(page, ".ks-panel"), "Escape closes the picture first, chat stays open");
    await page.keyboard.press("Escape"); await settle(page, 400);
    ok(!(await vis(page, ".ks-panel")), "second Escape closes the chat");
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("G4 errors, retry, quota, non-pictures");
    page = await newPage(browser);
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE(), __mock_storage_fail: "rls" });
    await page.goto(`${BASE}/account.html`); await settle(page, 1800); await openChat(page);
    const small = await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 800; c.height = 600; const x = c.getContext("2d"); x.fillStyle = "#39c"; x.fillRect(0, 0, 800, 600);
      const b = await new Promise(r => c.toBlob(r, "image/png")); const a = new Uint8Array(await b.arrayBuffer()); let s = ""; a.forEach(v => s += String.fromCharCode(v)); return btoa(s); });
    await pick(page, { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(small, "base64") }); await settle(page, 800);
    await page.click(".ks-send"); await settle(page, 900);
    ok(await vis(page, ".ks-failed [data-ks-retry-img]") && /วันละ 10 รูป/.test(await txt(page, ".ks-failed .ks-retry")), "blocked by the storage rule → clear reason + retry");
    await page.evaluate(() => sessionStorage.removeItem("__mock_storage_fail"));
    await page.click(".ks-failed [data-ks-retry-img]"); await settle(page, 1200);
    ok(!(await page.$(".ks-failed")) && (await support(page)).messages.some(m => m.image), "retry sends it");
    await page.evaluate(() => sessionStorage.setItem("__mock_storage_fail", "net"));
    await pick(page, { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(small, "base64") }); await settle(page, 800);
    await page.click(".ks-send"); await settle(page, 900);
    ok(/ส่งรูปไม่สำเร็จ/.test(await txt(page, ".ks-failed .ks-retry")), "offline → 'ส่งรูปไม่สำเร็จ · แตะเพื่อลองใหม่'");
    await page.evaluate(() => { sessionStorage.removeItem("__mock_storage_fail"); window.kfpSupport.close(); }); await settle(page, 400);
    await openChat(page);
    ok(await vis(page, ".ks-failed [data-ks-retry-img]"), "failed picture survives a refresh of the conversation");
    await page.click(".ks-failed [data-ks-retry-img]"); await settle(page, 1200);
    ok(!(await page.$(".ks-failed")) && (await support(page)).messages.filter(m => m.image).length === 2, "…and can still be retried");
    await pick(page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }); await settle(page, 300);
    ok(/เฉพาะไฟล์รูปภาพ/.test(await txt(page, "#ksNote")) && !(await vis(page, ".ks-att")), "non-picture file refused");
    await pick(page, { name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not really a jpeg") }); await settle(page, 600);
    ok(/เปิดรูปนี้ไม่ได้/.test(await txt(page, "#ksNote")) && !(await vis(page, ".ks-att")), "unreadable picture → friendly message");
    await page.evaluate(() => { const s = {}; for (let i = 0; i < 10; i++) s["u-real/0000000" + i + "-0000-4000-8000-000000000000.webp"] = { url: "data:,", size: 1, type: "image/webp", at: Date.now() };
      sessionStorage.setItem("__mock_storage", JSON.stringify(s)); window.kfpSupport.close(); });
    await settle(page, 400); await openChat(page);
    await pick(page, { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(small, "base64") }); await settle(page, 400);
    ok(/ครบ 10 รูป/.test(await txt(page, "#ksNote")) && !(await vis(page, ".ks-att")), "daily quota reached → told before shrinking/uploading");
    ok(page.errors.length === 0, "no page errors");
    await page.close();

    console.log("G5 database without pictures yet (migration 2000 not run) → no attach button, text chat works");
    page = await newPage(browser);
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE(), __mock_support_images: "off" });
    await page.goto(`${BASE}/account.html`); await settle(page, 1800); await openChat(page);
    ok(!(await vis(page, ".ks-attach")) && await vis(page, "#ksText") && /แอดมิน/.test(await page.getAttribute("#ksText", "placeholder")), "attach hidden, composer still there");
    await page.fill("#ksText", "ทดสอบข้อความ"); await page.click(".ks-send"); await settle(page, 700);
    ok((await support(page)).messages.some(m => m.body === "ทดสอบข้อความ"), "text message still sends");
    await page.close();

    console.log("G6 admin: sees the picture, closes the conversation → files deleted, member sees 'removed'");
    page = await newPage(browser, { width: 1280, height: 860 });
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE() });
    await page.goto(`${BASE}/account.html`); await settle(page, 1600); await openChat(page);
    await pick(page, { name: "IMG.jpg", mimeType: "image/jpeg", buffer: photo });
    await page.waitForFunction(() => /รูปพร้อมส่ง/.test(document.querySelector(".ks-att b").textContent), null, { timeout: 8000 }).catch(() => {});
    await page.click(".ks-send"); await settle(page, 1200);
    const path1 = Object.keys(await store(page))[0];
    // an upload that was never sent (2 days old) — should be cleaned when the console opens
    await page.evaluate(() => { const s = JSON.parse(sessionStorage.getItem("__mock_storage")); s["u-other/11111111-1111-4111-8111-111111111111.webp"] = { url: "data:,", size: 5000, type: "image/webp", at: Date.now() - 2 * 86400000 };
      sessionStorage.setItem("__mock_storage", JSON.stringify(s)); sessionStorage.setItem("__mock_admin_role", "owner"); sessionStorage.setItem("__mock_calls", "[]"); });
    await page.goto(`${BASE}/admin.html#messages`); await settle(page, 2200);
    const st2 = await store(page);
    ok(!st2["u-other/11111111-1111-4111-8111-111111111111.webp"] && st2[path1], "opening the console deletes a 2-day-old unsent upload, keeps live pictures");
    ok(/รูปในระบบ 1 ไฟล์/.test(await txt(page, "#msgStore")) && /\/ 1\.00 GB/.test(await txt(page, "#msgStore")), "storage usage shown: " + await txt(page, "#msgStore"));
    await page.click('[data-thread="u-real"]'); await settle(page, 1200);
    ok(await page.$eval(".sp-img img", i => !!i.getAttribute("src") && i.naturalWidth > 0) && /1280 \/ 853/.test(await page.$eval(".sp-img", b => b.style.aspectRatio)), "admin sees the picture (signed link, reserved size)");
    await page.click(".sp-img"); await settle(page, 300);
    ok(await page.$eval("#spLb", d => d.open), "admin full-size view");
    await page.keyboard.press("Escape"); await settle(page, 200);
    ok(await page.$eval("#spLb", d => !d.open), "closes with Escape");
    await page.screenshot({ path: path.join(SHOTS, "p23_admin.png") });
    await page.click("#spStatus"); await settle(page, 1400);
    ok(/ลบรูป 1 รูป/.test(await txt(page, "#kfaToast, .toast, [role=status]")) || /ลบรูป 1 รูป/.test(await page.evaluate(() => document.body.innerText)), "toast: closed · 1 picture removed");
    ok(!(await store(page))[path1], "file deleted from storage right after closing");
    ok(await vis(page, ".sp-img-gone") && !(await page.$(".sp-img")), "conversation now shows 'รูปถูกลบแล้ว'");
    ok(/รูปในระบบ 0 ไฟล์/.test(await txt(page, "#msgStore")), "usage updated to 0 files");
    ok(page.errors.length === 0, "no page errors");
    await page.evaluate(() => sessionStorage.removeItem("__mock_admin_role"));
    await page.goto(`${BASE}/account.html`); await settle(page, 1600); await openChat(page);
    ok(await vis(page, ".ks-img-gone") && /รูปถูกลบแล้ว/.test(await txt(page, ".ks-img-gone")) && /สลิป|ทีมงานปิดเรื่อง/.test(await txt(page, ".ks-body")), "member: picture replaced by 'รูปถูกลบแล้ว', text kept");
    await page.close();

    console.log("G7 viewer: sees pictures, never deletes");
    page = await newPage(browser, { width: 1280, height: 860 });
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE(), __mock_admin_role: "viewer" });
    await page.evaluate(() => { const s = { "u-real/22222222-2222-4222-8222-222222222222.webp": { url: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", size: 900, type: "image/webp", at: Date.now() - 3 * 86400000 } };
      sessionStorage.setItem("__mock_storage", JSON.stringify(s));
      const sp = JSON.parse(sessionStorage.getItem("__mock_support")); sp.messages.push({ id: "m9", user_id: "u-real", sender: "user", body: "", created_at: new Date().toISOString(), image: "u-real/22222222-2222-4222-8222-222222222222.webp", w: 1, h: 1 });
      sessionStorage.setItem("__mock_support", JSON.stringify(sp)); });
    await page.goto(`${BASE}/admin.html#messages`); await settle(page, 2000);
    await page.click('[data-thread="u-real"]'); await settle(page, 1000);
    ok(await page.$eval(".sp-img img", i => !!i.getAttribute("src")) && (await calls(page, "storage:remove")).length === 0 && !(await page.$("#spStatus")), "viewer: picture visible, no delete calls, no close button");
    ok(/\[รูปภาพ\]/.test(await txt(page, '[data-thread="u-real"] small')), "inbox preview for a picture-only message says [รูปภาพ]");
    ok(await page.evaluate(() => /img-src[^;]*https:\/\/\*\.supabase\.co/.test(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content)), "admin CSP allows signed picture links");
    await page.close();

    console.log("G8 small phone layout");
    page = await newPage(browser, { width: 320, height: 640 });
    await seed(page, member(), { __mock_country: "KR", __mock_support: STORE() });
    await page.goto(`${BASE}/account.html`); await settle(page, 1600); await openChat(page);
    await pick(page, { name: "IMG.jpg", mimeType: "image/jpeg", buffer: photo });
    await page.waitForFunction(() => /รูปพร้อมส่ง/.test(document.querySelector(".ks-att b").textContent), null, { timeout: 8000 }).catch(() => {});
    const lay = await page.evaluate(() => { const p = document.querySelector(".ks-panel"), f = document.querySelector("#ksForm");
      return { over: p.scrollWidth > p.clientWidth + 1, att: document.querySelector(".ks-attach").getBoundingClientRect().width, formIn: f.getBoundingClientRect().right <= innerWidth + 0.5 }; });
    ok(!lay.over && lay.att >= 44 && lay.formIn, "320 px: no sideways scroll, attach button ≥ 44 px " + JSON.stringify(lay));
    await page.screenshot({ path: path.join(SHOTS, "p23_phone320.png") });
    await page.close();
  } catch (e) { fail++; console.log("  ✗ crashed:", e.message); }
  await browser.close(); server.close();
  console.log(`\nPhase 23 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
