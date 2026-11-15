-- =====================================================================
-- Korea Finance Planner · country at sign-up, add-ons, monthly digest (15/11/2026)
--
-- 1. Sign-up stores the chosen country (TH / KR) on the profile.
-- 2. New feature "monthly_digest" (monthly summary pop-ups): Finance Premium only.
-- 3. Add-ons: rows in public.plans with kind = 'addon'. A member (Free or Plus) can
--    subscribe to any add-on separately (own Stripe subscription, monthly).
--    • kfp_effective_plan / kfp_effective_plans_all only rank real plans (kind = 'plan')
--    • kfp_active_addons(uid)       live add-ons of a member
--    • kfp_entitlement_bundle(uid)  plan + add-ons merged (features OR-ed, add-on limits win)
--    • has_feature / get_my_entitlements use the merged bundle
--    • kfp_checkout_context knows plan vs add-on; get_my_billing lists add-ons
--    THB prices are created here; KRW prices are set later from the admin console.
-- Additive, re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. country from sign-up metadata
-- ---------------------------------------------------------------------
create or replace function public.handle_new_kfp_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base  text;
  uname text;
  nick  text;
  cty   text;
  n     int := 0;
begin
  base := public.kfp_normalize_username(
            coalesce(nullif(new.raw_user_meta_data->>'username', ''),
                     split_part(coalesce(new.email, ''), '@', 1)));
  base := left(base, 32);
  if length(base) < 3 then base := 'user'; end if;

  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    n := n + 1;
    uname := left(base, 25) || '-' || substr(replace(new.id::text, '-', ''), n, 6);
    exit when n > 20;
  end loop;

  nick := left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), uname), 60);
  cty  := upper(coalesce(new.raw_user_meta_data->>'country', ''));
  if cty not in ('TH', 'KR') then cty := null; end if;

  insert into public.profiles (user_id, username, nickname, email, is_legacy_email, email_verified_at, last_login_at, country)
  values (new.id, uname, nick, new.email,
          coalesce(new.email, '') ilike '%@kfp.example.com',
          new.email_confirmed_at, new.last_sign_in_at, cty)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2 + 3. plans: kind, monthly_digest, add-ons
-- ---------------------------------------------------------------------
alter table public.plans add column if not exists kind text not null default 'plan';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'plans_kind_check') then
    alter table public.plans add constraint plans_kind_check check (kind in ('plan', 'addon'));
  end if;
end $$;

update public.plans set features = features || jsonb_build_object('monthly_digest', id = 'premium')
where id in ('free', 'plus', 'premium');

insert into public.plans (id, name, description, features, limits, sort, kind) values
  ('addon_salary',   'บันทึกเงินเดือนไม่จำกัด + สถิติ', 'บันทึกเงินเดือนรายเดือนไม่จำกัด · สถิติการเงิน + กราฟ · Export Excel',
     '{"salary_history":true,"advanced_statistics":true,"export":true}', '{"salary_records_max":null}', 101, 'addon'),
  ('addon_expense',  'รายจ่ายไม่จำกัด',                 'บันทึกรายจ่าย วอน/บาท ไม่จำกัด (ไม่รวมแจ้งเตือนสรุปรายเดือน)',
     '{"expenses":true}', '{"expense_items_max":null}', 102, 'addon'),
  ('addon_work',     'บันทึกการเข้างาน',                'บันทึกการเข้างาน + สรุปรายได้ OT (ไม่รวมแจ้งเตือนสรุปรายเดือน)',
     '{"work_records":true}', '{}', 103, 'addon'),
  ('addon_planning', 'สัญญาจ้าง + เป้าหมายเงินเก็บ',    'สัญญาจ้างเกาหลี + เป้าหมายเงินเก็บ',
     '{"planning":true}', '{}', 104, 'addon'),
  ('addon_cloud',    'Cloud Sync ข้ามเครื่อง',           'ซิงก์ข้อมูลข้ามเครื่องผ่าน Cloud',
     '{"cloud_sync":true}', '{}', 105, 'addon'),
  ('addon_gold',     'พอร์ตทอง',                       'พอร์ตทอง: ต้นทุน กำไร/ขาดทุน ราคาเรียลไทม์',
     '{"gold_portfolio":true}', '{}', 106, 'addon')
on conflict (id) do update set kind = 'addon', name = excluded.name, description = excluded.description,
  features = excluded.features, limits = excluded.limits, sort = excluded.sort;

