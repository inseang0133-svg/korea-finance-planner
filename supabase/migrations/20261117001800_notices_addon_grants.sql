-- =====================================================================
-- Korea Finance Planner · Welcome notices + admin add-on grants (17/11/2026) — migration 1800
--
--  • user_notices: one-time "congratulations" pop-ups
--      purchase  → a Stripe subscription (plan or add-on) became active   (trigger on subscriptions)
--      gift      → an admin granted a plan or add-on                       (admin_set_plan / admin_set_addons)
--    browser: read own via get_my_notices(), mark seen via ack_my_notices(); no table grants
--  • admin_set_plan now replaces only PLAN grants (add-on grants are kept)
--  • admin_set_addons(user, addons[], expires_at, reason): set the admin-granted add-ons to exactly this list
-- Additive and re-runnable. Rollback: drop trigger subscriptions_notice + the 3 new functions + table user_notices,
-- and re-apply admin_set_plan from migration 1500.
-- =====================================================================

create table if not exists public.user_notices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('purchase', 'gift')),
  items       jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  expires_at  timestamptz,
  ref         text not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz
);
create unique index if not exists user_notices_ref_uq on public.user_notices (user_id, ref);
create index if not exists user_notices_unseen_idx on public.user_notices (user_id) where seen_at is null;
alter table public.user_notices enable row level security;
revoke all on public.user_notices from anon, authenticated, public;
grant select, insert, update, delete on public.user_notices to service_role;
comment on table public.user_notices is 'One-time pop-ups: purchase (Stripe) / gift (admin). Read and acknowledged only through get_my_notices / ack_my_notices.';

-- item list for plan/add-on ids, in display order
create or replace function public.kfp_notice_items(p_ids text[])
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind) order by p.kind desc, p.sort), '[]'::jsonb)
  from public.plans p where p.id = any (p_ids)
$$;
revoke all on function public.kfp_notice_items(text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- purchase notices: a subscription became active / trialing (or switched plan)
-- ---------------------------------------------------------------------
create or replace function public.kfp_subscription_notice()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.status in ('active', 'trialing')
     and (tg_op = 'INSERT' or old.status not in ('active', 'trialing') or old.plan_id is distinct from new.plan_id) then
    insert into public.user_notices (user_id, kind, items, expires_at, ref)
    values (new.user_id, 'purchase', public.kfp_notice_items(array[new.plan_id]), new.current_period_end,
            'sub:' || coalesce(new.provider_subscription_id, new.id::text) || ':' || new.plan_id)
    on conflict (user_id, ref) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.kfp_subscription_notice() from public, anon, authenticated;
drop trigger if exists subscriptions_notice on public.subscriptions;
create trigger subscriptions_notice after insert or update of status, plan_id on public.subscriptions
for each row execute procedure public.kfp_subscription_notice();

-- ---------------------------------------------------------------------
-- admin: change plan (keeps add-on grants) + gift notice
-- ---------------------------------------------------------------------
create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_expires_at timestamptz, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_before jsonb; v_after jsonb; n int; had boolean;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  if p_plan not in ('free', 'plus', 'premium') then raise exception 'invalid_plan' using errcode = '22023'; end if;
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '10 years') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  v_before := public.kfp_access_snapshot(p_user);
  had := exists (select 1 from public.user_entitlements e where e.user_id = p_user and e.revoked_at is null and e.plan_id = p_plan
                   and e.reason <> 'staff' and (e.expires_at is null or e.expires_at > now()));
  -- replace every granted PLAN (admin grants + legacy launch); add-on grants and staff access stay
  update public.user_entitlements e set revoked_at = now(), revoked_by = me
  from public.plans p
  where e.user_id = p_user and e.revoked_at is null and e.reason <> 'staff' and p.id = e.plan_id and p.kind = 'plan';
  get diagnostics n = row_count;
  if p_plan <> 'free' then
    insert into public.user_entitlements (user_id, plan_id, expires_at, reason, note, granted_by)
    values (p_user, p_plan, p_expires_at, 'admin_grant', left(p_reason, 500), me);
    if not had then
      insert into public.user_notices (user_id, kind, items, expires_at, ref, created_by)
      values (p_user, 'gift', public.kfp_notice_items(array[p_plan]), p_expires_at, 'gift:' || gen_random_uuid(), me);
    end if;
  end if;
  v_after := public.kfp_access_snapshot(p_user);
  perform public.kfp_audit(case when p_plan = 'free' then 'plan.revoke_all' else 'plan.grant' end,
    p_user, 'user_entitlements', null, v_before,
    v_after || jsonb_build_object('requested_plan', p_plan, 'expires_at', p_expires_at, 'replaced', n), p_reason);
  return v_after;
