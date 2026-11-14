// Billing core shared by create-checkout, create-portal and stripe-webhook.
// Pure TypeScript: no Deno / npm imports, so it runs unchanged in tests (Node)
// with a fake Stripe and a real Postgres. All database writes go through
// service_role-only SQL functions (migration 0600).

/* ------------------------------------------------------------------ types */
// deno-lint-ignore no-explicit-any
type Any = any;
export interface StripeLike {
  subscriptions: { retrieve(id: string): Promise<Any>; update(id: string, params: Any, opts?: Any): Promise<Any>; cancel(id: string, params?: Any): Promise<Any> };
  invoices: { retrieve(id: string, params?: Any): Promise<Any> };
  charges: { retrieve(id: string): Promise<Any> };
  refunds: { list(params: Any): Promise<{ data: Any[] }> };
  customers: { create(params: Any, opts?: Any): Promise<Any> };
  products: { retrieve(id: string): Promise<Any>; create(params: Any, opts?: Any): Promise<Any> };
  prices: { create(params: Any, opts?: Any): Promise<Any> };
  checkout: { sessions: { create(params: Any, opts?: Any): Promise<Any> } };
  billingPortal: { sessions: { create(params: Any): Promise<Any> } };
}
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<Any>;
export interface Deps {
  stripe: StripeLike;
  rpc: Rpc;
  siteUrl: string;                    // e.g. https://inseang0133-svg.github.io/korea-finance-planner
  requireTos?: boolean;               // Checkout "I agree to the terms" box (needs ToS URL in Stripe settings)
  portalConfiguration?: string;       // optional Stripe portal configuration id
  now?: () => number;                 // ms, injectable for tests
  log?: (...a: unknown[]) => void;
}
export interface Result { status: number; body: Record<string, unknown> }

/* ---------------------------------------------------------------- helpers */
export const PLANS = ["plus", "premium"] as const;
const PLAN_NAMES: Record<string, string> = { plus: "Finance Plus", premium: "Finance Premium" };
const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString() : null);
const idOf = (x: Any): string | null => (typeof x === "string" ? x : x?.id ?? null);
const lc = (s: string) => String(s || "").toLowerCase();

/* -------------------------------------------- Stripe object → DB payloads */
// Written for API version 2024-06-20 (pinned in _shared/stripe.ts) with
// fallbacks for newer shapes (period on items, invoice.parent).
export function mapSubscription(sub: Any) {
  const item = sub?.items?.data?.[0];
  const price = item?.price;
  return {
    provider: "stripe",
    provider_subscription_id: sub.id,
    provider_customer_id: idOf(sub.customer),
    user_id: sub.metadata?.user_id || null,
    price_provider_id: price?.id ?? null,
    plan_hint: price?.metadata?.kfp_plan || sub.metadata?.plan_id || null,
    billing_interval: price?.recurring?.interval ?? null,
    currency: String(sub.currency || price?.currency || "").toUpperCase(),
    status: sub.status,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    current_period_start: iso(sub.current_period_start ?? item?.current_period_start),
    current_period_end: iso(sub.current_period_end ?? item?.current_period_end),
    trial_end: iso(sub.trial_end),
    canceled_at: iso(sub.canceled_at),
    ended_at: iso(sub.ended_at),
    unit_amount_minor: price?.unit_amount ?? null,     // KRW: won (zero-decimal) · THB: satang
    latest_invoice_id: idOf(sub.latest_invoice),
  };
}

export function invoiceSubscriptionId(inv: Any): string | null {
  return idOf(inv.subscription) ?? inv.parent?.subscription_details?.subscription ??
    inv.lines?.data?.find((l: Any) => l.subscription)?.subscription ?? null;
}

