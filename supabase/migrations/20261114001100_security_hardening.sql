-- =====================================================================
-- Korea Finance Planner · migration 11 · Security hardening (Phase 12)
--
--   * trigger functions are not callable through the API
--   * profiles: browsers may only UPDATE nickname / country (no insert/delete),
--     with length/format limits; user_data: size + shape limits
--   * the unused Phase 5 trigger function is removed
--   * kfp_security_report(): re-runnable self-check of RLS, grants and
--     SECURITY DEFINER functions — run it after every future migration
-- Additive & re-runnable. Existing rows are never rewritten.
-- =====================================================================

-- 1. trigger functions: never callable directly
do $$ declare f text; begin
  foreach f in array array['handle_new_kfp_user()', 'sync_kfp_profile_from_auth()', 'touch_kfp_updated_at()',
                           'kfp_audit_immutable()', 'kfp_route_gold_keys()'] loop
    if to_regprocedure('public.' || f) is not null then
      execute format('revoke all on function public.%s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;
drop function if exists public.kfp_protect_gold_keys();          -- replaced by kfp_route_gold_keys (Phase 9)

-- 2. profiles: rows are created by the auth trigger only; browsers edit two columns
revoke insert, delete on public.profiles from anon, authenticated;
drop policy if exists "profiles_insert_own" on public.profiles;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_nickname_len') then
    alter table public.profiles add constraint profiles_nickname_len check (char_length(nickname) <= 60) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_country_fmt') then
    alter table public.profiles add constraint profiles_country_fmt check (country is null or country ~ '^[A-Z]{2}$') not valid;
  end if;
end $$;

-- 3. user_data: one JSON object per member, at most 2 MB (a normal account is a few KB)
create or replace function public.kfp_user_data_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.data is null or jsonb_typeof(new.data) <> 'object' then
    raise exception 'user_data.data must be a JSON object' using errcode = '22023';
  end if;
  if octet_length(new.data::text) > 2000000 then
    raise exception 'user_data too large (max 2 MB)' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.kfp_user_data_guard() from public, anon, authenticated;
drop trigger if exists user_data_guard on public.user_data;
create trigger user_data_guard before insert or update on public.user_data
for each row execute procedure public.kfp_user_data_guard();

-- 4. self-check. Empty result = OK. Run in the SQL Editor:  select * from public.kfp_security_report();
create or replace function public.kfp_security_report()
returns table (severity text, check_name text, object text, detail text)
language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare
  -- the complete browser API (anything else that is SECURITY DEFINER must not be callable)
  api_anon text[] := array['is_username_available'];
  api_auth text[] := array['is_username_available', 'has_feature', 'is_admin', 'get_my_entitlements', 'get_my_billing',
                           'get_my_gold', 'save_my_gold', 'touch_activity',
                           'admin_whoami', 'admin_overview', 'admin_list_users', 'admin_user_detail', 'admin_revenue',
                           'admin_audit_list', 'admin_list_prices', 'admin_set_price', 'admin_deactivate_price',
                           'admin_set_plan', 'admin_extend_access', 'admin_revoke_access', 'admin_set_suspended',
                           'admin_activity_analytics', 'admin_user_activity', 'export_my_gold'];
  anon_read text[] := array['plans', 'plan_prices'];
begin
  -- service_role (Edge/CI) or the SQL Editor (database owner session, no API token)
  if not (coalesce(auth.role(), '') = 'service_role' or public.kfp_is_db_owner_session()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select 'HIGH', 'rls_disabled', c.relname::text, 'table without row level security'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

  return query
  select 'HIGH', 'definer_without_search_path', p.oid::regprocedure::text, 'SECURITY DEFINER without SET search_path'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

  return query
  select 'HIGH', 'definer_callable_by_anon', p.oid::regprocedure::text, 'not part of the public API'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
    and not (p.proname = any (api_anon));

  return query
  select 'HIGH', 'definer_callable_by_authenticated', p.oid::regprocedure::text, 'not part of the member/admin API'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
    and not (p.proname = any (api_auth));

  return query
  select 'HIGH', 'anon_write_grant', g.table_name::text, string_agg(g.privilege_type, ',')
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.grantee in ('anon', 'PUBLIC') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  group by g.table_name;

  return query
  select 'HIGH', 'authenticated_write_grant', g.table_name::text, string_agg(g.privilege_type, ',')
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.grantee = 'authenticated' and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.table_name = 'user_data' and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
  group by g.table_name;

  return query
  select 'HIGH', 'authenticated_column_update', (c.table_name || '.' || c.column_name)::text, 'browser can change this column'
  from information_schema.column_privileges c
  where c.table_schema = 'public' and c.grantee = 'authenticated' and c.privilege_type = 'UPDATE'
    and not ((c.table_name = 'profiles' and c.column_name in ('nickname', 'country'))
          or (c.table_name = 'user_data' and c.column_name in ('user_id', 'data', 'updated_at')));

  return query
  select 'MEDIUM', 'anon_readable_table', g.table_name::text, 'readable without login'
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.grantee in ('anon', 'PUBLIC') and g.privilege_type = 'SELECT'
    and not (g.table_name = any (anon_read));

  return query
  select 'MEDIUM', 'open_policy', (pl.tablename || '.' || pl.policyname)::text, coalesce(pl.qual, '(no USING)')
  from pg_policies pl
  where pl.schemaname = 'public' and pl.cmd in ('SELECT', 'ALL')
    and (pl.qual is null or pl.qual in ('true', '(true)'))
    and not (pl.tablename = any (anon_read));

  return query
  select 'INFO', 'no_owner', 'admin_roles', 'no owner yet — add one with SQL (docs/SETUP.md Phase 6)'
  where not exists (select 1 from public.admin_roles where role = 'owner');
end;
$$;
revoke all on function public.kfp_security_report() from public, anon, authenticated;
grant execute on function public.kfp_security_report() to service_role;

-- 5. Data portability (PART 7: data is kept after expiry and the member can export it).
--    The member's OWN gold data, read-only, whatever the plan — for the "download my data"
--    file only (rate-limited; using the gold portfolio still needs Premium: get_my_gold/save_my_gold).
create or replace function public.export_my_gold()
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := auth.uid(); g public.user_gold_data;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not public.kfp_rate_hit('goldexport:' || uid::text, 10, 3600) then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  select * into g from public.user_gold_data where user_id = uid;
  return jsonb_build_object('exported_at', now(), 'lots', coalesce(g.lots, '[]'::jsonb), 'settings', coalesce(g.settings, '{}'::jsonb),
                            'updated_at', g.updated_at);
end;
$$;
revoke all on function public.export_my_gold() from public, anon;
grant execute on function public.export_my_gold() to authenticated;
