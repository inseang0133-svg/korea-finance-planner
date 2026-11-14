-- =====================================================================
-- Korea Finance Planner · SaaS migration 1/n · Core auth + plans
-- Phase 2 (Email auth + legacy account migration)
--
-- * Additive & re-runnable. Does NOT drop or rewrite existing data.
-- * Keeps public.profiles and public.user_data exactly as they are
--   (all existing columns/policies stay), only adds columns/objects.
-- * Run on STAGING first (see docs/SETUP.md), then production.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. profiles: extra columns (existing: user_id, username, nickname,
--    created_at, updated_at). "nickname" stays the display name.
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists email             text;
alter table public.profiles add column if not exists is_legacy_email   boolean not null default false;
alter table public.profiles add column if not exists email_verified_at timestamptz;
alter table public.profiles add column if not exists country           text;
alter table public.profiles add column if not exists last_login_at     timestamptz;
alter table public.profiles add column if not exists last_active_at    timestamptz;
alter table public.profiles add column if not exists last_page         text;
alter table public.profiles add column if not exists suspended_at      timestamptz;

create index if not exists profiles_email_idx       on public.profiles (lower(email));
create index if not exists profiles_created_at_idx  on public.profiles (created_at desc);
create index if not exists profiles_last_active_idx on public.profiles (last_active_at desc nulls last);

comment on column public.profiles.is_legacy_email is
  'true = account still uses the old username@kfp.example.com placeholder address';

-- Backfill from auth.users (legacy accounts keep their id/profile/data).
update public.profiles p
set email             = u.email,
    is_legacy_email   = coalesce(u.email, '') ilike '%@kfp.example.com',
    email_verified_at = u.email_confirmed_at,
    last_login_at     = coalesce(p.last_login_at, u.last_sign_in_at)
from auth.users u
where u.id = p.user_id
  and (p.email is distinct from u.email
       or p.email_verified_at is distinct from u.email_confirmed_at);

-- ---------------------------------------------------------------------
-- 2. Column-level privileges (fix R2): users may only edit cosmetic
--    fields of their own profile. email / plan-ish / activity columns
--    are written by triggers or security-definer functions only.
--    The existing RLS policies (own row only) still apply on top.
-- ---------------------------------------------------------------------
revoke insert, update on public.profiles from authenticated;
grant  update (nickname, country) on public.profiles to authenticated;
-- select/delete grants from the original schema are left unchanged.

-- ---------------------------------------------------------------------
-- 3. Username helpers
-- ---------------------------------------------------------------------
create or replace function public.kfp_normalize_username(p text)
returns text
language sql immutable
as $$
  select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9._-]', '', 'g'))
$$;

-- Public, returns only true/false. Never returns e-mail or ids.
create or replace function public.is_username_available(p_username text)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare v text := public.kfp_normalize_username(p_username);
begin
  if v !~ '^[a-z0-9._-]{3,32}$' or v <> lower(coalesce(p_username, '')) then
    return false;
  end if;
  return not exists (select 1 from public.profiles where username = v);
end;
$$;
revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. New-user trigger (fix R1)
--    * username from signUp metadata (options.data.username), falling
--      back to the e-mail local part (legacy behaviour).
--    * never fails sign-up on a username clash: adds a short suffix.
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

  insert into public.profiles (user_id, username, nickname, email, is_legacy_email, email_verified_at, last_login_at)
  values (new.id, uname, nick, new.email,
          coalesce(new.email, '') ilike '%@kfp.example.com',
          new.email_confirmed_at, new.last_sign_in_at)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_kfp on auth.users;
create trigger on_auth_user_created_kfp
after insert on auth.users
for each row execute procedure public.handle_new_kfp_user();