export function mapInvoice(inv: Any, eventType: string) {
  const line = inv.lines?.data?.find((l: Any) => l.price) ?? inv.lines?.data?.[0];
  const pi = inv.payment_intent && typeof inv.payment_intent === "object" ? inv.payment_intent : null;
  const status = inv.status === "paid" ? "paid"
    : inv.status === "void" ? "void"
    : inv.status === "uncollectible" ? "uncollectible"
    : eventType === "invoice.payment_failed" ? "failed"
    : eventType === "invoice.payment_action_required" ? "action_required"
    : inv.status === "draft" ? "draft" : "open";
  return {
    provider: "stripe",
    provider_invoice_id: inv.id,
    provider_customer_id: idOf(inv.customer),
    user_id: inv.subscription_details?.metadata?.user_id || inv.metadata?.user_id || null,
    provider_subscription_id: invoiceSubscriptionId(inv),
    provider_payment_intent_id: idOf(inv.payment_intent),
    provider_charge_id: idOf(inv.charge) ?? idOf(pi?.latest_charge),
    price_provider_id: line?.price?.id ?? line?.pricing?.price_details?.price ?? null,
    billing_interval: line?.price?.recurring?.interval ?? null,
    currency: String(inv.currency || "").toUpperCase(),
    amount_due_minor: inv.amount_due ?? 0,
    amount_paid_minor: inv.amount_paid ?? 0,
    status,
    failure_reason: status === "failed" || status === "action_required"
      ? (pi?.last_payment_error?.message ?? inv.last_finalization_error?.message ??
         (status === "action_required" ? "ต้องยืนยันการชำระเงินเพิ่มเติม (เช่น 3D Secure)" : null))
      : null,
    period_start: iso(line?.period?.start),
    period_end: iso(line?.period?.end),
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf_url: inv.invoice_pdf ?? null,
    paid_at: iso(inv.status_transitions?.paid_at),
  };
}

export function mapRefund(charge: Any, refunds: Any[]) {
  return {
    provider: "stripe",
    provider_charge_id: charge.id,
    provider_payment_intent_id: idOf(charge.payment_intent),
    provider_invoice_id: idOf(charge.invoice),
    currency: String(charge.currency || "").toUpperCase(),
    amount_refunded_minor: charge.amount_refunded ?? 0,
    refunds: refunds.map((r) => ({ id: r.id, amount_minor: r.amount, status: r.status, reason: r.reason ?? null })),
  };
}

/* ------------------------------------------------------- webhook handling */
export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "charge.refunded",                    // refund tracking
];

// Every handler re-fetches the object from Stripe: event order and stale
// payloads never matter, and a replayed event just re-applies current state.
export async function handleStripeEvent(event: Any, deps: Deps): Promise<{ status: "processed" | "ignored"; detail?: Any }> {
  const { stripe, rpc } = deps;
  const obj = event?.data?.object ?? {};
  const applySub = async (subId: string, userHint?: string | null) => {
    const sub = await stripe.subscriptions.retrieve(subId);
    const p = mapSubscription(sub);
    if (userHint && !p.user_id) p.user_id = userHint;
    return rpc("kfp_apply_subscription", { p });
  };

  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || !obj.subscription) return { status: "ignored", detail: "not a subscription checkout" };
      const userId = obj.client_reference_id || obj.metadata?.user_id || null;
      const customer = idOf(obj.customer);
      if (userId && customer) {
        await rpc("kfp_upsert_billing_customer", { p: { user_id: userId, customer_id: customer, email: obj.customer_details?.email ?? null } });
      }
      return { status: "processed", detail: await applySub(idOf(obj.subscription)!, userId) };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return { status: "processed", detail: await applySub(obj.id) };

    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const inv = await stripe.invoices.retrieve(obj.id, { expand: ["payment_intent"] });
      const subId = invoiceSubscriptionId(inv);
      // Make sure the subscription exists first (invoice events can arrive before subscription events).
      const sub = subId ? await applySub(subId, inv.subscription_details?.metadata?.user_id ?? null) : null;
      const pay = await rpc("kfp_apply_invoice", { p: mapInvoice(inv, event.type) });
      return { status: "processed", detail: { payment: pay, subscription: sub } };
    }
    case "charge.refunded": {
      const charge = await stripe.charges.retrieve(obj.id);
      const refunds = await stripe.refunds.list({ charge: obj.id, limit: 100 });
      return { status: "processed", detail: await rpc("kfp_apply_refund", { p: mapRefund(charge, refunds.data || []) }) };
    }
    default:
      return { status: "ignored", detail: "unhandled event type" };
  }
}

