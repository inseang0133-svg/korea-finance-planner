-- Korea Finance Planner - Supabase database
-- Run this entire file once in Supabase SQL Editor.
-- IMPORTANT: the browser uses only the Publishable/anon key, never service_role.

create extension if not exists pgcrypto;

-- -----------------------------
-- User profile / display name
-- -----------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  nickname text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Automatically create a profile after Auth creates a user.
create or replace function public.handle_new_kfp_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, username, nickname)
  values (
    new.id,
    lower(split_part(coalesce(new.email, ''), '@', 1)),
    lower(split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_kfp on auth.users;
create trigger on_auth_user_created_kfp
after insert on auth.users
for each row execute procedure public.handle_new_kfp_user();

-- -----------------------------
-- One cloud snapshot per user
-- -----------------------------
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "user_data_select_own" on public.user_data;
create policy "user_data_select_own"
on public.user_data for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_data_insert_own" on public.user_data;
create policy "user_data_insert_own"
on public.user_data for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "user_data_update_own" on public.user_data;
create policy "user_data_update_own"
on public.user_data for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "user_data_delete_own" on public.user_data;
create policy "user_data_delete_own"
on public.user_data for delete
to authenticated
using (auth.uid() = user_id);

-- Realtime for cross-device updates.
alter publication supabase_realtime add table public.user_data;

-- Helpful indexes / automatic updated_at.
create index if not exists profiles_username_idx on public.profiles(username);

create or replace function public.touch_kfp_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute procedure public.touch_kfp_updated_at();

drop trigger if exists user_data_touch_updated_at on public.user_data;
create trigger user_data_touch_updated_at
before update on public.user_data
for each row execute procedure public.touch_kfp_updated_at();

-- Optional: keep new users immediately usable with username/password.
-- In Supabase Dashboard, Authentication > Providers > Email,
-- turn OFF "Confirm email" if you want signup to log in immediately.