-- Keep profiles.email / verification / last login in sync with auth.users
-- (covers e-mail change confirmation for legacy accounts).
create or replace function public.sync_kfp_profile_from_auth()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles
  set email             = new.email,
      is_legacy_email   = coalesce(new.email, '') ilike '%@kfp.example.com',
      email_verified_at = new.email_confirmed_at,
      last_login_at     = coalesce(new.last_sign_in_at, last_login_at)
  where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated_kfp on auth.users;
create trigger on_auth_user_updated_kfp
after update of email, email_confirmed_at, last_sign_in_at on auth.users
for each row execute procedure public.sync_kfp_profile_from_auth();

-- ---------------------------------------------------------------------
-- 5. Plans (read-only to the public; prices live in plan_prices, Phase 6)
-- ---------------------------------------------------------------------
create table if not exists public.plans (
  id          text primary key,             -- 'free' | 'plus' | 'premium'
  name        text not null,
  description text not null default '',
  features    jsonb not null default '{}'::jsonb,
  limits      jsonb not null default '{}'::jsonb,
  sort        int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.plans enable row level security;
drop policy if exists plans_read_active on public.plans;
create policy plans_read_active on public.plans for select
  to anon, authenticated using (active);
grant select on public.plans to anon, authenticated;
grant select, insert, update, delete on public.plans to service_role;

drop trigger if exists plans_touch_updated_at on public.plans;
create trigger plans_touch_updated_at before update on public.plans
for each row execute procedure public.touch_kfp_updated_at();

insert into public.plans (id, name, description, features, limits, sort) values
('free', 'Free', 'เครื่องคิดเงินเดือน แบ่งเงิน และรายจ่ายพื้นฐาน',
 '{"salary":true,"salary_history":true,"expenses":true,"work_records":false,"advanced_statistics":false,"export":false,"cloud_sync":false,"gold_portfolio":false}',
 '{"salary_history_months":6,"expense_history_months":2,"grace_days":0}', 0),
('plus', 'Finance Plus', 'ทุกอย่างใน Free + บันทึกงาน สถิติขั้นสูง Export และ Cloud Sync',
 '{"salary":true,"salary_history":true,"expenses":true,"work_records":true,"advanced_statistics":true,"export":true,"cloud_sync":true,"gold_portfolio":false}',
 '{"salary_history_months":null,"expense_history_months":null,"grace_days":7}', 1),
('premium', 'Finance Premium', 'ทุกอย่างใน Plus + พอร์ตทองครบชุด',
 '{"salary":true,"salary_history":true,"expenses":true,"work_records":true,"advanced_statistics":true,"export":true,"cloud_sync":true,"gold_portfolio":true}',
 '{"salary_history_months":null,"expense_history_months":null,"grace_days":7}', 2)
on conflict (id) do nothing;   -- never overwrite prices/features edited later by admin

-- ---------------------------------------------------------------------
-- 6. Manual entitlements (admin grants, legacy launch grant)
--    Users can read their own rows; nobody writes through the Data API.
-- ---------------------------------------------------------------------
create table if not exists public.user_entitlements (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  plan_id     text not null references public.plans(id),
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz,                        -- null = no expiry
  reason      text not null default 'admin_grant',
  note        text not null default '',
  granted_by  uuid references auth.users(id) on delete set null,
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists user_entitlements_user_idx
  on public.user_entitlements (user_id) where revoked_at is null;
create unique index if not exists user_entitlements_legacy_once
  on public.user_entitlements (user_id) where reason = 'legacy_launch';

alter table public.user_entitlements enable row level security;
drop policy if exists user_entitlements_select_own on public.user_entitlements;
create policy user_entitlements_select_own on public.user_entitlements for select
  to authenticated using (auth.uid() = user_id);
grant select on public.user_entitlements to authenticated;
grant select, insert, update, delete on public.user_entitlements to service_role;

-- ---------------------------------------------------------------------
-- 7. Data API grants for the new objects (anon never touches profiles)
-- ---------------------------------------------------------------------
grant select on public.profiles to authenticated;