export type Verify = (rawBody: string, signature: string) => Promise<Any>;

// Signature check → idempotency claim → handle → record result.
// Returns 500 on processing errors so Stripe retries the delivery.
export async function processWebhook(rawBody: string, signature: string | null, deps: Deps & { verify: Verify }): Promise<Result> {
  if (!signature) return { status: 400, body: { error: "missing_signature" } };
  let event: Any;
  try {
    event = await deps.verify(rawBody, signature);
  } catch (_) {
    return { status: 400, body: { error: "invalid_signature" } };
  }
  const claimed = await deps.rpc("kfp_claim_webhook_event", {
    p_event_id: event.id, p_type: event.type,
    p_payload: { id: event.id, type: event.type, created: event.created, livemode: event.livemode, object_id: event.data?.object?.id ?? null },
    p_provider: "stripe",
  });
  if (!claimed) return { status: 200, body: { received: true, duplicate: true } };
  try {
    const r = await handleStripeEvent(event, deps);
    await deps.rpc("kfp_finish_webhook_event", { p_event_id: event.id, p_status: r.status, p_error: null });
    return { status: 200, body: { received: true, status: r.status } };
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 500);
    deps.log?.("webhook processing failed", event.type, event.id, msg);
    try { await deps.rpc("kfp_finish_webhook_event", { p_event_id: event.id, p_status: "failed", p_error: msg }); } catch (_) { /* keep 500 */ }
    return { status: 500, body: { error: "processing_failed" } };
  }
}

/* ------------------------------------------------------------- checkout */
async function ensureStripePrice(price: Any, deps: Deps): Promise<string> {
  const { stripe, rpc } = deps;
  const productId = `kfp_${price.plan_id}`;           // fixed id → one product per plan, never duplicated
  try {
    await stripe.products.retrieve(productId);
  } catch (e) {
    const err = e as Any;
    if (err?.statusCode !== 404 && err?.code !== "resource_missing") throw e;
    await stripe.products.create(
      { id: productId, name: PLAN_NAMES[price.plan_id] || price.plan_id, metadata: { kfp_plan: price.plan_id } },
      { idempotencyKey: `kfp-product-${price.plan_id}` });
  }
  const created = await stripe.prices.create({
    product: productId,
    currency: lc(price.currency),
    unit_amount: Number(price.amount_minor),            // already in Stripe's minor unit (KRW zero-decimal)
    recurring: { interval: price.billing_interval },
    metadata: { kfp_plan: price.plan_id, kfp_price_row: price.id },
  }, { idempotencyKey: `kfp-price-${price.id}` });
  // first writer wins if two checkouts race; Stripe idempotency returns the same Price anyway
  return await rpc("kfp_set_price_provider_id", { p: { price_id: price.id, provider_price_id: created.id } });
}

