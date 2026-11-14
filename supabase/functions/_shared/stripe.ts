// Stripe client for Edge Functions (Deno). Secrets come from Supabase Secrets only.
import Stripe from "npm:stripe@^16";

// Pinned so object shapes never change under us (billing.ts maps this version,
// with fallbacks for newer shapes). Webhook payloads only provide ids — every
// object is re-fetched through this client.
export const STRIPE_API_VERSION = "2024-06-20";

export function stripeClient(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION, httpClient: Stripe.createFetchHttpClient() });
}

const cryptoProvider = Stripe.createSubtleCryptoProvider();
export function webhookVerifier(stripe: Stripe) {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  // Verifies the Stripe-Signature header (HMAC-SHA256, 5-minute tolerance) over the RAW body.
  return (rawBody: string, signature: string) =>
    stripe.webhooks.constructEventAsync(rawBody, signature, secret, undefined, cryptoProvider);
}
