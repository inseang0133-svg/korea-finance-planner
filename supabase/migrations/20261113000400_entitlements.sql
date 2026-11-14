-- =====================================================================
-- Korea Finance Planner · migration 4 · Entitlements (Phase 5)
--   * subscriptions (provider-neutral core; Phase 6 adds prices/payments)
--   * plan resolution done ONLY in the database:
--       kfp_effective_plan(uid) / get_my_entitlements() / has_feature(key)
--   * server-side enforcement:
--       - Cloud Sync writes to user_data require feature "cloud_sync"
--       - gold keys inside user_data can only be changed with "gold_portfolio"
--         (Phase 9 moves gold to its own table)
-- Additive & re-runnable. Never deletes data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. subscriptions — written only by the payment webhook (service_role)
-- ---------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  provider                 text not null default 'stripe',          -- stripe | portone | toss | omise | manual
  provider_customer_id     text,
  provider_subscription_id text,
  plan_id                  text not null references public.plans(id),
  billing_interval         text check (billing_interval in ('month','year')),
  currency                 text,                                    -- 'THB' | 'KRW'
  status                   text not null check (status in
                             ('trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')),
  cancel_at_period_end     boolean not null default false,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  trial_end                timestamptz,
  canceled_at              timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index if not exists subscriptions_provider_sub_uidx
  on public.subscriptions (provider, provider_subscription_id) where provider_subscription_id is not null;
create index if not exists subscriptions_user_idx   on public.subscriptions (user_id);
create index if not exists subscriptions_status_idx on public.subscriptions (status, current_period_end);

alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions for select
  to authenticated using (auth.uid() = user_id);
revoke insert, update, delete on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
grant select, insert, update, delete on public.subscriptions to service_role;

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at before update on public.subscriptions
for each row execute procedure public.touch_kfp_updated_at();

-- ---------------------------------------------------------------------
-- 2. Effective plan (internal; not callable from the browser)
--    Highest plan (plans.sort) among:
--      a) subscriptions: active / trialing until current_period_end
--         (cancel_at_period_end keeps access until the period ends)
--         past_due: grace = plans.limits.grace_days counted from
--         current_period_start (Stripe starts the new period when the
--         renewal invoice fails, so the end date is a month away)
--         unpaid / canceled / incomplete* / paused: no access
--      b) user_entitlements: admin grants / legacy launch grant
--    Nothing valid → 'free'. Suspended accounts → 'free'.
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
    where p.active
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

create or replace function public.kfp_has_feature(p_uid uuid, p_key text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((p.features ->> p_key)::boolean, false)
  from public.kfp_effective_plan(p_uid) e
  join public.plans p on p.id = e.plan_id
$$;
revoke all on function public.kfp_has_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.kfp_has_feature(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 3. Browser-facing: only ever about the CALLER (auth.uid())
-- ---------------------------------------------------------------------
create or replace function public.has_feature(p_key text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then false else public.kfp_has_feature(auth.uid(), p_key) end
$$;
revoke all on function public.has_feature(text) from public, anon;
grant execute on function public.has_feature(text) to authenticated, service_role;

create or replace function public.get_my_entitlements()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else (
    select jsonb_build_object(
      'user_id',     auth.uid(),
      'plan',        p.id,
      'plan_name',   p.name,
      'source',      e.source,
      'status',      e.status,
      'valid_until', e.valid_until,
      'features',    p.features,
      'limits',      p.limits,
      'checked_at',  now())
    from public.kfp_effective_plan(auth.uid()) e
    join public.plans p on p.id = e.plan_id
  ) end
$$;
revoke all on function public.get_my_entitlements() from public, anon;
grant execute on function public.get_my_entitlements() to authenticated;

-- ---------------------------------------------------------------------
-- 4. user_data: Cloud Sync writes need "cloud_sync".
--    Reading your own row stays allowed for everyone (download / export
--    your data after a downgrade). Original policy names are kept.
-- ---------------------------------------------------------------------
drop policy if exists "user_data_insert_own" on public.user_data;
create policy "user_data_insert_own"
on public.user_data for insert
to authenticated
with check (auth.uid() = user_id and public.has_feature('cloud_sync'));

drop policy if exists "user_data_update_own" on public.user_data;
create policy "user_data_update_own"
on public.user_data for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id and public.has_feature('cloud_sync'));

-- Gold keys inside the snapshot: without "gold_portfolio" a write can
-- neither add nor change nor remove them (the stored values are kept).
create or replace function public.kfp_protect_gold_keys()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  gold_keys text[] := array['kfp_gold_lots_v1', 'kfp_gold_settings_v1'];
  kept jsonb := '{}'::jsonb;
begin
  -- Edge Functions (service_role) and migrations (table owner) are trusted.
  if coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  if public.has_feature('gold_portfolio') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.data is not null then
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into kept
    from jsonb_each(old.data) where key = any (gold_keys);
  end if;
  new.data := (coalesce(new.data, '{}'::jsonb) - gold_keys) || kept;
  return new;
end;
$$;

drop trigger if exists user_data_protect_gold on public.user_data;
create trigger user_data_protect_gold
before insert or update on public.user_data
for each row execute procedure public.kfp_protect_gold_keys();
