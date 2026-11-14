-- =====================================================================
-- Korea Finance Planner · migration 7 · Member billing page (Phase 8)
--   get_my_billing()      one call for account.html (only the caller's data)
--   kfp_checkout_context  + subscription details needed for cancel / resume / switch
-- Additive & re-runnable.
-- =====================================================================

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
    'active_subscription', (select jsonb_build_object(
                        'id', s.provider_subscription_id, 'plan', s.plan_id, 'status', s.status,
                        'cancel_at_period_end', s.cancel_at_period_end, 'billing_interval', s.billing_interval,
                        'currency', s.currency, 'current_period_end', s.current_period_end)
                    from public.subscriptions s
                    where s.user_id = u.id and s.provider = 'stripe'
                      and s.status in ('active', 'trialing', 'past_due', 'unpaid')
                    order by s.created_at desc limit 1))
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  where u.id = (p->>'user_id')::uuid
$$;
revoke all on function public.kfp_checkout_context(jsonb) from public, anon, authenticated;
grant execute on function public.kfp_checkout_context(jsonb) to service_role;

-- Everything account.html shows, for the CALLER only.
create or replace function public.get_my_billing()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'entitlements', public.get_my_entitlements(),
    -- current subscription first (active/trialing/past_due/unpaid), else the most recent one
    'subscription', (
      select jsonb_build_object(
        'plan_id', s.plan_id, 'plan_name', pl.name, 'status', s.status,
        'billing_interval', s.billing_interval, 'currency', s.currency, 'unit_amount_minor', s.unit_amount_minor,
        'cancel_at_period_end', s.cancel_at_period_end, 'started_at', s.created_at,
        'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
        'trial_end', s.trial_end, 'canceled_at', s.canceled_at, 'ended_at', s.ended_at, 'provider', s.provider)
      from public.subscriptions s join public.plans pl on pl.id = s.plan_id
      where s.user_id = auth.uid()
      order by (s.status in ('active', 'trialing', 'past_due', 'unpaid')) desc, s.created_at desc
      limit 1),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object('plan_id', e.plan_id, 'reason', e.reason, 'starts_at', e.starts_at, 'expires_at', e.expires_at)
                       order by e.expires_at nulls last)
      from public.user_entitlements e
      where e.user_id = auth.uid() and e.revoked_at is null and (e.expires_at is null or e.expires_at > now())), '[]'::jsonb),
    'has_customer', exists (select 1 from public.billing_customers b where b.user_id = auth.uid()),
    -- unpaid invoice the member can pay right now (Stripe hosted page)
    'open_invoice', (
      select jsonb_build_object('hosted_invoice_url', pm.hosted_invoice_url, 'amount_due_minor', pm.amount_due_minor,
                                'currency', pm.currency, 'status', pm.status, 'failure_reason', pm.failure_reason, 'created_at', pm.created_at)
      from public.payments pm
      where pm.user_id = auth.uid() and pm.status in ('failed', 'action_required', 'open') and pm.hosted_invoice_url is not null
      order by pm.created_at desc limit 1),
    'payments_total', (select count(*) from public.payments pm where pm.user_id = auth.uid())
  ) end
$$;
revoke all on function public.get_my_billing() from public, anon;
grant execute on function public.get_my_billing() to authenticated;
