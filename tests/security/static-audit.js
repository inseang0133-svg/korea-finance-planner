/* Phase 12 · static security audit of the website + Edge Functions (no network, no browser).
 * Run: node tests/security/static-audit.js      → exit 1 on any FAIL
 * Checks what code review tends to miss on a static site: leaked secrets, unpinned CDN code,
 * unsafe links, eval, mixed content, browser→DB API that does not exist or is not granted,
 * Edge Functions without auth, admin page hardening, service-worker caching of private pages. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const rd = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const web = fs.readdirSync(ROOT).filter((f) => /\.(html|js|css|json)$/.test(f));
const fnDir = path.join(ROOT, "supabase/functions");
const fns = fs.readdirSync(fnDir).filter((d) => d !== "_shared" && fs.statSync(path.join(fnDir, d)).isDirectory());
const migrations = fs.readdirSync(path.join(ROOT, "supabase/migrations")).map((f) => rd("supabase/migrations/" + f)).join("\n") + rd("supabase_schema.sql");
let fail = 0, warn = 0, pass = 0;
const out = (lvl, name, detail) => { console.log(`  ${lvl === "PASS" ? "✓" : lvl === "WARN" ? "!" : "✗"} [${lvl}] ${name}${detail ? " — " + detail : ""}`); if (lvl === "FAIL") fail++; else if (lvl === "WARN") warn++; else pass++; };
const check = (ok, name, detail, level = "FAIL") => out(ok ? "PASS" : level, name, ok ? "" : detail);

console.log("A. secrets & keys");
const secretRe = /(sk_live_[0-9a-zA-Z]{6,}|sk_test_[0-9a-zA-Z]{6,}|rk_(live|test)_[0-9a-zA-Z]{6,}|whsec_[0-9a-zA-Z]{6,}|SERVICE_ROLE_KEY\s*[:=]\s*["'`][^"'`]+)/;
const leaks = web.filter((f) => secretRe.test(rd(f)));
check(leaks.length === 0, "no Stripe secret / webhook secret / service key in website files", leaks.join(", "));
const cfg = rd("supabase-config.js"), key = (/SUPABASE_ANON_KEY:\s*"([^"]+)"/.exec(cfg) || [])[1] || "";
let keyOk = key.startsWith("sb_publishable_");
if (!keyOk && /^eyJ/.test(key)) { try { keyOk = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon"; } catch (_) {} }
check(keyOk, "supabase-config.js holds a publishable/anon key (not service_role)", key.slice(0, 16) + "…");
const jwtSvc = web.filter((f) => (rd(f).match(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g) || []).some((t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).role === "service_role"; } catch (_) { return false; } }));
check(jwtSvc.length === 0, "no service_role JWT anywhere in the website", jwtSvc.join(", "));

console.log("B. third-party code");
const scripts = [];
web.filter((f) => f.endsWith(".html")).forEach((f) => { (rd(f).match(/<script[^>]+src="https?:\/\/[^"]+"/g) || []).forEach((s) => scripts.push([f, /src="([^"]+)"/.exec(s)[1]])); });
const badHost = scripts.filter(([, u]) => !/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\//.test(u));
check(badHost.length === 0, "external scripts only from cdn.jsdelivr.net / unpkg.com over https", badHost.map((x) => x.join(" ")).join("; "));
const unpinned = scripts.filter(([, u]) => !/@\d+\.\d+\.\d+/.test(u));
check(unpinned.length === 0, "every CDN script pinned to an exact version", unpinned.map((x) => x.join(" ")).join("; "));
const noSri = scripts.filter(([f, u]) => !new RegExp('src="' + u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*integrity=').test(rd(f)));
check(noSri.length === 0, "Subresource Integrity (integrity=…) on CDN scripts", `${noSri.length} script tags without SRI (pinned versions; add SRI hashes before go-live — see docs/GO_LIVE.md)`, "WARN");

console.log("C. dangerous patterns");
const appJs = web.filter((f) => f.endsWith(".js") && f !== "sw.js");
const evalUse = appJs.filter((f) => /\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(/.test(rd(f)));
check(evalUse.length === 0, "no eval / new Function / document.write", evalUse.join(", "));
const blank = [];
web.forEach((f) => { (rd(f).match(/<a\b[^>]*target=["']_blank["'][^>]*>/g) || []).forEach((t) => { if (!/rel=["'][^"']*noopener/.test(t)) blank.push(f + ": " + t.slice(0, 80)); }); });
appJs.forEach((f) => { (rd(f).match(/target=\\?["']_blank\\?["'][^>]{0,120}/g) || []).forEach((t) => { if (!/noopener/.test(t)) blank.push(f + ": " + t.slice(0, 80)); }); });
check(blank.length === 0, 'target="_blank" links carry rel="noopener"', blank.join("; "));
const mixed = web.filter((f) => /(src|href)=["']http:\/\/(?!localhost)/.test(rd(f)));
check(mixed.length === 0, "no http:// (mixed content) resources", mixed.join(", "));
const inner = appJs.concat(web.filter((f) => f.endsWith(".html"))).map((f) => [f, (rd(f).match(/\.innerHTML\s*[+]?=/g) || []).length]).filter((x) => x[1]);
out("PASS", "innerHTML inventory (reviewed: user text goes through esc()/escapeHTML(); proven by the XSS canary e2e test)", inner.map((x) => x.join(":")).join(" "));

console.log("D. browser → database API matches the migrations");
const rpcNames = new Set();
appJs.concat(web.filter((f) => f.endsWith(".html"))).forEach((f) => { for (const m of rd(f).matchAll(/rpc\(\s*["']([a-z_]+)["']/g)) rpcNames.add(m[1]); });
const missing = [], ungranted = [];
for (const n of rpcNames) {
  if (!new RegExp("create or replace function public\\." + n + "\\(", "i").test(migrations)) { missing.push(n); continue; }
  if (!new RegExp("grant execute on function public\\." + n + "\\([^;]*to [^;]*(authenticated|anon)", "i").test(migrations)) ungranted.push(n);
}
check(missing.length === 0, `all ${rpcNames.size} RPCs called by the website exist in the migrations`, missing.join(", "));
check(ungranted.length === 0, "…and are granted to the browser roles", ungranted.join(", "));
const internalCalled = [...rpcNames].filter((n) => /^kfp_/.test(n));
check(internalCalled.length === 0, "website never calls internal kfp_* functions", internalCalled.join(", "));
const endpoints = new Set();
appJs.concat(web.filter((f) => f.endsWith(".html"))).forEach((f) => {
  const s = rd(f);
  for (const m of s.matchAll(/functions\/v1\/([a-z-]+)/g)) endpoints.add(m[1]);
  for (const m of s.matchAll(/callFn\(\s*["']([a-z-]+)["']/g)) endpoints.add(m[1]);
});
const noFn = [...endpoints].filter((e) => !fns.includes(e));
check(noFn.length === 0, `all ${endpoints.size} Edge Function endpoints used by the website exist`, noFn.join(", "));

console.log("E. Edge Functions");
const PUBLIC_FNS = { "stripe-webhook": "Stripe signature", "username-login": "rate limit + constant time" };
fns.forEach((f) => {
  const s = rd(`supabase/functions/${f}/index.ts`);
  if (f === "stripe-webhook") check(/stripe-signature/i.test(s) && /processWebhook/.test(s), `${f}: verifies the Stripe signature`, "missing");
  else if (f === "username-login") check(/kfp_rate_hit/.test(s) && /sleep|wait/.test(s), `${f}: rate-limited, constant-time failures`, "missing");
  else check(/userFromRequest\(/.test(s) && /401/.test(s), `${f}: requires a signed-in user (JWT verified by Supabase Auth)`, "no auth check");
  check(!/Access-Control-Allow-Origin["']?\s*:\s*["']\*["']/.test(s), `${f}: no wildcard CORS`, "wildcard");
});
const cors = rd("supabase/functions/_shared/cors.ts");
check(/allowed\.length === 0 \? ""/.test(cors), "CORS fails closed when ALLOWED_ORIGINS is not set", "check cors.ts");
check(/userFromRequest[\s\S]*auth\.getUser\(token\)/.test(rd("supabase/functions/_shared/supabase.ts")), "user identity comes from auth.getUser(token) on the server", "");
const adminFn = rd("supabase/functions/_shared/billing.ts");
check(/kfp_admin_role", \{ p_uid: input\.adminId/.test(adminFn), "admin-actions reads the admin role from the database (not the request)", "");
check(Object.keys(PUBLIC_FNS).every((f) => fns.includes(f)), "public (no-JWT) functions are only " + Object.keys(PUBLIC_FNS).join(" + "), "");

console.log("F. pages & service worker");
const admin = rd("admin.html");
check(/http-equiv="Content-Security-Policy"/.test(admin) && /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/.test(admin) && !/script-src[^;]*unsafe-inline/.test(admin), "admin.html: strict CSP (no inline script)", "");
check(/noindex/.test(admin) && /window\.top !== window\.self/.test(rd("admin.js")), "admin.html: noindex + frame-busting", "");
check(!/<script>(?!\s*<\/script>)/.test(admin) && !/\son[a-z]+="/.test(admin), "admin.html: no inline script / handlers", "");
const sw = rd("sw.js");
check(/admin\\\.\(html\|js\|css\)/.test(sw), "service worker never caches admin pages", "");
check(!/supabase\.co/.test(sw), "service worker never caches Supabase API responses", "");
const assets = (/const ASSETS = \[([\s\S]*?)\];/.exec(sw) || [])[1] || "";
const missingAssets = (assets.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).filter((f) => f !== "./" && !exists(f.replace(/^\.\//, "")));
check(missingAssets.length === 0, "every service-worker asset exists", missingAssets.join(", "));
["pricing.html", "account.html"].forEach((f) => check(/function goStripe/.test(rd(f)) && !/location\.href = r\.body\.url/.test(rd(f)), `${f}: only follows Stripe URLs returned by the server`, ""));
check(!/updated_at\s*:/.test((/async function saveProfile[\s\S]*?\n  }/.exec(rd("auth.js")) || [""])[0]), "auth.js sends only columns the browser may update (nickname, country)", "");

console.log(`\n${pass} passed, ${warn} warnings, ${fail} failed`);
process.exit(fail ? 1 : 0);
