-- =====================================================================
-- Korea Finance Planner · migration 5 · Billing + Admin data model (Phase 6)
--   plan_prices          ราคาที่ admin แก้ได้ (THB/KRW × เดือน/ปี) เก็บประวัติราคาเก่า
--   billing_customers    user ↔ ลูกค้าใน payment provider
--   payments             การชำระเงิน / ใบแจ้งหนี้ (invoice) / สถานะคืนเงิน
--   payment_refunds      รายการคืนเงินแต่ละครั้ง
--   stripe_webhook_events  กันประมวลผล webhook ซ้ำ (idempotency)
--   user_activity        บันทึกการใช้งาน (throttle ฝั่ง DB)
--   admin_roles          สิทธิ์ผู้ดูแล (เพิ่มได้ด้วย SQL เท่านั้น)
--   admin_audit_logs     บันทึกทุกการกระทำของ admin (แก้/ลบไม่ได้)
-- Money is stored in the currency's MINOR unit (THB: satang ×100, KRW: won ×1,
-- KRW has no minor unit — same convention as Stripe "zero-decimal" currencies).
-- Additive & re-runnable. Never deletes data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------
create or replace function public.kfp_currency_exponent(p_currency text)
returns int language sql immutable as $$
  select case upper(p_currency) when 'KRW' then 0 when 'JPY' then 0 else 2 end
$$;

-- ---------------------------------------------------------------------
-- 1. admin_roles + is_admin()
--    No INSERT/UPDATE/DELETE grant for anon/authenticated → nobody can make
--    themselves admin through the API. First owner is added with SQL (SETUP.md).
-- ---------------------------------------------------------------------
create table if not exists public.admin_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'viewer')),
  granted_by uuid references auth.users(id) on delete set null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.admin_roles enable row level security;
revoke all on public.admin_roles from anon, authenticated;
grant select, insert, update, delete on public.admin_roles to service_role;
drop policy if exists admin_roles_select_self on public.admin_roles;
create policy admin_roles_select_self on public.admin_roles for select
  to authenticated using (auth.uid() = user_id);
grant select on public.admin_roles to authenticated;   -- RLS: own row only

-- true only for a direct database-owner session (Supabase SQL Editor / psql):
-- no API token at all and connected as the owner role. Requests through the
-- Data API always carry a token and connect as "authenticator", so a browser
-- can never satisfy this.
create or replace function public.kfp_is_db_owner_session()
returns boolean language sql stable as $$
  select auth.uid() is null
     and coalesce(nullif(current_setting('request.jwt.claims', true), ''), nullif(current_setting('request.jwt.claim.role', true), '')) is null
     and session_user in ('postgres', 'supabase_admin')
$$;

-- viewer < admin < owner
create or replace function public.kfp_role_rank(p_role text)
returns int language sql immutable as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'viewer' then 1 else 0 end
$$;

create or replace function public.is_admin(p_min_role text default 'admin')
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.admin_roles r
    join public.profiles p on p.user_id = r.user_id
    where r.user_id = auth.uid()
      and p.suspended_at is null
      and public.kfp_role_rank(r.role) >= public.kfp_role_rank(p_min_role))
