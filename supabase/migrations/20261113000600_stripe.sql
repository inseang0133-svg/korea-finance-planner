-- =====================================================================
-- Korea Finance Planner · migration 6 · Stripe sync functions (Phase 7)
-- All functions take/return jsonb and are callable by service_role ONLY
-- (the Edge Functions). The browser can never write billing state.
-- Edge Functions always re-fetch objects from Stripe before calling these,
-- so event order does not matter; every function is idempotent (upserts).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Checkout context: everything create-checkout needs in one round trip
-- ---------------------------------------------------------------------
create or replace function public.kfp_checkout_context(p jsonb)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id',     u.id,
    'email',       u.email,
    'verified',    u.email_confirmed_at is not null,
    'legacy',      coalesce(u.email, '') ilike '%@kfp.example.com',
    'suspended',   coalesce(pr.suspended_at is not null, false),
    'price',       (select to_jsonb(pp) from public.plan_prices pp
                    where pp.active and pp.provider = 'stripe'
                      and pp.plan_id = p->>'plan' and pp.billing_interval = p->>'interval' and pp.currency = upper(p->>'currency')),
    'customer_id', (select bc.provider_customer_id from public.billing_customers bc
                    where bc.user_id = u.id and bc.provider = 'stripe'),
    'active_subscription', (select jsonb_build_object('id', s.provider_subscription_id, 'plan', s.plan_id, 'status', s.status)
                    from public.subscriptions s
                    where s.user_id = u.id and s.provider = 'stripe'
                      and s.status in ('active', 'trialing', 'past_due', 'unpaid')
                    order by s.created_at desc limit 1))
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  where u.id = (p->>'user_id')::uuid
$$;

-- Remember the Stripe Price created for a plan_prices row (first writer wins).
create or replace function public.kfp_set_price_provider_id(p jsonb)
returns text
language plpgsql security definer
set search_path = public
as $$
declare v text;
begin
  update public.plan_prices set provider_price_id = p->>'provider_price_id'
  where id = (p->>'price_id')::uuid and provider_price_id is null;
  select provider_price_id into v from public.plan_prices where id = (p->>'price_id')::uuid;
  return v;
end;
$$;

create or replace function public.kfp_upsert_billing_customer(p jsonb)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.billing_customers (user_id, provider, provider_customer_id, email)
  values ((p->>'user_id')::uuid, coalesce(p->>'provider', 'stripe'), p->>'customer_id', p->>'email')
  on conflict (user_id, provider) do update
    set provider_customer_id = excluded.provider_customer_id, email = coalesce(excluded.email, billing_customers.email)
$$;

-- user for a Stripe customer: explicit metadata first, then our mapping table
create or replace function public.kfp_user_for_customer(p_provider text, p_customer text, p_hint uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select id from auth.users where id = p_hint),
    (select user_id from public.billing_customers where provider = p_provider and provider_customer_id = p_customer))
$$;