export async function createCheckout(input: { userId: string; plan: string; interval: string; currency: string }, deps: Deps): Promise<Result> {
  const plan = String(input.plan || ""), interval = String(input.interval || ""), currency = String(input.currency || "").toUpperCase();
  if (!(PLANS as readonly string[]).includes(plan) || !["month", "year"].includes(interval) || !["THB", "KRW"].includes(currency)) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const allowed = await deps.rpc("kfp_rate_hit", { p_key: `checkout:${input.userId}`, p_max: 10, p_window_seconds: 3600 });
  if (allowed === false) return { status: 429, body: { error: "rate_limited" } };

  const ctx = await deps.rpc("kfp_checkout_context", { p: { user_id: input.userId, plan, interval, currency } });
  if (!ctx) return { status: 404, body: { error: "user_not_found" } };
  if (!ctx.verified) return { status: 403, body: { error: "email_not_verified" } };
  if (ctx.legacy) return { status: 403, body: { error: "legacy_email" } };
  if (ctx.suspended) return { status: 403, body: { error: "suspended" } };
  if (ctx.active_subscription) {
    // Upgrades / downgrades / renewals of an existing subscription go through the Customer Portal.
    return { status: 409, body: { error: "already_subscribed", plan: ctx.active_subscription.plan, status: ctx.active_subscription.status } };
  }
  if (!ctx.price) return { status: 404, body: { error: "price_not_available" } };

  const priceId: string = ctx.price.provider_price_id || await ensureStripePrice(ctx.price, deps);

  let customerId: string | null = ctx.customer_id;
  if (!customerId) {
    const c = await deps.stripe.customers.create(
      { email: ctx.email, metadata: { user_id: input.userId } },
      { idempotencyKey: `kfp-customer-${input.userId}` });
    customerId = c.id;
    await deps.rpc("kfp_upsert_billing_customer", { p: { user_id: input.userId, customer_id: customerId, email: ctx.email } });
  }

  const site = deps.siteUrl.replace(/\/+$/, "");
  const minute = Math.floor((deps.now ? deps.now() : Date.now()) / 60000);
  const session = await deps.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: input.userId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { user_id: input.userId, plan_id: plan },
    subscription_data: { metadata: { user_id: input.userId, plan_id: plan } },
    allow_promotion_codes: true,
    locale: "th",
    ...(deps.requireTos ? { consent_collection: { terms_of_service: "required" } } : {}),
    // The success URL is only a "thank you" page — access is granted by the webhook, never by this redirect.
    success_url: `${site}/pricing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/pricing.html?checkout=cancel`,
  }, { idempotencyKey: `kfp-checkout-${input.userId}-${priceId}-${minute}` });   // double-click → same session

  return { status: 200, body: { url: session.url } };
}

/* --------------------------------------------------------------- portal */
// flow:  manage          → portal home (invoices, card, plan, cancel)
//        payment_method  → straight to "update card"
//        switch          → straight to Stripe's confirm screen for a plan change
//                          (shows proration, handles 3-D Secure) — upgrade or downgrade
export const PORTAL_FLOWS = ["manage", "payment_method", "switch"] as const;
const LIVE = ["active", "trialing", "past_due", "unpaid"];

