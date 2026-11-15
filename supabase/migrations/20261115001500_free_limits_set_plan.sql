-- =====================================================================
-- Korea Finance Planner · Free plan limits + admin "change plan" fix (15/11/2026)
--
-- 1. Plans
--    • new feature "planning" (Korean work contract + savings goal): Plus / Premium only
--    • Free limits: at most 3 salary months, at most 10 expense items
--      (replaces the old "last 6 / 2 months" history window for Free)
-- 2. admin_set_plan(): the plan the admin picks now really becomes the member's plan.
--    Before: a legacy_launch Premium grant stayed active, so "set Plus" still showed Premium.
--    Now every active grant except the staff grant is revoked first. A paid Stripe
--    subscription is never touched here (cancel it from the drawer).
-- Additive, re-runnable.
-- =====================================================================

update public.plans
set features = features || jsonb_build_object('planning', id <> 'free'),
    limits = case when id = 'free'
                  then limits || '{"salary_records_max":3,"expense_items_max":10,"salary_history_months":null,"expense_history_months":null}'::jsonb
                  else limits || '{"salary_records_max":null,"expense_items_max":null}'::jsonb end
where id in ('free', 'plus', 'premium');

create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_expires_at timestamptz, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_before jsonb; v_after jsonb; n int;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  if p_plan not in ('free', 'plus', 'premium') then raise exception 'invalid_plan' using errcode = '22023'; end if;
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '10 years') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  v_before := public.kfp_access_snapshot(p_user);
  -- replace every granted plan (admin grants + legacy launch); staff access follows the role, not this button
  update public.user_entitlements set revoked_at = now(), revoked_by = me
  where user_id = p_user and revoked_at is null and reason <> 'staff';
  get diagnostics n = row_count;
  if p_plan <> 'free' then
    insert into public.user_entitlements (user_id, plan_id, expires_at, reason, note, granted_by)
    values (p_user, p_plan, p_expires_at, 'admin_grant', left(p_reason, 500), me);
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
