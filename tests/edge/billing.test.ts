/* Phase 7: Edge Function core (supabase/functions/_shared/billing.ts) against
 *   - a FAKE Stripe (in-memory, same object shapes as API 2024-06-20, signs webhooks like Stripe)
 *   - the REAL Postgres test database (migrations applied by tests/run-sql-tests.sh)
 * Run: PGHOST=… PGPORT=… PGUSER=postgres npx tsx tests/edge/billing.test.ts
 */
import { execFileSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { adminCancelSubscription, createCheckout, createPortal, HANDLED_EVENTS, processWebhook, subscriptionAction, type Deps } from "../../supabase/functions/_shared/billing.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const DB = process.env.KFP_TEST_DB || "kfp_test";
let pass = 0, fail = 0;
function ok(c: unknown, n: string) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } }

/* ------------------------------------------------------------ Postgres */
function sql(q: string, asService = false): string {
  return execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", DB, "-c",
    (asService ? "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false); set role service_role; " : "") + q],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim().split("\n").pop() || "";
}
const lit = (s: unknown) => s === null || s === undefined ? "null" : "'" + String(s).replace(/'/g, "''") + "'";
const jlit = (o: unknown) => "$kfp$" + JSON.stringify(o) + "$kfp$::jsonb";
// Same contract as supabase.rpc(): named args → our SQL functions (service_role)
const rpcCalls: string[] = [];
const rpc = async (fn: string, a: Record<string, unknown>) => {
  rpcCalls.push(fn);
  let call: string;
  if (fn === "kfp_rate_hit") call = `public.kfp_rate_hit(${lit(a.p_key)}, ${Number(a.p_max)}, ${Number(a.p_window_seconds)})`;
  else if (fn === "kfp_claim_webhook_event") call = `public.kfp_claim_webhook_event(${lit(a.p_event_id)}, ${lit(a.p_type)}, ${jlit(a.p_payload)}, ${lit(a.p_provider ?? "stripe")})`;
  else if (fn === "kfp_admin_role") call = `public.kfp_admin_role(${lit(a.p_uid)}::uuid)`;
  else if (fn === "kfp_finish_webhook_event") call = `public.kfp_finish_webhook_event(${lit(a.p_event_id)}, ${lit(a.p_status)}, ${lit(a.p_error)})`;
  else call = `public.${fn}(${jlit(a.p)})`;
  let out: string;
  try { out = sql(`select coalesce(to_json(${call})::text, 'null')`, true); }
  catch (e) { throw new Error(`${fn}: ${String((e as Any).stderr || e).split("\n").find((l: string) => /ERROR/.test(l)) || e}`); }
  return out ? JSON.parse(out) : null;
};

/* ------------------------------------------------------------ fake Stripe */
const SECRET = "whsec_test_kfp";
function sign(payload: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}
// Mirrors stripe.webhooks.constructEventAsync (HMAC-SHA256 over "t.payload", 300 s tolerance).
async function verify(raw: string, header: string) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t), v1 = parts.v1 || "";
  if (!t || !v1) throw new Error("bad header");
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new Error("timestamp outside tolerance");
  const expect = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  if (expect.length !== v1.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(v1))) throw new Error("signature mismatch");
  return JSON.parse(raw);
}
class NotFound extends Error { statusCode = 404; code = "resource_missing"; }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const now = () => Math.floor(Date.now() / 1000);
let seq = 0; const RUN = Date.now().toString(36); const id = (p: string) => `${p}_${RUN}${++seq}`;

