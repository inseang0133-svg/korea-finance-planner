// create-checkout · POST { plan: "plus"|"premium", interval: "month"|"year", currency: "THB"|"KRW" }
// Authorization: Bearer <user access token>  →  200 { url } (Stripe Checkout)
// Errors: 400 invalid_request · 401 unauthorized · 403 email_not_verified | legacy_email | suspended
//         404 price_not_available · 409 already_subscribed (use the portal) · 429 rate_limited
// Deploy: supabase functions deploy create-checkout
import { corsHeaders, json } from "../_shared/cors.ts";
import { createCheckout } from "../_shared/billing.ts";
import { stripeClient } from "../_shared/stripe.ts";
import { adminClient, rpcVia, siteUrl, userFromRequest } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  try {
    const db = adminClient();
    const user = await userFromRequest(req, db);
    if (!user) return json(req, 401, { error: "unauthorized" });
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json(req, 400, { error: "invalid_request" }); }
    const res = await createCheckout(
      { userId: user.id, plan: String(body.plan ?? ""), interval: String(body.interval ?? ""), currency: String(body.currency ?? "") },
      { stripe: stripeClient(), rpc: rpcVia(db), siteUrl: siteUrl(), requireTos: Deno.env.get("CHECKOUT_REQUIRE_TOS") === "1", log: console.error });
    return json(req, res.status, res.body);
  } catch (e) {
    console.error("create-checkout", e);
    return json(req, 500, { error: "server_error" });
  }
});