$$;
revoke all on function public.is_admin(text) from public, anon;
grant execute on function public.is_admin(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. admin_audit_logs — append-only
-- ---------------------------------------------------------------------
create table if not exists public.admin_audit_logs (
  id             bigserial primary key,
  admin_id       uuid references auth.users(id) on delete set null,
  action         text not null,                  -- e.g. 'price.set', 'plan.grant', 'user.suspend'
  target_user_id uuid references auth.users(id) on delete set null,
  target_table   text,
  target_id      text,
  before         jsonb,
  after          jsonb,
  reason         text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists admin_audit_logs_created_idx on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_logs_target_idx  on public.admin_audit_logs (target_user_id, created_at desc);
create index if not exists admin_audit_logs_admin_idx   on public.admin_audit_logs (admin_id, created_at desc);

alter table public.admin_audit_logs enable row level security;
revoke all on public.admin_audit_logs from anon, authenticated;
grant select on public.admin_audit_logs to authenticated;          -- RLS: admins (viewer+) only
grant select, insert on public.admin_audit_logs to service_role;
grant usage, select on sequence public.admin_audit_logs_id_seq to service_role;
drop policy if exists admin_audit_logs_admin_read on public.admin_audit_logs;
create policy admin_audit_logs_admin_read on public.admin_audit_logs for select
  to authenticated using (public.is_admin('viewer'));

create or replace function public.kfp_audit_immutable()
returns trigger language plpgsql as $$
begin
  -- Only allowed change: FK "on delete set null" when a user account is deleted
  -- (the log row itself — action, before/after, reason, time — stays untouched).
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'admin_id' - 'target_user_id') = (to_jsonb(old) - 'admin_id' - 'target_user_id')
     and (new.admin_id is null or new.admin_id = old.admin_id)
     and (new.target_user_id is null or new.target_user_id = old.target_user_id) then
    return new;
  end if;
  raise exception 'admin_audit_logs is append-only' using errcode = '42501';
end;
$$;
drop trigger if exists admin_audit_logs_immutable on public.admin_audit_logs;
create trigger admin_audit_logs_immutable before update or delete on public.admin_audit_logs
for each row execute procedure public.kfp_audit_immutable();

-- internal writer used by every admin_* function (and Edge Functions via service_role)
create or replace function public.kfp_audit(p_action text, p_target_user uuid, p_target_table text, p_target_id text,
                                            p_before jsonb, p_after jsonb, p_reason text, p_admin uuid default null)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.admin_audit_logs (admin_id, action, target_user_id, target_table, target_id, before, after, reason)
  values (coalesce(p_admin, auth.uid()), p_action, p_target_user, p_target_table, p_target_id, p_before, p_after, coalesce(p_reason, ''))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.kfp_audit(text, uuid, text, text, jsonb, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.kfp_audit(text, uuid, text, text, jsonb, jsonb, text, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 3. plan_prices — editable by admins, old prices kept (inactive) as history
-- ---------------------------------------------------------------------
create table if not exists public.plan_prices (
  id                uuid primary key default gen_random_uuid(),
  plan_id           text not null references public.plans(id),
  billing_interval  text not null check (billing_interval in ('month', 'year')),
  currency          text not null check (currency in ('THB', 'KRW')),
  amount_minor      bigint not null check (amount_minor > 0 and amount_minor < 100000000000),
  provider          text not null default 'stripe',
  provider_price_id text,                          -- filled by the admin Edge Function (Phase 7)
  active            boolean not null default true,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  deactivated_at    timestamptz
);
create unique index if not exists plan_prices_one_active
  on public.plan_prices (plan_id, billing_interval, currency, provider) where active;
create unique index if not exists plan_prices_provider_price_uidx
  on public.plan_prices (provider, provider_price_id) where provider_price_id is not null;

alter table public.plan_prices enable row level security;
revoke all on public.plan_prices from anon, authenticated;
grant select on public.plan_prices to anon, authenticated;
grant select, insert, update, delete on public.plan_prices to service_role;
drop policy if exists plan_prices_read_active on public.plan_prices;
create policy plan_prices_read_active on public.plan_prices for select
  to anon, authenticated using (active);
drop policy if exists plan_prices_admin_read on public.plan_prices;
create policy plan_prices_admin_read on public.plan_prices for select
  to authenticated using (public.is_admin('viewer'));                -- price history

-- Default prices from the spec (KRW yearly is set later by an admin).
insert into public.plan_prices (plan_id, billing_interval, currency, amount_minor)
select v.plan_id, v.i, v.c, v.a from (values
  ('plus',    'month', 'THB',  12900::bigint), ('plus',    'year', 'THB', 129000::bigint), ('plus',    'month', 'KRW', 5900::bigint),
  ('premium', 'month', 'THB',  19900::bigint), ('premium', 'year', 'THB', 199000::bigint), ('premium', 'month', 'KRW', 8900::bigint)
) as v(plan_id, i, c, a)
where not exists (select 1 from public.plan_prices p
                  where p.plan_id = v.plan_id and p.billing_interval = v.i and p.currency = v.c);

-- Admin: set (or change) a price. Creates a new active row; the old one is kept inactive.
-- Existing subscribers keep the price they signed up with (provider side).
create or replace function public.admin_set_price(p_plan text, p_interval text, p_currency text,
                                                  p_amount_minor bigint, p_reason text default '')
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_old public.plan_prices;
  v_new public.plan_prices;
begin
  if not (public.is_admin('admin') or public.kfp_is_db_owner_session()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_plan = 'free' or not exists (select 1 from public.plans where id = p_plan) then
    raise exception 'unknown or free plan: %', p_plan using errcode = '22023';
  end if;
  if p_interval not in ('month', 'year') or p_currency not in ('THB', 'KRW') then
    raise exception 'invalid interval/currency' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor >= 100000000000 then
    raise exception 'invalid amount' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason required' using errcode = '22023';
  end if;

  select * into v_old from public.plan_prices
  where plan_id = p_plan and billing_interval = p_interval and currency = p_currency and provider = 'stripe' and active
  for update;
  if found and v_old.amount_minor = p_amount_minor then
    return v_old.id;                                   -- no change
  end if;
  if found then
    update public.plan_prices set active = false, deactivated_at = now() where id = v_old.id;
  end if;
  insert into public.plan_prices (plan_id, billing_interval, currency, amount_minor, created_by)
  values (p_plan, p_interval, p_currency, p_amount_minor, auth.uid())
  returning * into v_new;

  perform public.kfp_audit('price.set', null, 'plan_prices', v_new.id::text,
    case when v_old.id is null then null else to_jsonb(v_old) end, to_jsonb(v_new), p_reason);
  return v_new.id;
end;
$$;
revoke all on function public.admin_set_price(text, text, text, bigint, text) from public, anon;
grant execute on function public.admin_set_price(text, text, text, bigint, text) to authenticated;

create or replace function public.admin_deactivate_price(p_price_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_old public.plan_prices;
begin
  if not (public.is_admin('admin') or public.kfp_is_db_owner_session()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason required' using errcode = '22023';
  end if;
  select * into v_old from public.plan_prices where id = p_price_id for update;
  if not found or not v_old.active then return; end if;
  update public.plan_prices set active = false, deactivated_at = now() where id = p_price_id;
  perform public.kfp_audit('price.deactivate', null, 'plan_prices', p_price_id::text, to_jsonb(v_old),
    to_jsonb(v_old) || '{"active": false}'::jsonb, p_reason);
end;
$$;
revoke all on function public.admin_deactivate_price(uuid, text) from public, anon;
grant execute on function public.admin_deactivate_price(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. subscriptions: link to the price actually paid (for MRR/ARR)
-- ---------------------------------------------------------------------
alter table public.subscriptions add column if not exists price_id          uuid references public.plan_prices(id) on delete set null;
alter table public.subscriptions add column if not exists unit_amount_minor bigint;
alter table public.subscriptions add column if not exists latest_invoice_id text;
create index if not exists subscriptions_period_end_idx on public.subscriptions (current_period_end);

-- ---------------------------------------------------------------------
-- 5. billing_customers — one provider customer per user
-- ---------------------------------------------------------------------
create table if not exists public.billing_customers (
  user_id              uuid not null references auth.users(id) on delete cascade,
  provider             text not null default 'stripe',
  provider_customer_id text not null,
  email                text,
  created_at           timestamptz not null default now(),
  primary key (user_id, provider)
);
create unique index if not exists billing_customers_provider_uidx on public.billing_customers (provider, provider_customer_id);
alter table public.billing_customers enable row level security;
revoke all on public.billing_customers from anon, authenticated;
grant select on public.billing_customers to authenticated;
grant select, insert, update, delete on public.billing_customers to service_role;
drop policy if exists billing_customers_select_own on public.billing_customers;
create policy billing_customers_select_own on public.billing_customers for select
  to authenticated using (auth.uid() = user_id or public.is_admin('viewer'));

-- ---------------------------------------------------------------------
-- 6. payments (= invoices) + payment_refunds
--    Kept even if the user account is deleted (accounting) → user_id set null.
-- ---------------------------------------------------------------------
create table if not exists public.payments (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid references auth.users(id) on delete set null,
  subscription_id            uuid references public.subscriptions(id) on delete set null,
  provider                   text not null default 'stripe',
  provider_invoice_id        text,
  provider_payment_intent_id text,
  provider_charge_id         text,
  plan_id                    text references public.plans(id),
  billing_interval           text check (billing_interval in ('month', 'year')),
  currency                   text not null,
  amount_due_minor           bigint not null default 0,
  amount_paid_minor          bigint not null default 0,
  amount_refunded_minor      bigint not null default 0,
  status                     text not null check (status in
                               ('draft','open','paid','failed','action_required','void','uncollectible','refunded','partially_refunded')),
  failure_reason             text,
  period_start               timestamptz,
  period_end                 timestamptz,
  hosted_invoice_url         text,
  invoice_pdf_url            text,
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (amount_refunded_minor <= greatest(amount_paid_minor, 0))
);
create unique index if not exists payments_provider_invoice_uidx
  on public.payments (provider, provider_invoice_id) where provider_invoice_id is not null;
create index if not exists payments_user_idx    on public.payments (user_id, created_at desc);
create index if not exists payments_status_idx  on public.payments (status, created_at desc);
create index if not exists payments_paid_at_idx on public.payments (paid_at desc) where status in ('paid', 'partially_refunded', 'refunded');

alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;
grant select, insert, update, delete on public.payments to service_role;
drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments for select
  to authenticated using (auth.uid() = user_id or public.is_admin('viewer'));
drop trigger if exists payments_touch_updated_at on public.payments;
create trigger payments_touch_updated_at before update on public.payments
for each row execute procedure public.touch_kfp_updated_at();

create table if not exists public.payment_refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references public.payments(id) on delete cascade,
  provider           text not null default 'stripe',
  provider_refund_id text,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           text not null,
  status             text not null default 'succeeded' check (status in ('pending','succeeded','failed','canceled')),
  reason             text,
  created_by         uuid references auth.users(id) on delete set null,   -- admin, if refunded from the dashboard
  created_at         timestamptz not null default now()
);
create unique index if not exists payment_refunds_provider_uidx
  on public.payment_refunds (provider, provider_refund_id) where provider_refund_id is not null;
create index if not exists payment_refunds_payment_idx on public.payment_refunds (payment_id);
alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from anon, authenticated;
grant select on public.payment_refunds to authenticated;
grant select, insert, update, delete on public.payment_refunds to service_role;
drop policy if exists payment_refunds_select_own on public.payment_refunds;
create policy payment_refunds_select_own on public.payment_refunds for select
  to authenticated using (public.is_admin('viewer') or exists (
    select 1 from public.payments p where p.id = payment_id and p.user_id = auth.uid()));

-- ---------------------------------------------------------------------
-- 7. stripe_webhook_events — idempotency for webhooks (any provider)
--    kfp_claim_webhook_event() returns true exactly once per event (plus
--    retries of failed / stuck attempts). Only service_role can use it.
-- ---------------------------------------------------------------------
create table if not exists public.stripe_webhook_events (
  event_id     text primary key,
  provider     text not null default 'stripe',
  type         text not null,
  status       text not null default 'processing' check (status in ('processing','processed','failed','ignored')),
  attempts     int not null default 1,
  last_error   text,
  payload      jsonb,
  received_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists stripe_webhook_events_status_idx on public.stripe_webhook_events (status, received_at desc);
alter table public.stripe_webhook_events enable row level security;
revoke all on public.stripe_webhook_events from anon, authenticated;
grant select, insert, update, delete on public.stripe_webhook_events to service_role;

create or replace function public.kfp_claim_webhook_event(p_event_id text, p_type text, p_payload jsonb, p_provider text default 'stripe')
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_claimed boolean := false;
begin
  insert into public.stripe_webhook_events as e (event_id, provider, type, payload)
  values (p_event_id, p_provider, p_type, p_payload)
  on conflict (event_id) do update
    set status = 'processing', attempts = e.attempts + 1, last_error = null, updated_at = now()
    where e.status = 'failed'
       or (e.status = 'processing' and e.updated_at < now() - interval '5 minutes')   -- crashed worker
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;
create or replace function public.kfp_finish_webhook_event(p_event_id text, p_status text, p_error text default null)
returns void
language sql security definer
set search_path = public
as $$
  update public.stripe_webhook_events
  set status = p_status, last_error = p_error, updated_at = now(),
      processed_at = case when p_status in ('processed', 'ignored') then now() else processed_at end
  where event_id = p_event_id
$$;
revoke all on function public.kfp_claim_webhook_event(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.kfp_finish_webhook_event(text, text, text) from public, anon, authenticated;
grant execute on function public.kfp_claim_webhook_event(text, text, jsonb, text) to service_role;
grant execute on function public.kfp_finish_webhook_event(text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 8. user_activity — throttled in the database (not every click)
--    touch_activity(page): profiles.last_active_at/last_page at most once a
--    minute; a log row at most once per page per 5 minutes.
-- ---------------------------------------------------------------------
create table if not exists public.user_activity (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null default 'page' check (kind in ('login', 'page', 'heartbeat')),
  page       text,
  created_at timestamptz not null default now()
);
create index if not exists user_activity_user_idx    on public.user_activity (user_id, created_at desc);
create index if not exists user_activity_created_idx on public.user_activity (created_at desc);
alter table public.user_activity enable row level security;
revoke all on public.user_activity from anon, authenticated;
grant select on public.user_activity to authenticated;
grant select, insert, delete on public.user_activity to service_role;
grant usage, select on sequence public.user_activity_id_seq to service_role;
drop policy if exists user_activity_select_own on public.user_activity;
create policy user_activity_select_own on public.user_activity for select
  to authenticated using (auth.uid() = user_id or public.is_admin('viewer'));

create or replace function public.touch_activity(p_page text default null, p_kind text default 'page')
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_page text := left(regexp_replace(coalesce(p_page, ''), '[^A-Za-z0-9._/#-]', '', 'g'), 64);
  v_kind text := case when p_kind in ('login', 'page', 'heartbeat') then p_kind else 'page' end;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  update public.profiles
  set last_active_at = now(), last_page = nullif(v_page, '')
  where user_id = v_uid and (last_active_at is null or last_active_at < now() - interval '1 minute'
                             or last_page is distinct from nullif(v_page, ''));
  if v_kind = 'login' or not exists (
       select 1 from public.user_activity
       where user_id = v_uid and page is not distinct from nullif(v_page, '')
         and created_at > now() - interval '5 minutes') then
    insert into public.user_activity (user_id, kind, page) values (v_uid, v_kind, nullif(v_page, ''));
  end if;
end;
$$;
revoke all on function public.touch_activity(text, text) from public, anon;
grant execute on function public.touch_activity(text, text) to authenticated;

-- Retention (call from pg_cron daily if desired): keep 180 days of activity.
create or replace function public.kfp_prune_activity(p_keep_days int default 180)
returns bigint
language sql security definer
set search_path = public
as $$
  with d as (delete from public.user_activity where created_at < now() - make_interval(days => p_keep_days) returning 1)
  select count(*) from d
$$;
revoke all on function public.kfp_prune_activity(int) from public, anon, authenticated;
grant execute on function public.kfp_prune_activity(int) to service_role;

-- ---------------------------------------------------------------------
-- 9. Admins can read profiles / subscriptions / entitlements (for the
--    dashboard in Phase 10). Writes still go through audited functions.
-- ---------------------------------------------------------------------
drop policy if exists profiles_admin_read on public.profiles;
create policy profiles_admin_read on public.profiles for select
  to authenticated using (public.is_admin('viewer'));
drop policy if exists subscriptions_admin_read on public.subscriptions;
create policy subscriptions_admin_read on public.subscriptions for select
  to authenticated using (public.is_admin('viewer'));
drop policy if exists user_entitlements_admin_read on public.user_entitlements;
create policy user_entitlements_admin_read on public.user_entitlements for select
  to authenticated using (public.is_admin('viewer'));
