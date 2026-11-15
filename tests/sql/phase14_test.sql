-- Phase 14 tests: Free limits / "planning" feature, admin_set_plan really replaces granted plans.
-- Runs after phase10 + phase13 in the same database (uses their b1000000-… users).
\set ON_ERROR_STOP on
\echo '== apply migration 1500 (twice: re-runnable)'
\ir ../../supabase/migrations/20261115001500_free_limits_set_plan.sql
\ir ../../supabase/migrations/20261115001500_free_limits_set_plan.sql

\echo '== P14-T1 plans: planning feature + Free count limits'
do $$ begin
  assert (select (features->>'planning')::boolean from public.plans where id = 'free') = false, 'free: no planning';
  assert (select (features->>'planning')::boolean from public.plans where id = 'plus'), 'plus: planning';
  assert (select (features->>'planning')::boolean from public.plans where id = 'premium'), 'premium: planning';
  assert (select (limits->>'salary_records_max')::int from public.plans where id = 'free') = 3, 'free salary max 3';
  assert (select (limits->>'expense_items_max')::int from public.plans where id = 'free') = 10, 'free expense max 10';
  assert (select limits->'salary_history_months' from public.plans where id = 'free') = 'null'::jsonb, 'free month window removed';
  assert (select limits->>'salary_records_max' from public.plans where id = 'plus') is null, 'plus unlimited';
  assert (select (limits->>'grace_days')::int from public.plans where id = 'plus') = 7, 'other limits kept';
end $$;

\echo '== P14-T2 member sees the new limits in get_my_entitlements'
do $$ declare j jsonb; begin
  perform public.test_login('b1000000-0000-0000-0000-000000000009');
  j := public.get_my_entitlements();
  reset role;
  if j->>'plan' = 'free' then
    assert (j->'limits'->>'expense_items_max')::int = 10 and (j->'features'->>'planning')::boolean = false, 'free member payload';
  end if;
end $$;

\echo '== P14-T3 legacy Premium + admin "set Plus" → member is on Plus'
update public.user_entitlements set revoked_at = now() where user_id = 'b1000000-0000-0000-0000-000000000010' and revoked_at is null;
update public.profiles set suspended_at = null where user_id = 'b1000000-0000-0000-0000-000000000010';
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values ('b1000000-0000-0000-0000-000000000010', 'premium', now() + interval '60 days', 'legacy_launch') on conflict do nothing;
update public.user_entitlements set revoked_at = null, revoked_by = null, expires_at = now() + interval '60 days' where user_id = 'b1000000-0000-0000-0000-000000000010' and reason = 'legacy_launch';
do $$ begin
  assert (select plan_id from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000010')) = 'premium', 'starts on legacy premium';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000002');
select public.admin_set_plan('b1000000-0000-0000-0000-000000000010', 'plus', null, 'ทดสอบ plus') is not null;
reset role;
do $$ declare e record; begin
  select * into e from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000010');
  assert e.plan_id = 'plus' and e.source = 'admin_grant', 'now plus: ' || e.plan_id || ' ' || e.source;
  assert (select count(*) from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000010' and revoked_at is null) = 1, 'one active grant';
  assert (select plan_id from public.kfp_effective_plans_all() where user_id = 'b1000000-0000-0000-0000-000000000010') = 'plus', 'list agrees';
  assert (select (after->>'replaced')::int from public.admin_audit_logs where target_user_id = 'b1000000-0000-0000-0000-000000000010'
          order by created_at desc limit 1) = 1, 'audit shows replaced grant';
end $$;

\echo '== P14-T4 set Free keeps the staff grant (staff access follows the role)'
select public.test_login('b1000000-0000-0000-0000-000000000001');
select public.admin_set_role('b1000000-0000-0000-0000-000000000010', 'viewer', 'ทดสอบ staff') is not null;
select public.admin_set_plan('b1000000-0000-0000-0000-000000000010', 'free', null, 'ทดสอบ free') is not null;
reset role;
do $$ declare e record; begin
  select * into e from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000010');
  assert e.plan_id = 'premium' and e.source = 'staff', 'staff grant kept';
  assert (select count(*) from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000010' and revoked_at is null and reason = 'admin_grant') = 0, 'admin grant revoked';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000001');
select public.admin_set_role('b1000000-0000-0000-0000-000000000010', 'none', 'ถอด staff') is not null;
reset role;
do $$ begin
  assert (select plan_id from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000010')) = 'free', 'back to free';
end $$;

\echo '== ALL PHASE 14 SQL TESTS PASSED'