-- ---------------------------------------------------------------------
-- Subscription (checkout.session.completed, customer.subscription.*)
-- p: provider, provider_subscription_id, provider_customer_id, user_id?,
--    price_provider_id, plan_hint?, billing_interval, currency, status,
--    cancel_at_period_end, current_period_start/end, trial_end, canceled_at,
--    ended_at, unit_amount_minor, latest_invoice_id
-- ---------------------------------------------------------------------
create or replace function public.kfp_apply_subscription(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_provider text := coalesce(p->>'provider', 'stripe');
  v_user  uuid;
  v_price public.plan_prices;
  v_plan  text;
  v_id    uuid;
begin
  v_user := public.kfp_user_for_customer(v_provider, p->>'provider_customer_id', nullif(p->>'user_id', '')::uuid);
  if v_user is null then
    raise exception 'unknown customer %', p->>'provider_customer_id' using errcode = 'P0002';
  end if;
  if p->>'provider_customer_id' is not null then
    perform public.kfp_upsert_billing_customer(jsonb_build_object('user_id', v_user, 'provider', v_provider, 'customer_id', p->>'provider_customer_id'));
  end if;

  select * into v_price from public.plan_prices where provider = v_provider and provider_price_id = p->>'price_provider_id';
  v_plan := coalesce(v_price.plan_id, nullif(p->>'plan_hint', ''));
  if v_plan is null or not exists (select 1 from public.plans where id = v_plan) or v_plan = 'free' then
    raise exception 'cannot map price % to a plan', p->>'price_provider_id' using errcode = 'P0002';
  end if;

  insert into public.subscriptions as s (
    user_id, provider, provider_customer_id, provider_subscription_id, plan_id, price_id, billing_interval, currency,
    status, cancel_at_period_end, current_period_start, current_period_end, trial_end, canceled_at, ended_at,
    unit_amount_minor, latest_invoice_id)
  values (
    v_user, v_provider, p->>'provider_customer_id', p->>'provider_subscription_id', v_plan, v_price.id,
    p->>'billing_interval', upper(p->>'currency'), p->>'status', coalesce((p->>'cancel_at_period_end')::boolean, false),
    (p->>'current_period_start')::timestamptz, (p->>'current_period_end')::timestamptz, (p->>'trial_end')::timestamptz,
    (p->>'canceled_at')::timestamptz, (p->>'ended_at')::timestamptz, (p->>'unit_amount_minor')::bigint, p->>'latest_invoice_id')
  on conflict (provider, provider_subscription_id) where provider_subscription_id is not null do update set
    user_id = excluded.user_id, provider_customer_id = excluded.provider_customer_id, plan_id = excluded.plan_id,
    price_id = excluded.price_id, billing_interval = excluded.billing_interval, currency = excluded.currency,
    status = excluded.status, cancel_at_period_end = excluded.cancel_at_period_end,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    trial_end = excluded.trial_end, canceled_at = excluded.canceled_at, ended_at = excluded.ended_at,
    unit_amount_minor = excluded.unit_amount_minor, latest_invoice_id = coalesce(excluded.latest_invoice_id, s.latest_invoice_id)
  returning id into v_id;

  return jsonb_build_object('subscription_id', v_id, 'user_id', v_user, 'plan_id', v_plan, 'status', p->>'status');
end;
$$;

-- ---------------------------------------------------------------------
-- Invoice / payment (invoice.paid, invoice.payment_failed, invoice.payment_action_required)
-- p: provider, provider_invoice_id, provider_customer_id, user_id?, provider_subscription_id,
--    provider_payment_intent_id, provider_charge_id, price_provider_id, billing_interval,
--    currency, amount_due_minor, amount_paid_minor, status, failure_reason,
--    period_start, period_end, hosted_invoice_url, invoice_pdf_url, paid_at
-- A paid invoice is never downgraded by a late "failed" event, and refunds stay.
-- ---------------------------------------------------------------------
create or replace function public.kfp_apply_invoice(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_provider text := coalesce(p->>'provider', 'stripe');
  v_user uuid;
  v_sub  uuid;
  v_plan text;
  v_old  public.payments;
  v_status text := p->>'status';
  v_id uuid;
begin
  v_user := public.kfp_user_for_customer(v_provider, p->>'provider_customer_id', nullif(p->>'user_id', '')::uuid);
  if v_user is null then
    raise exception 'unknown customer %', p->>'provider_customer_id' using errcode = 'P0002';
  end if;
  select id into v_sub from public.subscriptions where provider = v_provider and provider_subscription_id = p->>'provider_subscription_id';
  select plan_id into v_plan from public.plan_prices where provider = v_provider and provider_price_id = p->>'price_provider_id';
  select * into v_old from public.payments where provider = v_provider and provider_invoice_id = p->>'provider_invoice_id';

  if v_old.id is not null then
    if v_old.status in ('paid', 'refunded', 'partially_refunded') and v_status in ('open', 'failed', 'action_required', 'draft') then
      v_status := v_old.status;                       -- never un-pay an invoice
    elsif v_old.amount_refunded_minor > 0 and v_status = 'paid' then
      v_status := case when v_old.amount_refunded_minor >= v_old.amount_paid_minor then 'refunded' else 'partially_refunded' end;
    end if;
  end if;

  insert into public.payments as pay (
    user_id, subscription_id, provider, provider_invoice_id, provider_payment_intent_id, provider_charge_id,
    plan_id, billing_interval, currency, amount_due_minor, amount_paid_minor, status, failure_reason,
    period_start, period_end, hosted_invoice_url, invoice_pdf_url, paid_at)
  values (
    v_user, v_sub, v_provider, p->>'provider_invoice_id', p->>'provider_payment_intent_id', p->>'provider_charge_id',
    v_plan, p->>'billing_interval', upper(p->>'currency'), coalesce((p->>'amount_due_minor')::bigint, 0),
    coalesce((p->>'amount_paid_minor')::bigint, 0), v_status, p->>'failure_reason',
    (p->>'period_start')::timestamptz, (p->>'period_end')::timestamptz, p->>'hosted_invoice_url', p->>'invoice_pdf_url',
    (p->>'paid_at')::timestamptz)
  on conflict (provider, provider_invoice_id) where provider_invoice_id is not null do update set
    user_id = excluded.user_id,
    subscription_id = coalesce(excluded.subscription_id, pay.subscription_id),
    provider_payment_intent_id = coalesce(excluded.provider_payment_intent_id, pay.provider_payment_intent_id),
    provider_charge_id = coalesce(excluded.provider_charge_id, pay.provider_charge_id),
    plan_id = coalesce(excluded.plan_id, pay.plan_id),
    billing_interval = coalesce(excluded.billing_interval, pay.billing_interval),
    amount_due_minor = excluded.amount_due_minor,
    amount_paid_minor = greatest(excluded.amount_paid_minor, pay.amount_paid_minor),
    status = v_status,
    failure_reason = case when v_status in ('failed', 'action_required') then excluded.failure_reason else pay.failure_reason end,
    period_start = coalesce(excluded.period_start, pay.period_start),
    period_end = coalesce(excluded.period_end, pay.period_end),
    hosted_invoice_url = coalesce(excluded.hosted_invoice_url, pay.hosted_invoice_url),
    invoice_pdf_url = coalesce(excluded.invoice_pdf_url, pay.invoice_pdf_url),
    paid_at = coalesce(pay.paid_at, excluded.paid_at)
  returning id into v_id;

  return jsonb_build_object('payment_id', v_id, 'user_id', v_user, 'status', v_status);
end;
$$;

-- ---------------------------------------------------------------------
-- Refunds (charge.refunded): p: provider, provider_charge_id, provider_payment_intent_id,
--   provider_invoice_id, amount_refunded_minor, currency, refunds: [{id, amount_minor, status, reason}]
-- ---------------------------------------------------------------------
create or replace function public.kfp_apply_refund(p jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_provider text := coalesce(p->>'provider', 'stripe');
  v_pay public.payments;
  r jsonb;
  v_ref bigint := coalesce((p->>'amount_refunded_minor')::bigint, 0);
begin
  select * into v_pay from public.payments
  where provider = v_provider and (
        (p->>'provider_invoice_id' is not null and provider_invoice_id = p->>'provider_invoice_id')
     or (p->>'provider_charge_id' is not null and provider_charge_id = p->>'provider_charge_id')
     or (p->>'provider_payment_intent_id' is not null and provider_payment_intent_id = p->>'provider_payment_intent_id'))
  order by created_at desc limit 1
  for update;
  if v_pay.id is null then
    raise exception 'payment for charge % not found', p->>'provider_charge_id' using errcode = 'P0002';
  end if;

  for r in select * from jsonb_array_elements(coalesce(p->'refunds', '[]'::jsonb)) loop
    insert into public.payment_refunds (payment_id, provider, provider_refund_id, amount_minor, currency, status, reason)
    values (v_pay.id, v_provider, r->>'id', (r->>'amount_minor')::bigint, upper(coalesce(p->>'currency', v_pay.currency)),
            coalesce(r->>'status', 'succeeded'), r->>'reason')
    on conflict (provider, provider_refund_id) where provider_refund_id is not null
    do update set payment_id = excluded.payment_id, status = excluded.status, amount_minor = excluded.amount_minor, reason = excluded.reason;
  end loop;

  v_ref := least(greatest(v_ref, 0), v_pay.amount_paid_minor);
  update public.payments set
    amount_refunded_minor = v_ref,
    provider_charge_id = coalesce(provider_charge_id, p->>'provider_charge_id'),
    status = case when v_ref <= 0 then status
                  when v_ref >= amount_paid_minor then 'refunded'
                  else 'partially_refunded' end
  where id = v_pay.id;
  return jsonb_build_object('payment_id', v_pay.id, 'amount_refunded_minor', v_ref);
end;
$$;

-- service_role only
do $$ declare f text; begin
  foreach f in array array[
    'kfp_checkout_context(jsonb)', 'kfp_set_price_provider_id(jsonb)', 'kfp_upsert_billing_customer(jsonb)',
    'kfp_user_for_customer(text, text, uuid)', 'kfp_apply_subscription(jsonb)', 'kfp_apply_invoice(jsonb)', 'kfp_apply_refund(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
