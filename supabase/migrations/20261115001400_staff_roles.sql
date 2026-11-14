-- =====================================================================
-- Korea Finance Planner · Staff roles from the admin console (15/11/2026)
--
-- • admin_set_role(user, 'admin'|'viewer'|'none', reason) — OWNER ONLY.
--   admin / viewer → row in admin_roles + an unlimited Premium grant
--   (reason 'staff', no expiry). 'none' → role removed and the staff grant
--   revoked (other grants / paid subscriptions untouched).
--   Viewer stays read-only: every write RPC already requires 'admin'
--   (kfp_require_admin('admin')) and admin-actions checks the role in DB.
-- • Owners get the same unlimited staff grant.
-- • get_my_entitlements() also returns admin_role (owner|admin|viewer|null)
--   so the app can show the OWNER / ADMIN / VIEWER badge.
-- Additive, re-runnable. Needs 0400, 0500, 0900.
-- =====================================================================

create or replace function public.kfp_grant_staff(p_user uuid, p_by uuid, p_note text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.user_entitlements
             where user_id = p_user and reason = 'staff' and revoked_at is null and plan_id = 'premium' and expires_at is null) then
    return;
  end if;
  update public.user_entitlements set revoked_at = now(), revoked_by = p_by
  where user_id = p_user and reason = 'staff' and revoked_at is null;
  insert into public.user_entitlements (user_id, plan_id, starts_at, expires_at, reason, note, granted_by)
  values (p_user, 'premium', now(), null, 'staff', left(coalesce(p_note, 'สิทธิ์ทีมงาน'), 500), p_by);
end;
$$;
revoke all on function public.kfp_grant_staff(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.admin_set_role(p_user uuid, p_role text, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_old text;
  v_before jsonb; v_after jsonb;
begin
  perform public.kfp_require_admin('owner');
  if p_role not in ('admin', 'viewer', 'none') then raise exception 'invalid_role' using errcode = '22023'; end if;
  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if p_user = me then raise exception 'cannot_act_on_self' using errcode = '42501'; end if;
  if coalesce(length(trim(p_reason)), 0) < 3 or length(p_reason) > 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select role into v_old from public.admin_roles where user_id = p_user;
  if v_old = 'owner' then raise exception 'cannot_change_owner' using errcode = '42501'; end if;

  v_before := public.kfp_access_snapshot(p_user) || jsonb_build_object('role', v_old);
  if p_role = 'none' then
    delete from public.admin_roles where user_id = p_user and role <> 'owner';
    update public.user_entitlements set revoked_at = now(), revoked_by = me
    where user_id = p_user and reason = 'staff' and revoked_at is null;
  else
    insert into public.admin_roles (user_id, role, granted_by, note)
    values (p_user, p_role, me, left(p_reason, 500))
    on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by, note = excluded.note;
    perform public.kfp_grant_staff(p_user, me, 'ทีมงาน (' || p_role || ') · ' || left(p_reason, 400));
  end if;
  v_after := public.kfp_access_snapshot(p_user) || jsonb_build_object('role', case when p_role = 'none' then null else p_role end);

  perform public.kfp_audit('role.set', p_user, 'admin_roles', p_user::text, v_before, v_after, p_reason);
  return v_after;
end;
$$;
revoke all on function public.admin_set_role(uuid, text, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text, text) to authenticated;

-- existing staff (owner / admin / viewer) → unlimited Premium
do $$ declare r record; begin
  for r in select user_id, role from public.admin_roles loop
    perform public.kfp_grant_staff(r.user_id, null, 'ทีมงาน (' || r.role || ')');
  end loop;
end $$;

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
      'admin_role',  public.kfp_admin_role(auth.uid()),
      'checked_at',  now())
    from public.kfp_effective_plan(auth.uid()) e
    join public.plans p on p.id = e.plan_id
  ) end
$$;
revoke all on function public.get_my_entitlements() from public, anon;
grant execute on function public.get_my_entitlements() to authenticated;

-- security self-check: admin_set_role is part of the admin API (owner-gated inside)
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
                           'admin_activity_analytics', 'admin_user_activity', 'export_my_gold', 'admin_set_role'];
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