-- THB monthly prices (satang). KRW: set later in the admin console.
insert into public.plan_prices (plan_id, billing_interval, currency, amount_minor)
select v.plan_id, 'month', 'THB', v.amount
from (values ('addon_salary', 5900::bigint), ('addon_expense', 5900::bigint), ('addon_work', 6900::bigint),
             ('addon_planning', 4900::bigint), ('addon_cloud', 6900::bigint), ('addon_gold', 6900::bigint)) v(plan_id, amount)
where not exists (select 1 from public.plan_prices pp where pp.plan_id = v.plan_id and pp.billing_interval = 'month'
                    and pp.currency = 'THB' and pp.provider = 'stripe' and pp.active);

-- ---------------------------------------------------------------------
-- effective PLAN: real plans only (an add-on never becomes "the plan")
-- ---------------------------------------------------------------------
create or replace function public.kfp_effective_plan(p_uid uuid)
returns table (plan_id text, source text, status text, valid_until timestamptz)
language sql stable security definer
set search_path = public
as $$
  with cand as (
    select s.plan_id, ('subscription:' || s.provider)::text as source, s.status,
           case when s.status = 'past_due'
                then s.current_period_start + make_interval(days => coalesce((p.limits->>'grace_days')::int, 0))
                else s.current_period_end end as valid_until
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.user_id = p_uid
      and (
        (s.status in ('active','trialing') and (s.current_period_end is null or s.current_period_end > now()))
        or (s.status = 'past_due' and s.current_period_start is not null
            and now() < s.current_period_start + make_interval(days => coalesce((p.limits->>'grace_days')::int, 0)))
      )
    union all
    select e.plan_id, e.reason, 'granted', e.expires_at
    from public.user_entitlements e
    where e.user_id = p_uid and e.revoked_at is null
      and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
  ),
  best as (
    select c.* from cand c join public.plans p on p.id = c.plan_id
    where p.active and p.kind = 'plan'
      and not exists (select 1 from public.profiles pr where pr.user_id = p_uid and pr.suspended_at is not null)
    order by p.sort desc, c.valid_until desc nulls first
    limit 1
  )
  select * from best
  union all
  select 'free', case when exists (select 1 from public.profiles pr where pr.user_id = p_uid and pr.suspended_at is not null)
                      then 'suspended' else 'default' end, 'none', null
  where not exists (select 1 from best)
$$;
revoke all on function public.kfp_effective_plan(uuid) from public, anon, authenticated;
grant execute on function public.kfp_effective_plan(uuid) to service_role;

create or replace function public.kfp_effective_plans_all()
returns table (user_id uuid, plan_id text, source text, status text, valid_until timestamptz)
language sql stable security definer
set search_path = public
as $$
  with cand as (
    select s.user_id, s.plan_id, ('subscription:' || s.provider)::text as source, s.status,
           case when s.status = 'past_due'
                then s.current_period_start + make_interval(days => coalesce((p.limits->>'grace_days')::int, 0))
                else s.current_period_end end as valid_until
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    where (s.status in ('active','trialing') and (s.current_period_end is null or s.current_period_end > now()))
       or (s.status = 'past_due' and s.current_period_start is not null
           and now() < s.current_period_start + make_interval(days => coalesce((p.limits->>'grace_days')::int, 0)))
    union all
    select e.user_id, e.plan_id, e.reason, 'granted', e.expires_at
    from public.user_entitlements e
    where e.revoked_at is null and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
  ),
  ranked as (
    select c.*, row_number() over (partition by c.user_id order by p.sort desc, c.valid_until desc nulls first) as rn
    from cand c join public.plans p on p.id = c.plan_id
    where p.active and p.kind = 'plan'
  )
  select u.id,
         case when pr.suspended_at is not null or r.user_id is null then 'free' else r.plan_id end,
         case when pr.suspended_at is not null then 'suspended' when r.user_id is null then 'default' else r.source end,
         case when pr.suspended_at is not null or r.user_id is null then 'none' else r.status end,
         case when pr.suspended_at is not null then null else r.valid_until end
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  left join ranked r on r.user_id = u.id and r.rn = 1
$$;
revoke all on function public.kfp_effective_plans_all() from public, anon, authenticated;