export async function createPortal(
  input: { userId: string; flow?: string; targetPlan?: string; targetInterval?: string },
  deps: Deps,
): Promise<Result> {
  const flow = String(input.flow || "manage");
  if (!(PORTAL_FLOWS as readonly string[]).includes(flow)) return { status: 400, body: { error: "invalid_request" } };
  const allowed = await deps.rpc("kfp_rate_hit", { p_key: `portal:${input.userId}`, p_max: 20, p_window_seconds: 3600 });
  if (allowed === false) return { status: 429, body: { error: "rate_limited" } };

  const base = await deps.rpc("kfp_checkout_context", { p: { user_id: input.userId, plan: "plus", interval: "month", currency: "THB" } });
  if (!base) return { status: 404, body: { error: "user_not_found" } };
  if (base.suspended) return { status: 403, body: { error: "suspended" } };
  if (!base.customer_id) return { status: 404, body: { error: "no_customer" } };
  const site = deps.siteUrl.replace(/\/+$/, "");
  const params: Any = {
    customer: base.customer_id,
    return_url: `${site}/account.html?portal=return`,
    locale: "th",
    ...(deps.portalConfiguration ? { configuration: deps.portalConfiguration } : {}),
  };

  if (flow === "payment_method") {
    params.flow_data = { type: "payment_method_update" };
  } else if (flow === "switch") {
    const sub = base.active_subscription;
    if (!sub) return { status: 404, body: { error: "no_subscription" } };
    if (!["active", "trialing"].includes(sub.status)) return { status: 409, body: { error: "not_switchable", status: sub.status } };   // pay the open invoice first
    if (sub.cancel_at_period_end) return { status: 409, body: { error: "resume_first" } };
    const plan = String(input.targetPlan || ""), interval = String(input.targetInterval || sub.billing_interval || "");
    if (!(PLANS as readonly string[]).includes(plan) || !["month", "year"].includes(interval)) return { status: 400, body: { error: "invalid_request" } };
    if (plan === sub.plan && interval === sub.billing_interval) return { status: 400, body: { error: "same_plan" } };
    // A Stripe subscription keeps its currency — the new price must be in the same currency.
    const ctx = await deps.rpc("kfp_checkout_context", { p: { user_id: input.userId, plan, interval, currency: sub.currency } });
    if (!ctx?.price) return { status: 404, body: { error: "price_not_available" } };
    const priceId: string = ctx.price.provider_price_id || await ensureStripePrice(ctx.price, deps);
    const live = await deps.stripe.subscriptions.retrieve(sub.id);
    if (idOf(live.customer) !== base.customer_id) return { status: 403, body: { error: "forbidden" } };
    const itemId = live.items?.data?.[0]?.id;
    if (!itemId) return { status: 409, body: { error: "not_switchable" } };
    params.flow_data = {
      type: "subscription_update_confirm",
      subscription_update_confirm: { subscription: sub.id, items: [{ id: itemId, price: priceId, quantity: 1 }] },
      after_completion: { type: "redirect", redirect: { return_url: `${site}/account.html?portal=updated` } },
    };
  }
  const session = await deps.stripe.billingPortal.sessions.create(params);
  return { status: 200, body: { url: session.url } };
}

/* ------------------------------------------- cancel / resume (our own UI) */
// Cancel = stop auto-renew at the end of the paid period (access stays until then).
// Resume = turn auto-renew back on before that date. The database is updated right
// away from Stripe's answer; the customer.subscription.updated webhook re-applies the same state.
const CANCEL_FEEDBACK = ["too_expensive", "missing_features", "unused", "switched_service", "too_complex", "low_quality", "customer_service", "other"];

export async function subscriptionAction(
  input: { userId: string; action: string; feedback?: string; comment?: string },
  deps: Deps,
): Promise<Result> {
  const action = String(input.action || "");
  if (!["cancel", "resume"].includes(action)) return { status: 400, body: { error: "invalid_request" } };
  if (input.feedback && !CANCEL_FEEDBACK.includes(String(input.feedback))) return { status: 400, body: { error: "invalid_request" } };
  const allowed = await deps.rpc("kfp_rate_hit", { p_key: `subaction:${input.userId}`, p_max: 10, p_window_seconds: 3600 });
  if (allowed === false) return { status: 429, body: { error: "rate_limited" } };

  const ctx = await deps.rpc("kfp_checkout_context", { p: { user_id: input.userId, plan: "plus", interval: "month", currency: "THB" } });
  if (!ctx) return { status: 404, body: { error: "user_not_found" } };
  if (ctx.suspended) return { status: 403, body: { error: "suspended" } };
  const sub = ctx.active_subscription;
  if (!sub) return { status: 404, body: { error: "no_subscription" } };

  // Stripe is the source of truth: read it, check ownership, act only if something changes.
  const live = await deps.stripe.subscriptions.retrieve(sub.id);
  if (idOf(live.customer) !== ctx.customer_id) return { status: 403, body: { error: "forbidden" } };
  const apply = async (s: Any) => {
    const p = mapSubscription(s);
    if (!p.user_id) p.user_id = input.userId;
    await deps.rpc("kfp_apply_subscription", { p });
    return p;
  };
  if (!LIVE.includes(live.status)) {
    await apply(live);                                  // our row was stale — sync it
    return { status: 409, body: { error: "subscription_ended", status: live.status } };
  }
  const want = action === "cancel";
  if (!!live.cancel_at_period_end === want) {
    const p = await apply(live);
    return { status: 200, body: { changed: false, status: p.status, cancel_at_period_end: p.cancel_at_period_end, current_period_end: p.current_period_end } };
  }
  const update: Any = { cancel_at_period_end: want };
  if (want && (input.feedback || input.comment)) {
    update.cancellation_details = {
      ...(input.feedback ? { feedback: input.feedback } : {}),
      ...(input.comment ? { comment: String(input.comment).slice(0, 500) } : {}),
    };
  }
  const updated = await deps.stripe.subscriptions.update(sub.id, update);
  const p = await apply(updated);
  deps.log?.("subscription", action, sub.id, input.userId);
  return { status: 200, body: { changed: true, status: p.status, cancel_at_period_end: p.cancel_at_period_end, current_period_end: p.current_period_end } };
}

