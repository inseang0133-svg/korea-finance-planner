// admin-actions · POST { action: "cancel_subscription", user_id, mode: "period_end"|"now", reason }
// Authorization: Bearer <admin's access token>. The role is checked in the database
// (admin_roles, account not suspended) — the request body can never claim it.
// → 200 { changed, status, cancel_at_period_end, current_period_end }
// Errors: 400 invalid_request | reason_required · 401 · 403 forbidden | cannot_act_on_self | only_owner_can_change_admins
//         404 no_subscription · 409 customer_mismatch · 429 rate_limited
// Every success writes admin_audit_logs. Deploy: supabase functions deploy admin-actions
import { corsHeaders, json } from "../_shared/cors.ts";
import { adminCancelSubscription } from "../_shared/billing.ts";
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
    const deps = { stripe: stripeClient(), rpc: rpcVia(db), siteUrl: siteUrl(), log: console.log };
    switch (String(body.action ?? "")) {
      case "cancel_subscription": {
        const res = await adminCancelSubscription(
          { adminId: user.id, userId: String(body.user_id ?? ""), mode: String(body.mode ?? ""), reason: String(body.reason ?? "") }, deps);
        return json(req, res.status, res.body);
      }
      default:
        return json(req, 400, { error: "unknown_action" });
    }
  } catch (e) {
    console.error("admin-actions", e);
    return json(req, 500, { error: "server_error" });
  }
});