const S = {
  customers: new Map<string, Any>(), products: new Map<string, Any>(), prices: new Map<string, Any>(),
  subs: new Map<string, Any>(), invoices: new Map<string, Any>(), charges: new Map<string, Any>(), refunds: [] as Any[],
  calls: [] as Any[],
};
const stripe = {
  customers: { create: async (p: Any, o: Any) => { S.calls.push(["customers.create", p, o]); const c = { id: id("cus"), ...p }; S.customers.set(c.id, c); return c; } },
  products: {
    retrieve: async (pid: string) => { S.calls.push(["products.retrieve", pid]); if (!S.products.has(pid)) throw new NotFound(); return S.products.get(pid); },
    create: async (p: Any, o: Any) => { S.calls.push(["products.create", p, o]); S.products.set(p.id, p); return p; },
  },
  prices: { create: async (p: Any, o: Any) => { S.calls.push(["prices.create", p, o]); const pr = { id: id("price"), ...p }; S.prices.set(pr.id, pr); return pr; } },
  checkout: { sessions: { create: async (p: Any, o: Any) => { S.calls.push(["checkout.sessions.create", p, o]); const sid = id("cs_test"); return { id: sid, url: `https://checkout.stripe.com/c/pay/${sid}` }; } } },
  billingPortal: { sessions: { create: async (p: Any) => { S.calls.push(["billingPortal.sessions.create", p]); return { url: `https://billing.stripe.com/p/session/${id("bps")}` }; } } },
  subscriptions: {
    retrieve: async (sid: string) => { if (!S.subs.has(sid)) throw new NotFound(); return clone(S.subs.get(sid)); },
    update: async (sid: string, p: Any, o: Any) => {
      S.calls.push(["subscriptions.update", sid, p, o]);
      if (!S.subs.has(sid)) throw new NotFound();
      const sub = S.subs.get(sid); Object.assign(sub, p); return clone(sub); },
    cancel: async (sid: string, p: Any) => {
      S.calls.push(["subscriptions.cancel", sid, p]);
      if (!S.subs.has(sid)) throw new NotFound();
      const sub = S.subs.get(sid); Object.assign(sub, { status: "canceled", canceled_at: now(), ended_at: now() }); return clone(sub); },
  },
  invoices: { retrieve: async (iid: string, p: Any) => {
    if (!S.invoices.has(iid)) throw new NotFound();
    const inv = clone(S.invoices.get(iid));
    if (p?.expand?.includes("payment_intent") && typeof inv.payment_intent === "string") inv.payment_intent = clone(inv._pi);
    delete inv._pi; return inv; } },
  charges: { retrieve: async (cid: string) => { if (!S.charges.has(cid)) throw new NotFound(); return clone(S.charges.get(cid)); } },
  refunds: { list: async (p: Any) => ({ data: S.refunds.filter((r) => r.charge === p.charge).map(clone) }) },
};
function makeSub(customer: string, priceId: string, status = "active", extra: Any = {}) {
  const pr = S.prices.get(priceId) ?? { id: priceId, currency: "thb", unit_amount: 12900, recurring: { interval: "month" }, metadata: {} };
  const s = { id: id("sub"), object: "subscription", customer, status, currency: pr.currency, cancel_at_period_end: false,
    current_period_start: now(), current_period_end: now() + 30 * 86400, trial_end: null, canceled_at: null, ended_at: null,
    latest_invoice: null, metadata: {}, items: { data: [{ id: id("si"), price: clone(pr) }] }, ...extra };
  S.subs.set(s.id, s); return s;
}
function makeInvoice(sub: Any, status: string, extra: Any = {}) {
  const pr = sub.items.data[0].price, pi = id("pi"), ch = id("ch");
  const inv = { id: id("in"), object: "invoice", customer: sub.customer, subscription: sub.id, currency: pr.currency, status,
    amount_due: pr.unit_amount, amount_paid: status === "paid" ? pr.unit_amount : 0, charge: status === "paid" ? ch : null,
    payment_intent: pi, _pi: { id: pi, latest_charge: ch, last_payment_error: null },
    hosted_invoice_url: `https://invoice.stripe.com/i/${pi}`, invoice_pdf: `https://pay.stripe.com/invoice/${pi}/pdf`,
    status_transitions: { paid_at: status === "paid" ? now() : null }, subscription_details: { metadata: sub.metadata },
    lines: { data: [{ price: clone(pr), subscription: sub.id, period: { start: sub.current_period_start, end: sub.current_period_end } }] }, ...extra };
  S.invoices.set(inv.id, inv);
  if (status === "paid") S.charges.set(ch, { id: ch, currency: pr.currency, amount: pr.unit_amount, amount_refunded: 0, payment_intent: pi, invoice: inv.id });
  return inv;
}
const evt = (type: string, object: Any, eid = id("evt")) => ({ id: eid, object: "event", type, created: now(), livemode: false, data: { object } });
const deps: Deps & { verify: typeof verify } = { stripe, rpc, siteUrl: "https://example.github.io/korea-finance-planner/", verify, now: () => Date.now() };
async function deliver(event: Any, opt: { sig?: string | null; raw?: string } = {}) {
  const raw = opt.raw ?? JSON.stringify(event);
  return processWebhook(raw, opt.sig === undefined ? sign(raw) : opt.sig, deps);
}
const plan = (u: string) => sql(`select plan_id from public.kfp_effective_plan('${u}')`);
const one = (q: string) => sql(q);