end;
$$;
revoke all on function public.admin_set_plan(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, timestamptz, text) to authenticated;

-- admin: the member's admin-granted add-ons become exactly p_addons (empty = remove all granted add-ons)
create or replace function public.admin_set_addons(p_user uuid, p_addons text[], p_expires_at timestamptz, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_before jsonb; v_after jsonb; want text[]; prev text[]; fresh text[]; bad text; n int;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  want := coalesce((select array_agg(distinct x) from unnest(coalesce(p_addons, '{}')) x where x is not null and x <> ''), '{}');
  select x into bad from unnest(want) x
  where not exists (select 1 from public.plans p where p.id = x and p.kind = 'addon' and p.active) limit 1;
  if bad is not null then raise exception 'invalid_addon' using errcode = '22023'; end if;
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '10 years') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  v_before := public.kfp_access_snapshot(p_user);
  prev := coalesce((select array_agg(distinct e.plan_id) from public.user_entitlements e join public.plans p on p.id = e.plan_id and p.kind = 'addon'
                    where e.user_id = p_user and e.revoked_at is null and e.reason <> 'staff' and (e.expires_at is null or e.expires_at > now())), '{}');
  update public.user_entitlements e set revoked_at = now(), revoked_by = me
  from public.plans p
  where e.user_id = p_user and e.revoked_at is null and e.reason <> 'staff' and p.id = e.plan_id and p.kind = 'addon';
  get diagnostics n = row_count;
  insert into public.user_entitlements (user_id, plan_id, expires_at, reason, note, granted_by)
  select p_user, x, p_expires_at, 'admin_grant', left(p_reason, 500), me from unnest(want) x;
  fresh := coalesce((select array_agg(x) from unnest(want) x where not (x = any (prev))), '{}');
  if cardinality(fresh) > 0 then
    insert into public.user_notices (user_id, kind, items, expires_at, ref, created_by)
    values (p_user, 'gift', public.kfp_notice_items(fresh), p_expires_at, 'gift:' || gen_random_uuid(), me);
  end if;
  v_after := public.kfp_access_snapshot(p_user);
  perform public.kfp_audit('addon.set', p_user, 'user_entitlements', null, v_before,
    v_after || jsonb_build_object('addons', to_jsonb(want), 'expires_at', p_expires_at, 'replaced', n), p_reason);
  return v_after;
end;
$$;
revoke all on function public.admin_set_addons(uuid, text[], timestamptz, text) from public, anon;
grant execute on function public.admin_set_addons(uuid, text[], timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------
-- member: unseen notices (last 30 days) + acknowledge
-- ---------------------------------------------------------------------
create or replace function public.get_my_notices()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'items', n.items, 'expires_at', n.expires_at, 'created_at', n.created_at)
                            order by n.created_at), '[]'::jsonb)
  from public.user_notices n
  where n.user_id = auth.uid() and n.seen_at is null and n.created_at > now() - interval '30 days'
$$;
revoke all on function public.get_my_notices() from public, anon;
grant execute on function public.get_my_notices() to authenticated;

create or replace function public.ack_my_notices(p_ids uuid[])
returns integer
language plpgsql volatile security definer
set search_path = public
as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.user_notices set seen_at = now()
  where user_id = auth.uid() and seen_at is null and id = any (coalesce(p_ids, '{}'));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.ack_my_notices(uuid[]) from public, anon;
grant execute on function public.ack_my_notices(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- security self-check: allowlist the new member/admin RPCs
-- ---------------------------------------------------------------------
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
                           'admin_activity_analytics', 'admin_user_activity', 'export_my_gold', 'admin_set_role',
                           -- Smart Credit & Debt (migration 1700)
                           'get_my_debt_access', 'export_my_debt', 'debt_save_card', 'debt_set_card_status', 'debt_delete_card',
                           'debt_save_installment', 'debt_set_installment_status', 'debt_delete_installment', 'debt_confirm_schedule',
                           'debt_record_payment', 'debt_cancel_payment', 'debt_save_transfer', 'debt_set_transfer_status',
                           'debt_delete_transfer', 'debt_add_adjustment', 'debt_cancel_adjustment',
                           'debt_save_payoff_plan', 'debt_delete_payoff_plan',
                           'admin_set_addons', 'get_my_notices', 'ack_my_notices'];
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
