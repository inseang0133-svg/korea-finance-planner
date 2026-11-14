// stripe-webhook · called by Stripe only. Verifies the Stripe-Signature header,
// claims the event id once (idempotency), re-fetches the object from Stripe,
// and syncs subscriptions / payments / refunds. 500 → Stripe retries.
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
// Stripe Dashboard → Developers → Webhooks → endpoint
//   https://<project>.supabase.co/functions/v1/stripe-webhook  with the events in HANDLED_EVENTS.
import { processWebhook } from "../_shared/billing.ts";
import { stripeClient, webhookVerifier } from "../_shared/stripe.ts";
import { adminClient, rpcVia, siteUrl } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();                                   // raw body is required for the signature
  const stripe = stripeClient();
  const res = await processWebhook(raw, req.headers.get("stripe-signature"), {
    stripe, rpc: rpcVia(adminClient()), siteUrl: siteUrl(), verify: webhookVerifier(stripe), log: console.error });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
});