/* ----------------------------------------------------------------- setup */
const U = { buyer: "f0000000-0000-0000-0000-000000000001", legacy: "f0000000-0000-0000-0000-000000000002",
            unver: "f0000000-0000-0000-0000-000000000003", krw: "f0000000-0000-0000-0000-000000000004", susp: "f0000000-0000-0000-0000-000000000005",
            orphan: "f0000000-0000-0000-0000-000000000006", admin: "f0000000-0000-0000-0000-000000000007", viewer: "f0000000-0000-0000-0000-000000000008" };
sql(`delete from auth.users where id::text like 'f0000000-%'`);
sql(`delete from public.stripe_webhook_events where event_id like 'evt_%' or event_id like 'evtfix_%'`);
sql(`delete from public.rate_limits where key ~ '^(checkout|portal|subaction|admin):f0000000-'`);
sql(`insert into auth.users (id, email, email_confirmed_at) values
  ('${U.buyer}','buyer.p7@x.com',now()), ('${U.legacy}','oldie@kfp.example.com',now()), ('${U.unver}','new.p7@x.com',null),
  ('${U.krw}','krw.p7@x.com',now()), ('${U.susp}','susp.p7@x.com',now()), ('${U.orphan}','orphan.p7@x.com',now()),
  ('${U.admin}','admin.p10@x.com',now()), ('${U.viewer}','viewer.p10@x.com',now())`);
sql(`insert into public.admin_roles (user_id, role) values ('${U.admin}','admin'), ('${U.viewer}','viewer')`);
sql(`update public.profiles set suspended_at = now() where user_id = '${U.susp}'`);
// Fresh active prices WITHOUT Stripe ids, so checkout must create them (lazy sync).
sql(`update public.plan_prices set provider_price_id = null where active and plan_id in ('plus','premium')`);