-- live add-ons of a member (same validity rules as plans; none while suspended)
create or replace function public.kfp_active_addons(p_uid uuid)
returns table (addon_id text, source text, status text, valid_until timestamptz, cancel_at_period_end boolean)
language sql stable security definer
set search_path = public
as $$
  select distinct on (c.plan_id) c.plan_id, c.source, c.status, c.valid_until, c.cape
  from (
    select s.plan_id, ('subscription:' || s.provider)::text as source, s.status, s.cancel_at_period_end as cape,
           case when s.status = 'past_due'
                then s.current_period_start + make_interval(days => 7)
                else s.current_period_end end as valid_until
    from public.subscriptions s
    where s.user_id = p_uid
      and ((s.status in ('active','trialing') and (s.current_period_end is null or s.current_period_end > now()))
        or (s.status = 'past_due' and s.current_period_start is not null and now() < s.current_period_start + interval '7 days'))
    union all
    select e.plan_id, e.reason, 'granted', false, e.expires_at
    from public.user_entitlements e
    where e.user_id = p_uid and e.revoked_at is null and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
  ) c
  join public.plans p on p.id = c.plan_id
  where p.active and p.kind = 'addon'
    and not exists (select 1 from public.profiles pr where pr.user_id = p_uid and pr.suspended_at is not null)
  order by c.plan_id, c.valid_until desc nulls first
$$;
revoke all on function public.kfp_active_addons(uuid) from public, anon, authenticated;
grant execute on function public.kfp_active_addons(uuid) to service_role;

