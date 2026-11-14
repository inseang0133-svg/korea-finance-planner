// billing-action · POST { action: "cancel"|"resume", feedback?, comment? }
// Authorization: Bearer <user access token>
//   cancel  stop auto-renew at the end of the paid period (access stays until then)
//   resume  turn auto-renew back on before that date
// → 200 { changed, status, cancel_at_period_end, current_period_end }
// Errors: 400 invalid_request · 401 · 403 suspended | forbidden · 404 no_subscription
//         409 subscription_ended · 429 rate_limited
// Deploy: supabase functions deploy billing-action
import { corsHeaders, json } from "../_shared/cors.ts";
import { subscriptionAction } from "../_shared/billing.ts";
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
    const res = await subscriptionAction(
      { userId: user.id, action: String(body.action ?? ""),
        feedback: body.feedback ? String(body.feedback) : undefined, comment: body.comment ? String(body.comment) : undefined },
      { stripe: stripeClient(), rpc: rpcVia(db), siteUrl: siteUrl(), log: console.log });
    return json(req, res.status, res.body);
  } catch (e) {
    console.error("billing-action", e);
    return json(req, 500, { error: "server_error" });
  }
});