(async () => {
  console.log("C1 checkout validation");
  let r = await createCheckout({ userId: U.buyer, plan: "gold", interval: "month", currency: "THB" }, deps);
  ok(r.status === 400, "unknown plan → 400");
  r = await createCheckout({ userId: U.buyer, plan: "plus", interval: "week", currency: "THB" }, deps);
  ok(r.status === 400, "bad interval → 400");
  r = await createCheckout({ userId: U.buyer, plan: "plus", interval: "month", currency: "USD" }, deps);
  ok(r.status === 400, "bad currency → 400");
  r = await createCheckout({ userId: U.unver, plan: "plus", interval: "month", currency: "THB" }, deps);
  ok(r.status === 403 && r.body.error === "email_not_verified", "unverified e-mail → 403");
  r = await createCheckout({ userId: U.legacy, plan: "plus", interval: "month", currency: "THB" }, deps);
  ok(r.status === 403 && r.body.error === "legacy_email", "legacy @kfp.example.com → 403 (link a real e-mail first)");
  r = await createCheckout({ userId: U.susp, plan: "plus", interval: "month", currency: "THB" }, deps);
  ok(r.status === 403 && r.body.error === "suspended", "suspended → 403");
  ok(!S.calls.some((c) => c[0] === "checkout.sessions.create"), "no Stripe session for refused requests");

  console.log("C2 first checkout: product + price created from plan_prices, customer created once");
  r = await createCheckout({ userId: U.buyer, plan: "plus", interval: "month", currency: "thb" }, deps);
  ok(r.status === 200 && String(r.body.url).startsWith("https://checkout.stripe.com/"), "200 + Checkout URL");
  const pc = S.calls.find((c) => c[0] === "prices.create");
  const dbAmount = Number(one(`select amount_minor from public.plan_prices where active and plan_id='plus' and billing_interval='month' and currency='THB'`));
  ok(pc && pc[1].unit_amount === dbAmount && pc[1].currency === "thb" && pc[1].recurring.interval === "month" && pc[1].product === "kfp_plus",
     `Stripe Price = DB price (${dbAmount} satang, thb, month, product kfp_plus)`);
  ok(pc && String(pc[2].idempotencyKey).startsWith("kfp-price-"), "price creation is idempotent per price row");
  ok(S.calls.some((c) => c[0] === "products.create" && c[1].id === "kfp_plus"), "product kfp_plus created (fixed id)");
  const storedPrice = one(`select provider_price_id from public.plan_prices where active and plan_id='plus' and billing_interval='month' and currency='THB'`);
  ok(storedPrice.startsWith("price_"), "Stripe price id saved to plan_prices");
  const cc = S.calls.filter((c) => c[0] === "customers.create");
  ok(cc.length === 1 && cc[0][1].email === "buyer.p7@x.com" && cc[0][1].metadata.user_id === U.buyer && cc[0][2].idempotencyKey === `kfp-customer-${U.buyer}`, "customer with e-mail + user_id metadata, idempotent");
  const cs = S.calls.find((c) => c[0] === "checkout.sessions.create")![1];
  ok(cs.mode === "subscription" && cs.client_reference_id === U.buyer && cs.subscription_data.metadata.user_id === U.buyer && cs.line_items[0].price === storedPrice, "session: subscription mode, user ref + metadata, DB price");
  ok(cs.success_url === "https://example.github.io/korea-finance-planner/pricing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}" && cs.cancel_url.endsWith("checkout=cancel"), "success/cancel URLs from SITE_URL");
  ok(cs.locale === "th" && cs.allow_promotion_codes === true && !("consent_collection" in cs), "Thai locale, promo codes, ToS box off by default");
  S.calls.length = 0;
  r = await createCheckout({ userId: U.buyer, plan: "plus", interval: "month", currency: "THB" }, deps);
  ok(r.status === 200 && !S.calls.some((c) => c[0] === "prices.create" || c[0] === "customers.create" || c[0] === "products.create"), "second checkout reuses price + customer");
  const keys = S.calls.filter((c) => c[0] === "checkout.sessions.create").map((c) => c[2].idempotencyKey);
  ok(keys.length === 1 && keys[0].startsWith(`kfp-checkout-${U.buyer}-`), "double click within a minute → same idempotency key");

  console.log("C3 KRW (zero-decimal) + ToS option");
  S.calls.length = 0;
  r = await createCheckout({ userId: U.krw, plan: "premium", interval: "year", currency: "KRW" }, { ...deps, requireTos: true });
  const kp = S.calls.find((c) => c[0] === "prices.create");
  const krwAmount = Number(one(`select amount_minor from public.plan_prices where active and plan_id='premium' and billing_interval='year' and currency='KRW'`));
  ok(r.status === 200 && kp && kp[1].currency === "krw" && kp[1].unit_amount === krwAmount && kp[1].recurring.interval === "year", `KRW price sent in won, not ×100 (${krwAmount})`);
  ok(S.calls.find((c) => c[0] === "checkout.sessions.create")![1].consent_collection.terms_of_service === "required", "ToS consent when enabled");
  r = await createCheckout({ userId: U.buyer, plan: "plus", interval: "year", currency: "KRW" }, deps);
  ok(r.status === 200, "KRW yearly plus available (admin set it in phase 6)");

  console.log("C4 portal");
  r = await createPortal({ userId: U.unver }, deps);
  ok(r.status === 404 && r.body.error === "no_customer", "no Stripe customer → 404");
  r = await createPortal({ userId: U.buyer }, deps);
  const ps = S.calls.find((c) => c[0] === "billingPortal.sessions.create")![1];
  ok(r.status === 200 && String(r.body.url).startsWith("https://billing.stripe.com/") && ps.customer.startsWith("cus_") && ps.return_url === "https://example.github.io/korea-finance-planner/account.html?portal=return", "portal session for the user's customer, returns to account.html");
  ok(!ps.flow_data && ps.locale === "th", "default flow = portal home (Thai)");
  r = await createPortal({ userId: U.buyer, flow: "hack" }, deps);
  ok(r.status === 400, "unknown flow → 400");
  S.calls.length = 0;
  r = await createPortal({ userId: U.buyer, flow: "payment_method" }, deps);
  ok(r.status === 200 && S.calls.find((c) => c[0] === "billingPortal.sessions.create")![1].flow_data.type === "payment_method_update", "flow payment_method → straight to 'update card'");
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "premium" }, deps);
  ok(r.status === 404 && r.body.error === "no_subscription", "switch without a subscription → 404 (use checkout)");

  console.log("W1 webhook signature");
  const cusBuyer = one(`select provider_customer_id from public.billing_customers where user_id='${U.buyer}'`);
  const sub = makeSub(cusBuyer, storedPrice, "active", { metadata: { user_id: U.buyer, plan_id: "plus" } });
  const session = { id: "cs_x", object: "checkout.session", mode: "subscription", customer: cusBuyer, subscription: sub.id, client_reference_id: U.buyer, metadata: { user_id: U.buyer } };
  const e1 = evt("checkout.session.completed", session, "evt_checkout_1");
  r = await deliver(e1, { sig: null });
  ok(r.status === 400 && r.body.error === "missing_signature", "no signature → 400");
  r = await deliver(e1, { sig: sign(JSON.stringify(e1), undefined, "whsec_wrong") });
  ok(r.status === 400 && r.body.error === "invalid_signature", "wrong secret → 400");
  r = await deliver(e1, { sig: sign(JSON.stringify(e1)), raw: JSON.stringify(e1).replace(U.buyer, U.krw) });
  ok(r.status === 400, "tampered body → 400");
  r = await deliver(e1, { sig: sign(JSON.stringify(e1), now() - 3600) });
  ok(r.status === 400, "replayed old signature (1 h) → 400");
  ok(one(`select count(*) from public.stripe_webhook_events where event_id='evt_checkout_1'`) === "0", "rejected deliveries never touch the database");
  ok(plan(U.buyer) === "free", "buyer still Free (success URL alone grants nothing)");

  console.log("W2 checkout.session.completed → Plus; duplicates ignored");
  r = await deliver(e1);
  ok(r.status === 200 && r.body.status === "processed", "processed");
  ok(plan(U.buyer) === "plus", "buyer is Plus");
  r = await deliver(e1);
  ok(r.status === 200 && r.body.duplicate === true, "same event again → 200 duplicate");
  ok(one(`select count(*) from public.subscriptions where provider_subscription_id='${sub.id}'`) === "1", "one subscription row");

  console.log("W3 invoice.paid → payment history with invoice links");
  const inv1 = makeInvoice(sub, "paid");
  r = await deliver(evt("invoice.paid", { id: inv1.id, object: "invoice" }));
  const pay1 = one(`select status||'|'||amount_paid_minor||'|'||currency||'|'||coalesce(plan_id,'')||'|'||(hosted_invoice_url is not null)||'|'||(invoice_pdf_url is not null)||'|'||(subscription_id is not null) from public.payments where provider_invoice_id='${inv1.id}'`);
  ok(r.status === 200 && pay1 === `paid|${dbAmount}|THB|plus|true|true|true`, "payment row: " + pay1);

  console.log("W4 renewal fails → failed payment + past_due (grace), then 3DS required");
  const s = S.subs.get(sub.id); s.status = "past_due"; s.current_period_start = now() - 86400; s.current_period_end = now() + 29 * 86400;
  const inv2 = makeInvoice(sub, "open", { attempt_count: 1 });
  S.invoices.get(inv2.id)._pi.last_payment_error = { message: "Your card has insufficient funds." };
  r = await deliver(evt("invoice.payment_failed", { id: inv2.id, object: "invoice" }));
  ok(r.status === 200 && one(`select status||'|'||failure_reason from public.payments where provider_invoice_id='${inv2.id}'`) === "failed|Your card has insufficient funds.", "failed with card error message");
  ok(one(`select status from public.subscriptions where provider_subscription_id='${sub.id}'`) === "past_due" && plan(U.buyer) === "plus", "past_due, still Plus within grace");
  r = await deliver(evt("invoice.payment_action_required", { id: inv2.id, object: "invoice" }));
  ok(one(`select status from public.payments where provider_invoice_id='${inv2.id}'`) === "action_required", "action_required recorded");

  console.log("W5 portal upgrade → customer.subscription.updated → Premium");
  const premPrice = (await stripe.prices.create({ product: "kfp_premium", currency: "thb", unit_amount: 19900, recurring: { interval: "month" }, metadata: { kfp_plan: "premium" } }, {})).id;
  s.status = "active"; s.items.data[0].price = clone(S.prices.get(premPrice));
  r = await deliver(evt("customer.subscription.updated", { id: sub.id, object: "subscription", status: "active" }));
  ok(r.status === 200 && plan(U.buyer) === "premium", "upgraded to Premium (plan from Stripe price metadata)");

  console.log("W6 stale / out-of-order payload: state is re-fetched from Stripe");
  s.status = "canceled"; s.canceled_at = now(); s.ended_at = now(); s.current_period_end = now() - 1;
  r = await deliver(evt("customer.subscription.updated", { id: sub.id, object: "subscription", status: "active" /* stale */ }));
  ok(one(`select status from public.subscriptions where provider_subscription_id='${sub.id}'`) === "canceled" && plan(U.buyer) === "free", "stale 'active' payload ignored → canceled, Free");
  r = await deliver(evt("customer.subscription.deleted", { id: sub.id, object: "subscription" }));
  ok(r.status === 200 && plan(U.buyer) === "free", "deleted → Free");
  ok(one(`select count(*) from public.payments where user_id='${U.buyer}'`) === "2", "payment history kept after cancel");

  console.log("W7 refund tracking (charge.refunded)");
  const ch = S.charges.get(inv1.charge); ch.amount_refunded = 5000;
  S.refunds.push({ id: "re_p7_1", charge: ch.id, amount: 5000, status: "succeeded", reason: "requested_by_customer" });
  r = await deliver(evt("charge.refunded", { id: ch.id, object: "charge" }));
  ok(r.status === 200 && one(`select status||'|'||amount_refunded_minor from public.payments where provider_invoice_id='${inv1.id}'`) === "partially_refunded|5000", "partial refund recorded");

  console.log("W8 processing error → 500 (Stripe retries) → succeeds after fix");
  const orphanSub = makeSub("cus_orphan", storedPrice, "active");        // customer we never saw, no metadata
  const eFix = evt("customer.subscription.created", { id: orphanSub.id, object: "subscription" }, "evtfix_1");
  r = await deliver(eFix);
  ok(r.status === 500 && one(`select status from public.stripe_webhook_events where event_id='evtfix_1'`) === "failed", "unknown customer → 500, event marked failed");
  ok(/unknown customer/.test(one(`select last_error from public.stripe_webhook_events where event_id='evtfix_1'`)), "error message stored for debugging");
  sql(`insert into public.billing_customers (user_id, provider_customer_id) values ('${U.orphan}', 'cus_orphan')`);
  r = await deliver(eFix);
  ok(r.status === 200 && one(`select status||'|'||attempts from public.stripe_webhook_events where event_id='evtfix_1'`) === "processed|2", "retry processed (attempt 2)");
  ok(plan(U.orphan) === "plus", "user gets Plus after the retry");

  console.log("W9 other events");
  r = await deliver(evt("checkout.session.completed", { id: "cs_pay", mode: "payment" }));
  ok(r.status === 200 && r.body.status === "ignored", "one-time payment checkout ignored");
  r = await deliver(evt("customer.created", { id: "cus_zzz" }));
  ok(r.status === 200 && r.body.status === "ignored", "unhandled type → 200 ignored (no retries)");
  ok(HANDLED_EVENTS.length === 8 && ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
     "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required"].every((t) => HANDLED_EVENTS.includes(t)), "all 7 required events handled (+ charge.refunded)");

  console.log("C5 rate limit + already subscribed");
  const activeSub = makeSub(cusBuyer, storedPrice, "active", { metadata: { user_id: U.buyer } });
  await deliver(evt("customer.subscription.created", { id: activeSub.id, object: "subscription" }));
  r = await createCheckout({ userId: U.buyer, plan: "premium", interval: "month", currency: "THB" }, deps);
  ok(r.status === 409 && r.body.error === "already_subscribed", "has active subscription → 409 (use portal to change plan)");
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await createCheckout({ userId: U.unver, plan: "plus", interval: "month", currency: "THB" }, deps)).status;
  ok(last === 429, "more than 10 checkouts/hour → 429");

  console.log("P1 plan switch via portal confirm screen (upgrade / downgrade)");
  const item0 = activeSub.items.data[0].id;
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "plus" }, deps);
  ok(r.status === 400 && r.body.error === "same_plan", "same plan + interval → 400 same_plan");
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "gold" }, deps);
  ok(r.status === 400, "unknown target plan → 400");
  S.calls.length = 0;
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "premium" }, deps);
  const sw = S.calls.find((c) => c[0] === "billingPortal.sessions.create")?.[1];
  const premTHB = one(`select provider_price_id from public.plan_prices where active and plan_id='premium' and billing_interval='month' and currency='THB'`);
  ok(r.status === 200 && sw?.flow_data?.type === "subscription_update_confirm" && sw.flow_data.subscription_update_confirm.subscription === activeSub.id,
     "upgrade → subscription_update_confirm for the member's subscription");
  ok(sw?.flow_data.subscription_update_confirm.items[0].id === item0 && sw.flow_data.subscription_update_confirm.items[0].price === premTHB && premTHB.startsWith("price_"),
     "replaces the existing item with the DB's Premium THB monthly price (created lazily)");
  ok(sw?.flow_data.after_completion.redirect.return_url.endsWith("/account.html?portal=updated"), "returns to account.html after confirming");
  ok(S.prices.get(premTHB)?.currency === "thb", "currency kept (THB subscription → THB price)");
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "plus", targetInterval: "year" }, deps);
  ok(r.status === 200, "monthly → yearly on the same plan allowed");
  ok(!S.calls.some((c) => c[0] === "subscriptions.update"), "portal flows never change the subscription themselves (Stripe does after confirm)");

  console.log("A1 cancel / resume (billing-action)");
  r = await subscriptionAction({ userId: U.buyer, action: "pause" }, deps);
  ok(r.status === 400, "unknown action → 400");
  r = await subscriptionAction({ userId: U.buyer, action: "cancel", feedback: "<script>" }, deps);
  ok(r.status === 400, "unknown feedback value → 400");
  r = await subscriptionAction({ userId: U.krw, action: "cancel" }, deps);
  ok(r.status === 404 && r.body.error === "no_subscription", "no subscription → 404");
  S.calls.length = 0;
  r = await subscriptionAction({ userId: U.buyer, action: "cancel", feedback: "too_expensive", comment: "แพงไป" }, deps);
  const up = S.calls.find((c) => c[0] === "subscriptions.update");
  ok(r.status === 200 && r.body.changed === true && r.body.cancel_at_period_end === true, "cancel → 200, auto-renew off");
  ok(up && up[1] === activeSub.id && up[2].cancel_at_period_end === true && up[2].cancellation_details.feedback === "too_expensive" && !("cancel_at" in up[2]),
     "Stripe: cancel_at_period_end (not immediate), reason passed");
  ok(one(`select cancel_at_period_end from public.subscriptions where provider_subscription_id='${activeSub.id}'`) === "t", "DB updated immediately (no waiting for the webhook)");
  ok(plan(U.buyer) === "plus", "still Plus until the period ends");
  S.calls.length = 0;
  r = await subscriptionAction({ userId: U.buyer, action: "cancel" }, deps);
  ok(r.status === 200 && r.body.changed === false && !S.calls.some((c) => c[0] === "subscriptions.update"), "cancel twice → no second Stripe call");
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "premium" }, deps);
  ok(r.status === 409 && r.body.error === "resume_first", "switch while cancellation is scheduled → 409 resume_first");
  r = await deliver(evt("customer.subscription.updated", { id: activeSub.id, object: "subscription" }));
  ok(r.status === 200 && one(`select cancel_at_period_end from public.subscriptions where provider_subscription_id='${activeSub.id}'`) === "t", "the matching webhook re-applies the same state");
  r = await subscriptionAction({ userId: U.buyer, action: "resume" }, deps);
  ok(r.status === 200 && r.body.changed === true && r.body.cancel_at_period_end === false
     && one(`select cancel_at_period_end from public.subscriptions where provider_subscription_id='${activeSub.id}'`) === "f", "resume → auto-renew back on");

  console.log("A2 safety: ownership, ended subscriptions, past_due, rate limit");
  const live = S.subs.get(activeSub.id);
  live.customer = "cus_someone_else";
  S.calls.length = 0;
  r = await subscriptionAction({ userId: U.buyer, action: "cancel" }, deps);
  ok(r.status === 403 && !S.calls.some((c) => c[0] === "subscriptions.update"), "Stripe subscription not owned by the member's customer → 403, nothing changed");
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "premium" }, deps);
  ok(r.status === 403, "same check for plan switch");
  live.customer = cusBuyer; live.status = "past_due";
  await deliver(evt("customer.subscription.updated", { id: activeSub.id, object: "subscription" }));
  r = await createPortal({ userId: U.buyer, flow: "switch", targetPlan: "premium" }, deps);
  ok(r.status === 409 && r.body.error === "not_switchable", "past_due → no plan switch (pay the open invoice first)");
  live.status = "canceled"; live.ended_at = now();        // ended in Stripe, our row still says past_due
  r = await subscriptionAction({ userId: U.buyer, action: "resume" }, deps);
  ok(r.status === 409 && r.body.error === "subscription_ended", "ended in Stripe → 409");
  ok(one(`select status from public.subscriptions where provider_subscription_id='${activeSub.id}'`) === "canceled", "…and the stale DB row is synced");
  let lastA = 0;
  for (let i = 0; i < 12; i++) lastA = (await subscriptionAction({ userId: U.krw, action: "cancel" }, deps)).status;
  ok(lastA === 429, "more than 10 actions/hour → 429");
  let lastP = 0;
  for (let i = 0; i < 22; i++) lastP = (await createPortal({ userId: U.krw }, deps)).status;
  ok(lastP === 429, "more than 20 portal sessions/hour → 429");

  console.log("M1 admin cancel (admin-actions): role from the DB, audited");
  const ac = (adminId: string, userId: string, mode = "period_end", reason = "chargeback dispute") => adminCancelSubscription({ adminId, userId, mode, reason }, deps);
  r = await ac(U.viewer, U.krw);
  ok(r.status === 403 && r.body.error === "forbidden", "viewer → 403");
  r = await ac(U.buyer, U.krw);
  ok(r.status === 403, "ordinary member → 403");
  r = await ac(U.admin, U.krw, "later");
  ok(r.status === 400, "bad mode → 400");
  r = await ac(U.admin, U.krw, "now", "x");
  ok(r.status === 400 && r.body.error === "reason_required", "reason required");
  r = await ac(U.admin, U.admin);
  ok(r.status === 403 && r.body.error === "cannot_act_on_self", "not on self");
  r = await ac(U.admin, U.viewer);
  ok(r.status === 403 && r.body.error === "only_owner_can_change_admins", "admin cannot act on another admin");
  r = await ac(U.admin, U.krw);
  ok(r.status === 404 && r.body.error === "no_subscription", "no subscription → 404");
  const cusKrw = one(`select provider_customer_id from public.billing_customers where user_id='${U.krw}'`);
  const krwPrice = one(`select provider_price_id from public.plan_prices where active and plan_id='premium' and billing_interval='year' and currency='KRW'`);
  const krwSub = makeSub(cusKrw, krwPrice, "active", { metadata: { user_id: U.krw } });
  await deliver(evt("customer.subscription.created", { id: krwSub.id, object: "subscription" }));
  ok(plan(U.krw) !== "free", "KRW member subscribed");
  S.calls.length = 0;
  const auditBefore = Number(one(`select count(*) from public.admin_audit_logs where target_user_id='${U.krw}'`));
  r = await ac(U.admin, U.krw);
  const upd = S.calls.find((c) => c[0] === "subscriptions.update");
  ok(r.status === 200 && r.body.cancel_at_period_end === true && upd && upd[2].cancel_at_period_end === true && /^admin: chargeback/.test(upd[2].cancellation_details.comment),
     "period_end → Stripe cancel_at_period_end + admin comment");
  ok(one(`select cancel_at_period_end from public.subscriptions where provider_subscription_id='${krwSub.id}'`) === "t" && plan(U.krw) !== "free", "DB updated, access until period end");
  ok(one(`select action||'|'||admin_id||'|'||reason||'|'||(before->>'cancel_at_period_end')||'|'||(after->>'cancel_at_period_end') from public.admin_audit_logs where target_user_id='${U.krw}' order by id desc limit 1`)
     === `subscription.cancel|${U.admin}|chargeback dispute|false|true`, "audit row: who, what, before/after, reason");
  r = await ac(U.admin, U.krw, "now", "fraud confirmed");
  ok(r.status === 200 && S.calls.some((c) => c[0] === "subscriptions.cancel") && r.body.status === "canceled", "now → Stripe cancel immediately");
  ok(one(`select status from public.subscriptions where provider_subscription_id='${krwSub.id}'`) === "canceled" && plan(U.krw) === "free", "canceled → Free");
  ok(Number(one(`select count(*) from public.admin_audit_logs where target_user_id='${U.krw}'`)) === auditBefore + 2, "both actions audited");
  sql(`update public.profiles set suspended_at = now() where user_id = '${U.admin}'`);
  r = await ac(U.admin, U.krw);
  ok(r.status === 403, "suspended admin → 403");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
