// username-login · Sign in with username + password without exposing e-mails.
//
// POST { username, password }
//  200 { access_token, refresh_token }       → browser calls supabase.auth.setSession()
//  400 { error: "invalid_request" }
//  401 { error: "invalid_credentials" }      → same message for unknown user / wrong password
//  403 { error: "email_not_confirmed" }
//  429 { error: "rate_limited" }
//
// Deploy:  supabase functions deploy username-login --no-verify-jwt
// Secrets: ALLOWED_ORIGINS (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected)
import { createClient } from "npm:@supabase/supabase-js@2.97.0";
import { clientIp, corsHeaders, json } from "../_shared/cors.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const started = Date.now();
  // Constant-ish response time so "unknown username" can't be timed.
  const fail = async (status: number, error: string) => {
    const wait = 600 - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    return json(req, status, { error });
  };

  let username = "", password = "";
  try {
    const body = await req.json();
    username = String(body?.username ?? "").trim().toLowerCase();
    password = String(body?.password ?? "");
  } catch { return fail(400, "invalid_request"); }
  if (!USERNAME_RE.test(username) || password.length < 1 || password.length > 200) {
    return fail(400, "invalid_request");
  }

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

  // Rate limits: 20 tries / 10 min per IP, 8 tries / 10 min per username.
  const ip = clientIp(req);
  const [byIp, byUser] = await Promise.all([
    admin.rpc("kfp_rate_hit", { p_key: `ulogin:ip:${ip}`, p_max: 20, p_window_seconds: 600 }),
    admin.rpc("kfp_rate_hit", { p_key: `ulogin:user:${username}`, p_max: 8, p_window_seconds: 600 }),
  ]);
  if (byIp.error || byUser.error) return fail(500, "server_error");
  if (byIp.data === false || byUser.data === false) return fail(429, "rate_limited");

  const { data: email, error: lookupErr } = await admin.rpc("kfp_login_email_for_username", { p_username: username });
  if (lookupErr) return fail(500, "server_error");
  if (!email) return fail(401, "invalid_credentials");

  // Sign in with the anon client exactly like the browser would.
  const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email: String(email), password });
  if (error || !data.session) {
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code === "email_not_confirmed") return fail(403, "email_not_confirmed");
    return fail(401, "invalid_credentials");
  }
  return json(req, 200, {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
});