/* ------------------------------------------------- admin: cancel (Phase 10) */
// Called by the admin-actions Edge Function. The caller's role is read from the
// database (admin_roles, not suspended) — never from the request body.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function adminCancelSubscription(
  input: { adminId: string; userId: string; mode: string; reason: string },
  deps: Deps,
): Promise<Result> {
  const mode = String(input.mode || ""), reason = String(input.reason || "").trim();
  if (!UUID_RE.test(String(input.userId || "")) || !["period_end", "now"].includes(mode)) return { status: 400, body: { error: "invalid_request" } };
  if (reason.length < 3 || reason.length > 500) return { status: 400, body: { error: "reason_required" } };
  const role = await deps.rpc("kfp_admin_role", { p_uid: input.adminId });
  if (role !== "admin" && role !== "owner") return { status: 403, body: { error: "forbidden" } };
  if (input.userId === input.adminId) return { status: 403, body: { error: "cannot_act_on_self" } };
  const targetRole = await deps.rpc("kfp_admin_role", { p_uid: input.userId });
  if (targetRole && role !== "owner") return { status: 403, body: { error: "only_owner_can_change_admins" } };
  const allowed = await deps.rpc("kfp_rate_hit", { p_key: `admin:${input.adminId}`, p_max: 60, p_window_seconds: 3600 });
  if (allowed === false) return { status: 429, body: { error: "rate_limited" } };

  const ctx = await deps.rpc("kfp_checkout_context", { p: { user_id: input.userId, plan: "plus", interval: "month", currency: "THB" } });
  if (!ctx) return { status: 404, body: { error: "user_not_found" } };
  const sub = ctx.active_subscription;
  if (!sub) return { status: 404, body: { error: "no_subscription" } };
  const live = await deps.stripe.subscriptions.retrieve(sub.id);
  if (idOf(live.customer) !== ctx.customer_id) return { status: 409, body: { error: "customer_mismatch" } };
  const before = { status: live.status, cancel_at_period_end: !!live.cancel_at_period_end, current_period_end: iso(live.current_period_end) };

  let updated: Any;
  if (mode === "now") {
    updated = await deps.stripe.subscriptions.cancel(sub.id, { cancellation_details: { comment: `admin: ${reason}`.slice(0, 500) } });
  } else if (live.cancel_at_period_end) {
    updated = live;
  } else {
    updated = await deps.stripe.subscriptions.update(sub.id, { cancel_at_period_end: true, cancellation_details: { comment: `admin: ${reason}`.slice(0, 500) } });
  }
  const p = mapSubscription(updated);
  if (!p.user_id) p.user_id = input.userId;
  await deps.rpc("kfp_apply_subscription", { p });
  const after = { status: p.status, cancel_at_period_end: p.cancel_at_period_end, current_period_end: p.current_period_end };
  await deps.rpc("kfp_admin_audit", { p: {
    action: mode === "now" ? "subscription.cancel_now" : "subscription.cancel", admin_id: input.adminId, target_user_id: input.userId,
    target_table: "subscriptions", target_id: sub.id, before, after, reason } });
  return { status: 200, body: { changed: updated !== live, ...after } };
}