-- plan + add-ons merged: features are OR-ed, an add-on's limits replace the plan's (null = unlimited)
create or replace function public.kfp_entitlement_bundle(p_uid uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  e record; pl public.plans; a record;
  f jsonb; l jsonb; list jsonb := '[]'::jsonb;
begin
  select * into e from public.kfp_effective_plan(p_uid) limit 1;
  select * into pl from public.plans where id = coalesce(e.plan_id, 'free');
  f := coalesce(pl.features, '{}'::jsonb); l := coalesce(pl.limits, '{}'::jsonb);
  for a in
    select x.addon_id, x.status, x.valid_until, x.cancel_at_period_end, p.name, p.features, p.limits
    from public.kfp_active_addons(p_uid) x join public.plans p on p.id = x.addon_id
    order by p.sort
  loop
    f := f || coalesce((select jsonb_object_agg(j.key, true) from jsonb_each(a.features) j where j.value = 'true'::jsonb), '{}'::jsonb);
    l := l || coalesce(a.limits, '{}'::jsonb);
    list := list || jsonb_build_array(jsonb_build_object('id', a.addon_id, 'name', a.name, 'status', a.status,
                                                         'valid_until', a.valid_until, 'cancel_at_period_end', a.cancel_at_period_end));
  end loop;
  return jsonb_build_object('plan', pl.id, 'plan_name', pl.name, 'source', e.source, 'status', e.status,
                            'valid_until', e.valid_until, 'features', f, 'limits', l, 'plan_features', pl.features, 'addons', list);
end;
$$;
revoke all on function public.kfp_entitlement_bundle(uuid) from public, anon, authenticated;
grant execute on function public.kfp_entitlement_bundle(uuid) to service_role;

create or replace function public.kfp_has_feature(p_uid uuid, p_key text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((public.kfp_entitlement_bundle(p_uid)->'features'->>p_key)::boolean, false)
$$;
revoke all on function public.kfp_has_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.kfp_has_feature(uuid, text) to service_role;

create or replace function public.get_my_entitlements()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else (
    select jsonb_build_object(
      'user_id',     auth.uid(),
      'plan',        b->>'plan',
      'plan_name',   b->>'plan_name',
      'source',      b->>'source',
      'status',      b->>'status',
      'valid_until', b->'valid_until',
      'features',    b->'features',
      'limits',      b->'limits',
      'plan_features', b->'plan_features',
      'addons',      b->'addons',
      'admin_role',  public.kfp_admin_role(auth.uid()),
      'checked_at',  now())
    from (select public.kfp_entitlement_bundle(auth.uid()) as b) x
  ) end
$$;
revoke all on function public.get_my_entitlements() from public, anon;
grant execute on function public.get_my_entitlements() to authenticated;

-- ---------------------------------------------------------------------
-- checkout / billing context: plan vs add-on
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
    'kind',        (select pl.kind from public.plans pl where pl.id = p->>'plan' and pl.active),
    'price',       (select to_jsonb(pp) from public.plan_prices pp
                    where pp.active and pp.provider = 'stripe'
                      and pp.plan_id = p->>'plan' and pp.billing_interval = p->>'interval' and pp.currency = upper(p->>'currency')),
    'customer_id', (select bc.provider_customer_id from public.billing_customers bc
                    where bc.user_id = u.id and bc.provider = 'stripe'),
    -- the member's PLAN subscription (add-ons are separate)
    'active_subscription', (select jsonb_build_object(
                        'id', s.provider_subscription_id, 'plan', s.plan_id, 'status', s.status,
                        'cancel_at_period_end', s.cancel_at_period_end, 'billing_interval', s.billing_interval,
                        'currency', s.currency, 'current_period_end', s.current_period_end)
                    from public.subscriptions s join public.plans pl on pl.id = s.plan_id and pl.kind = 'plan'
                    where s.user_id = u.id and s.provider = 'stripe'
                      and s.status in ('active', 'trialing', 'past_due', 'unpaid')
                    order by s.created_at desc limit 1),
    -- live subscription of the requested add-on
    'active_addon', (select jsonb_build_object(
                        'id', s.provider_subscription_id, 'plan', s.plan_id, 'status', s.status,
                        'cancel_at_period_end', s.cancel_at_period_end, 'billing_interval', s.billing_interval,
                        'currency', s.currency, 'current_period_end', s.current_period_end)
                    from public.subscriptions s join public.plans pl on pl.id = s.plan_id and pl.kind = 'addon'
                    where s.user_id = u.id and s.provider = 'stripe' and s.plan_id = p->>'plan'
                      and s.status in ('active', 'trialing', 'past_due', 'unpaid')
                    order by s.created_at desc limit 1),
    -- the member's plan already gives everything the add-on gives (its features, and no limit where the add-on lifts one)
    'addon_included', (select coalesce((select bool_and(coalesce((bp.features->>j.key)::boolean, false))
                                        from jsonb_each(ap.features) j where j.value = 'true'::jsonb), true)
                          and coalesce((select bool_and(bp.limits->l.key is null or bp.limits->l.key = 'null'::jsonb)
                                        from jsonb_each(ap.limits) l), true)
                       from public.plans ap
                       cross join lateral (select pl2.features, pl2.limits from public.kfp_effective_plan(u.id) ep
                                           join public.plans pl2 on pl2.id = ep.plan_id) bp
                       where ap.id = p->>'plan' and ap.kind = 'addon'))
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  where u.id = (p->>'user_id')::uuid
$$;
revoke all on function public.kfp_checkout_context(jsonb) from public, anon, authenticated;
grant execute on function public.kfp_checkout_context(jsonb) to service_role;

create or replace function public.get_my_billing()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'entitlements', public.get_my_entitlements(),
    -- current PLAN subscription first (active/trialing/past_due/unpaid), else the most recent one
    'subscription', (
      select jsonb_build_object(
        'plan_id', s.plan_id, 'plan_name', pl.name, 'status', s.status,
        'billing_interval', s.billing_interval, 'currency', s.currency, 'unit_amount_minor', s.unit_amount_minor,
        'cancel_at_period_end', s.cancel_at_period_end, 'started_at', s.created_at,
        'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
        'trial_end', s.trial_end, 'canceled_at', s.canceled_at, 'ended_at', s.ended_at, 'provider', s.provider)
      from public.subscriptions s join public.plans pl on pl.id = s.plan_id and pl.kind = 'plan'
      where s.user_id = auth.uid()
      order by (s.status in ('active', 'trialing', 'past_due', 'unpaid')) desc, s.created_at desc
      limit 1),
    -- add-on subscriptions that are live or ended in the last 60 days
    'addons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_id', s.plan_id, 'plan_name', pl.name, 'status', s.status, 'currency', s.currency,
        'unit_amount_minor', s.unit_amount_minor, 'cancel_at_period_end', s.cancel_at_period_end,
        'current_period_end', s.current_period_end, 'started_at', s.created_at, 'ended_at', s.ended_at)
        order by pl.sort)
      from public.subscriptions s join public.plans pl on pl.id = s.plan_id and pl.kind = 'addon'
      where s.user_id = auth.uid()
        and (s.status in ('active', 'trialing', 'past_due', 'unpaid') or coalesce(s.ended_at, s.updated_at) > now() - interval '60 days')), '[]'::jsonb),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object('plan_id', e.plan_id, 'reason', e.reason, 'starts_at', e.starts_at, 'expires_at', e.expires_at)
                       order by e.expires_at nulls last)
      from public.user_entitlements e
      where e.user_id = auth.uid() and e.revoked_at is null and (e.expires_at is null or e.expires_at > now())), '[]'::jsonb),
    'has_customer', exists (select 1 from public.billing_customers b where b.user_id = auth.uid()),
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
