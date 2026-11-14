-- =====================================================================
-- Korea Finance Planner · Baseline for the EXISTING production project
--
-- The live project (created 2026-08-22) never ran the helper part of
-- supabase_schema.sql: it has the two tables + RLS policies, but NO
-- functions and NO triggers (profiles were inserted by the old web app).
-- 0100 needs public.touch_kfp_updated_at(), so install_all.sql failed there.
--
-- This file brings such a project up to supabase_schema.sql without
-- touching any row data. On a project that already ran supabase_schema.sql
-- (staging, tests) every statement is a no-op. Additive, re-runnable.
-- =====================================================================

create or replace function public.touch_kfp_updated_at()
returns trigger
language plpgsql
set search_path = public
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

-- nickname: supabase_schema.sql has NOT NULL DEFAULT '' — production was nullable.
update public.profiles set nickname = '' where nickname is null;
alter table public.profiles alter column nickname set default '';
alter table public.profiles alter column nickname set not null;

create index if not exists profiles_username_idx on public.profiles(username);

-- Realtime for cross-device updates (only if missing).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_data') then
    alter publication supabase_realtime add table public.user_data;
  end if;
end;
$$;

-- The app never reads these tables as anon (RLS already blocks it: every
-- policy is "to authenticated"). Remove the broad default grants anyway.
revoke all on public.profiles  from anon;
revoke all on public.user_data from anon;
revoke truncate, references, trigger on public.profiles  from authenticated;
revoke truncate, references, trigger on public.user_data from authenticated;
grant select, insert, update, delete on public.user_data to authenticated;
grant select, insert, update, delete on public.profiles  to service_role;
grant select, insert, update, delete on public.user_data to service_role;
