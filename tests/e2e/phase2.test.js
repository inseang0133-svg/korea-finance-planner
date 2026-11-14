/* Phase 2 e2e: e-mail auth, username login, legacy link-email, recovery.
 * Run: node tests/e2e/phase2.test.js   (serves the project on :8790, Supabase mocked)
 * Needs: playwright (Chromium). Network to CDNs is blocked on purpose. */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const MOCK = fs.readFileSync(path.join(__dirname, "mock-supabase.js"), "utf8");
const PORT = 8790, BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || "";

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" }); fs.createReadStream(p).pipe(res);
});

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }

async function newPage(browser, { fn = "404" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("    [pageerror]", e.message));
  await page.route("**/*", route => {
    const u = route.request().url();
    if (u.includes("@supabase/supabase-js")) return route.fulfill({ contentType: "text/javascript", body: MOCK });
    if (u.includes("/functions/v1/username-login")) {
      if (fn === "404") return route.fulfill({ status: 404, body: "" });
      if (fn === "401") return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"invalid_credentials"}' });
      if (fn === "429") return route.fulfill({ status: 429, contentType: "application/json", body: '{"error":"rate_limited"}' });
      const body = JSON.parse(route.request().postData() || "{}");
      const map = { alice: "a@gmail.com" };
      if (map[body.username] && body.password === "Passw0rd1")
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ access_token: "at-" + map[body.username], refresh_token: "rt" }) });
      return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"invalid_credentials"}' });
    }
    if (u.startsWith(BASE)) return route.continue();
    return route.abort();
  });
  return page;
}
const calls = (page, name) => page.evaluate(n => window.__sb.calls.filter(c => c.name === n), name);
const status = page => page.$eval("#kfpAuthStatus", e => e.textContent);
const visibleView = page => page.$eval("#kfpAuthPanel", p => (p.querySelector("[data-view]:not([hidden])") || {}).dataset?.view || "");
async function openLogin(page) { await page.goto(`${BASE}/index.html`); await page.waitForSelector("#kfpAuthButton"); await page.click("#kfpAuthButton"); await page.waitForTimeout(250); }
async function shot(page, name) { if (OUT) await page.screenshot({ path: path.join(OUT, name + ".png") }); }

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  try {
    console.log("T1 guest opens site: no modal, Login button");
    let page = await newPage(browser);
    await page.goto(`${BASE}/index.html`); await page.waitForSelector("#kfpAuthButton");
    ok(!(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open"))), "no login popup on open");
    ok((await page.textContent("#kfpAuthButton")).includes("Login"), "Login button shown");

    console.log("T2 register validation + success → verify notice");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(200);
    await page.click("#kfpOpenAddBtn");
    ok(await visibleView(page) === "register", "register view");
    await page.waitForTimeout(700); await shot(page, "p2_register");
    await page.fill("#kfpNewEmail", "bad-email"); await page.click("#kfpCreateBtn");
    ok((await status(page)).includes("อีเมล"), "rejects bad e-mail");
    await page.fill("#kfpNewEmail", "new@gmail.com"); await page.fill("#kfpNewUsername", "john");
    await page.waitForTimeout(500);
    ok((await page.textContent("#kfpUsernameHint")).includes("มีคนใช้"), "live username check: taken");
    await page.fill("#kfpNewUsername", "Bad Name"); await page.waitForTimeout(100);
    ok((await page.textContent("#kfpUsernameHint")).includes("a-z"), "live username check: format");
    await page.fill("#kfpNewUsername", "newbie"); await page.waitForTimeout(500);
    ok((await page.textContent("#kfpUsernameHint")).includes("ใช้ชื่อนี้ได้"), "live username check: available");
    await page.fill("#kfpNewPassword", "short1"); await page.fill("#kfpNewPassword2", "short1"); await page.click("#kfpCreateBtn");
    ok((await status(page)).includes("8"), "rejects short password");
    await page.fill("#kfpNewPassword", "abcdefgh"); await page.fill("#kfpNewPassword2", "abcdefgh"); await page.click("#kfpCreateBtn");
    ok((await status(page)).includes("ตัวเลข"), "requires letters + digits");
    await page.fill("#kfpNewPassword", "Passw0rd1"); await page.fill("#kfpNewPassword2", "Passw0rd2"); await page.click("#kfpCreateBtn");
    ok((await status(page)).includes("ไม่ตรงกัน"), "confirm password mismatch");
    await page.fill("#kfpNewPassword2", "Passw0rd1"); await page.fill("#kfpNewNickname", "นิวบี้");
    await page.click("#kfpCreateBtn"); await page.waitForTimeout(300);
    const su = (await calls(page, "signUp"))[0];
    ok(su && su.args.email === "new@gmail.com", "signUp with real e-mail");
    ok(su && su.args.options.data.username === "newbie" && su.args.options.data.display_name === "นิวบี้", "username + display name sent as metadata");
    ok(su && /\/auth-callback\.html$/.test(su.args.options.emailRedirectTo), "emailRedirectTo = auth-callback.html");
    ok(await visibleView(page) === "verify", "verify-email notice shown");
    ok((await page.textContent("#kfpVerifyEmail")) === "new@gmail.com", "notice names the address");
    ok((await page.textContent("#kfpAuthButton")).includes("Login"), "still logged out (nothing unlocked)");
    await shot(page, "p2_verify");
    await page.click("#kfpResendBtn"); await page.waitForTimeout(200);
    ok((await calls(page, "resend")).length === 1, "resend verification e-mail");

    console.log("T3 unverified account cannot log in");
    page = await newPage(browser); await openLogin(page);
    await page.fill("#kfpUsername", "u@gmail.com"); await page.fill("#kfpPassword", "Passw0rd1");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(300);
    ok(await visibleView(page) === "verify", "goes to verify notice");
    ok((await page.textContent("#kfpAuthButton")).includes("Login"), "not logged in");

    console.log("T4 login with e-mail");
    page = await newPage(browser); await openLogin(page);
    await page.fill("#kfpUsername", "a@gmail.com"); await page.fill("#kfpPassword", "wrong");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(300);
    ok((await status(page)).includes("ไม่ถูกต้อง"), "wrong password → Thai error, nothing unlocked");
    await page.fill("#kfpPassword", "Passw0rd1"); await page.click("#kfpLoginBtn"); await page.waitForTimeout(400);
    ok((await page.textContent("#kfpAuthButton")).includes("alice"), "logged in, button shows username");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(250);
    ok(await visibleView(page) === "account", "account view");
    ok((await page.textContent("#kfpAccountEmail")) === "a@gmail.com", "shows e-mail");
    ok(await page.$eval("#kfpLegacyBanner", e => e.hidden), "no legacy banner for real e-mail");

    console.log("T5 change password (re-auth required)");
    await page.click("#kfpChangePassBtn");
    await page.fill("#kfpCurPass", "nope"); await page.fill("#kfpNewPass", "NewPassw0rd"); await page.fill("#kfpNewPass2", "NewPassw0rd");
    await page.click("#kfpSavePassBtn"); await page.waitForTimeout(300);
    ok((await status(page)).includes("ไม่สำเร็จ") && (await calls(page, "updateUser")).length === 0, "wrong current password blocks change");
    await page.fill("#kfpCurPass", "Passw0rd1"); await page.click("#kfpSavePassBtn"); await page.waitForTimeout(300);
    const up = await calls(page, "updateUser");
    ok(up.length === 1 && up[0].args.attrs.password === "NewPassw0rd", "password updated");
    await shot(page, "p2_account");

    console.log("T6 persisted session survives reload");
    await page.reload(); await page.waitForTimeout(600);
    ok((await page.textContent("#kfpAuthButton")).includes("alice"), "still logged in after reload");

    console.log("T7 username login via Edge Function");
    page = await newPage(browser, { fn: "ok" }); await openLogin(page);
    await page.fill("#kfpUsername", "alice"); await page.fill("#kfpPassword", "Passw0rd1");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(500);
    ok((await calls(page, "setSession")).length === 1, "session from function applied");
    ok((await calls(page, "signInWithPassword")).length === 0, "e-mail never needed in browser");
    ok((await page.textContent("#kfpAuthButton")).includes("alice"), "logged in");

    console.log("T8 username login: function says 401 / 429 → no fallback, Thai error");
    page = await newPage(browser, { fn: "401" }); await openLogin(page);
    await page.fill("#kfpUsername", "john"); await page.fill("#kfpPassword", "oldpass");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(300);
    ok((await status(page)).includes("ไม่ถูกต้อง") && (await calls(page, "signInWithPassword")).length === 0, "401 → error, no legacy fallback");
    page = await newPage(browser, { fn: "429" }); await openLogin(page);
    await page.fill("#kfpUsername", "john"); await page.fill("#kfpPassword", "oldpass");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(300);
    ok((await status(page)).includes("10 นาที"), "429 → rate-limit message");

    console.log("T9 legacy account (function not deployed) → fallback + link real e-mail");
    page = await newPage(browser, { fn: "404" }); await openLogin(page);
    await page.fill("#kfpUsername", "john"); await page.fill("#kfpPassword", "oldpass");
    await page.click("#kfpLoginBtn"); await page.waitForTimeout(500);
    const si = await calls(page, "signInWithPassword");
    ok(si.length === 1 && si[0].args.email === "john@kfp.example.com", "legacy mapping still works");
    await page.click("#kfpAuthButton"); await page.waitForTimeout(250);
    ok(!(await page.$eval("#kfpLegacyBanner", e => e.hidden)), "legacy banner shown");
    ok(!(await page.$eval("#kfpChangeEmailForm", e => e.hidden)), "link-email form open");
    ok((await page.textContent("#kfpAccountEmail")).includes("ยังไม่ได้เชื่อม"), "placeholder e-mail not displayed");
    await shot(page, "p2_legacy");
    await page.fill("#kfpNewEmailChange", "x@kfp.example.com"); await page.click("#kfpSaveEmailBtn");
    ok((await calls(page, "updateUser")).length === 0, "refuses another placeholder address");
    await page.fill("#kfpNewEmailChange", "john.real@gmail.com"); await page.click("#kfpSaveEmailBtn"); await page.waitForTimeout(300);
    const ue = await calls(page, "updateUser");
    ok(ue.length === 1 && ue[0].args.attrs.email === "john.real@gmail.com", "updateUser({email}) — same user id, Supabase change-email flow");
    ok(/auth-callback\.html$/.test(ue[0].args.opts.emailRedirectTo), "confirmation link → auth-callback.html");

    console.log("T10 forgot password");
    page = await newPage(browser); await openLogin(page);
    await page.click("#kfpOpenForgotBtn");
    ok(await visibleView(page) === "forgot", "forgot view");
    await page.fill("#kfpForgotEmail", "john@kfp.example.com"); await page.click("#kfpForgotBtn");
    ok((await calls(page, "resetPasswordForEmail")).length === 0, "placeholder e-mail rejected with guidance");
    await page.fill("#kfpForgotEmail", "a@gmail.com"); await page.click("#kfpForgotBtn"); await page.waitForTimeout(300);
    const rp = await calls(page, "resetPasswordForEmail");
    ok(rp.length === 1 && /auth-callback\.html$/.test(rp[0].args.opts.redirectTo), "reset link → auth-callback.html");
    ok((await status(page)).includes("ถ้ามีบัญชี"), "same message whether account exists or not");

    console.log("T11 Escape / backdrop close the modal; Enter submits");
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
    ok(!(await page.$eval("#kfpAuthPanel", e => e.classList.contains("open"))), "Escape closes");

    console.log("T12 auth-callback: recovery link → reset form → new password");
    page = await newPage(browser);
    await page.goto(`${BASE}/auth-callback.html#access_token=x&refresh_token=y&type=recovery`); await page.waitForTimeout(400);
    ok(await page.$("#p1") !== null, "reset form shown");
    await page.fill("#p1", "Abcdefg12"); await page.fill("#p2", "Abcdefg12"); await page.click("#save"); await page.waitForTimeout(300);
    ok((await page.textContent("h1")).includes("ตั้งรหัสผ่านใหม่แล้ว"), "password saved");
    await shot(page, "p2_callback_reset");
    page = await newPage(browser);
    await page.goto(`${BASE}/auth-callback.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`); await page.waitForTimeout(300);
    ok((await page.textContent("h1")).includes("หมดอายุ"), "expired link explained");
    page = await newPage(browser);
    await page.goto(`${BASE}/auth-callback.html#access_token=x&refresh_token=y&type=signup`); await page.waitForTimeout(400);
    ok((await page.textContent("h1")).includes("ยืนยันอีเมลสำเร็จ"), "signup confirmation success page");
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(600);
    ok((await page.textContent("#kfpAuthButton")).includes("alice"), "session from e-mail link used by index.html");
  } finally {
    await browser.close(); server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
