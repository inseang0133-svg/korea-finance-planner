-- Phase 13 tests: staff roles (admin_set_role), unlimited staff grant, admin_role in get_my_entitlements.
-- Runs after phase10 in the same database (uses its b1000000-… users).
\set ON_ERROR_STOP on
\echo '== apply migration 1400 (twice: re-runnable)'
\ir ../../supabase/migrations/20261115001400_staff_roles.sql
\ir ../../supabase/migrations/20261115001400_staff_roles.sql

\echo '== P13-T1 existing staff got exactly one unlimited Premium grant'
do $$ begin
  assert (select count(*) from public.user_entitlements where reason = 'staff' and revoked_at is null
          and user_id = 'b1000000-0000-0000-0000-000000000001' and plan_id = 'premium' and expires_at is null) = 1, 'owner staff grant';
  assert (select count(*) from public.user_entitlements where reason = 'staff' and revoked_at is null
          and user_id = 'b1000000-0000-0000-0000-000000000003') = 1, 'viewer staff grant (not doubled by 2nd run)';
end $$;

\echo '== P13-T2 only the owner can set roles; viewer/admin/member are refused'
do $$
declare uid uuid; ok boolean;
begin
  foreach uid in array array['b1000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000005']::uuid[] loop
    perform public.test_login(uid);
    ok := false;
    begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000005', 'admin', 'test promote'); exception when insufficient_privilege then ok := true; end;
    reset role;
    assert ok, 'non-owner refused: ' || uid;
  end loop;
end $$;

\echo '== P13-T3 owner promotes a free member to viewer → unlimited Premium, read-only admin'
select public.test_login('b1000000-0000-0000-0000-000000000001');
select public.admin_set_role('b1000000-0000-0000-0000-000000000005', 'viewer', 'ทีมช่วยดูข้อมูล') is not null;
reset role;
do $$ declare e record; ok boolean; begin
  assert public.kfp_admin_role('b1000000-0000-0000-0000-000000000005') = 'viewer', 'role viewer';
  select * into e from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000005');
  assert e.plan_id = 'premium' and e.valid_until is null and e.source = 'staff', 'unlimited premium via staff';
  perform public.test_login('b1000000-0000-0000-0000-000000000005');
  assert (public.get_my_entitlements()->>'admin_role') = 'viewer', 'get_my_entitlements.admin_role';
  assert (public.admin_whoami()->>'can_write')::boolean = false, 'viewer cannot write';
  ok := false;
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000006', 'premium', null, 'viewer tries'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'viewer cannot change plans';
  ok := false;
  begin perform public.admin_set_price('plus', 'month', 'THB', 9900, 'viewer tries'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'viewer cannot change prices';
  assert public.admin_overview() is not null, 'viewer can read overview';
  reset role;
end $$;

\echo '== P13-T4 viewer → admin keeps one grant; admin can write but not change roles'
select public.test_login('b1000000-0000-0000-0000-000000000001');
select public.admin_set_role('b1000000-0000-0000-0000-000000000005', 'admin', 'เลื่อนเป็นแอดมิน') is not null;
reset role;
do $$ declare ok boolean; begin
  assert public.kfp_admin_role('b1000000-0000-0000-0000-000000000005') = 'admin', 'role admin';
  assert (select count(*) from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000005' and reason = 'staff' and revoked_at is null) = 1, 'one staff grant';
  perform public.test_login('b1000000-0000-0000-0000-000000000005');
  assert (public.admin_whoami()->>'can_write')::boolean, 'admin can write';
  ok := false;
  begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000006', 'viewer', 'admin tries'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'admin cannot set roles';
  reset role;
end $$;

\echo '== P13-T5 guards: self, owner target, bad role, short reason'
select public.test_login('b1000000-0000-0000-0000-000000000001');
do $$ declare ok boolean; begin
  ok := false; begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000001', 'viewer', 'self demote'); exception when insufficient_privilege then ok := true; end; assert ok, 'not self';
  ok := false; begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000006', 'owner', 'make owner'); exception when invalid_parameter_value then ok := true; end; assert ok, 'no owner via RPC';
  ok := false; begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000006', 'viewer', 'x'); exception when invalid_parameter_value then ok := true; end; assert ok, 'reason required';
end $$;
reset role;
insert into public.admin_roles (user_id, role) values ('b1000000-0000-0000-0000-000000000012', 'owner');
select public.test_login('b1000000-0000-0000-0000-000000000001');
do $$ declare ok boolean; begin
  ok := false; begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000012', 'none', 'remove other owner'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'cannot change another owner';
end $$;
reset role;
delete from public.admin_roles where user_id = 'b1000000-0000-0000-0000-000000000012';

\echo '== P13-T6 remove role → staff grant revoked, other grants kept, audit written'
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values ('b1000000-0000-0000-0000-000000000005', 'plus', now() + interval '10 days', 'admin_grant');
select public.test_login('b1000000-0000-0000-0000-000000000001');
select public.admin_set_role('b1000000-0000-0000-0000-000000000005', 'none', 'จบงานแล้ว') is not null;
reset role;
do $$ declare e record; begin
  assert public.kfp_admin_role('b1000000-0000-0000-0000-000000000005') is null, 'role removed';
  assert not exists (select 1 from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000005' and reason = 'staff' and revoked_at is null), 'staff grant revoked';
  select * into e from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000005');
  assert e.plan_id = 'plus', 'other grant still applies';
  assert (select count(*) from public.admin_audit_logs where action = 'role.set' and target_user_id = 'b1000000-0000-0000-0000-000000000005') = 3, 'three audit rows';
  assert (select after->>'role' from public.admin_audit_logs where action = 'role.set' and target_user_id = 'b1000000-0000-0000-0000-000000000005' order by id desc limit 1) is null, 'audit after.role null';
end $$;

\echo '== P13-T7 member (not staff) sees admin_role null; anon cannot call'
select public.test_login('b1000000-0000-0000-0000-000000000006');
do $$ begin assert (public.get_my_entitlements() ? 'admin_role') and public.get_my_entitlements()->'admin_role' = 'null'::jsonb, 'member admin_role null'; end $$;
reset role;
select public.test_login(null);
do $$ declare ok boolean := false; begin
  begin perform public.admin_set_role('b1000000-0000-0000-0000-000000000006', 'viewer', 'anon tries'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon refused';
end $$;
reset role;
\echo '== ALL PHASE 13 SQL TESTS PASSED'
