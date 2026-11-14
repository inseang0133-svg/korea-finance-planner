// create-portal · POST { flow?: "manage"|"payment_method"|"switch", plan?, interval? }
// Authorization: Bearer <user access token>  →  200 { url } Stripe Customer Portal
//   manage          portal home: invoices, card, plan, cancel
//   payment_method  straight to "update card"
//   switch          confirm screen for changing to { plan, interval } (upgrade / downgrade, same currency)
// Errors: 400 invalid_request | same_plan · 401 · 403 suspended · 404 no_customer | no_subscription | price_not_available
//         409 not_switchable (past_due: pay first) | resume_first · 429 rate_limited
// Deploy: supabase functions deploy create-portal
import { corsHeaders, json } from "../_shared/cors.ts";
import { createPortal } from "../_shared/billing.ts";
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
    try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return json(req, 400, { error: "invalid_request" }); }
    const res = await createPortal(
      { userId: user.id, flow: body.flow ? String(body.flow) : undefined,
        targetPlan: body.plan ? String(body.plan) : undefined, targetInterval: body.interval ? String(body.interval) : undefined },
      { stripe: stripeClient(), rpc: rpcVia(db), siteUrl: siteUrl(),
        portalConfiguration: Deno.env.get("STRIPE_PORTAL_CONFIGURATION") || undefined, log: console.error });
    return json(req, res.status, res.body);
  } catch (e) {
    console.error("create-portal", e);
    return json(req, 500, { error: "server_error" });
  }
});
