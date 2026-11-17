-- Phase 17 tests: welcome notices (purchase / gift), admin add-on grants, plan change keeps add-ons.
-- Runs after phase 2–16. Users from phase 10: …001 owner, …002 admin, …010 member.
\set ON_ERROR_STOP on
\echo '== apply migration 1800 (twice: re-runnable)'
\ir ../../supabase/migrations/20261117001800_notices_addon_grants.sql
\ir ../../supabase/migrations/20261117001800_notices_addon_grants.sql

update public.user_entitlements set revoked_at = now() where user_id = 'b1000000-0000-0000-0000-000000000010' and revoked_at is null;
delete from public.user_notices where user_id = 'b1000000-0000-0000-0000-000000000010';

\echo '== P17-T1 admin gives Premium → one gift notice; giving the same plan again → no second notice'
select public.test_login('b1000000-0000-0000-0000-000000000002');
select public.admin_set_plan('b1000000-0000-0000-0000-000000000010', 'premium', null, 'ของขวัญ premium') is not null;
select public.admin_set_plan('b1000000-0000-0000-0000-000000000010', 'premium', now() + interval '30 days', 'ต่ออายุ') is not null;
reset role;
do $$ declare n record; begin
  assert (select count(*) from public.user_notices where user_id = 'b1000000-0000-0000-0000-000000000010') = 1, 'one gift notice';
  select * into n from public.user_notices where user_id = 'b1000000-0000-0000-0000-000000000010';
  assert n.kind = 'gift' and n.items->0->>'id' = 'premium' and n.items->0->>'name' = (select name from public.plans where id = 'premium'), 'gift premium item';
end $$;

\echo '== P17-T2 admin sets add-ons → granted, notice lists only the new ones'
select public.test_login('b1000000-0000-0000-0000-000000000002');
select public.admin_set_addons('b1000000-0000-0000-0000-000000000010', array['addon_gold', 'addon_cloud'], null, 'ของขวัญ add-on') is not null;
reset role;
do $$ begin
  assert (select count(*) from public.kfp_active_addons('b1000000-0000-0000-0000-000000000010')) = 2, 'two add-ons active';
  assert (select jsonb_array_length(items) from public.user_notices where user_id = 'b1000000-0000-0000-0000-000000000010' order by created_at desc limit 1) = 2, 'notice with 2 items';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000002');
select public.admin_set_addons('b1000000-0000-0000-0000-000000000010', array['addon_gold', 'addon_work'], now() + interval '30 days', 'เปลี่ยน add-on') is not null;
reset role;
do $$ declare n record; begin
  assert (select array_agg(addon_id order by addon_id) from public.kfp_active_addons('b1000000-0000-0000-0000-000000000010')) = array['addon_gold', 'addon_work'], 'exactly the new list';
  select * into n from public.user_notices where user_id = 'b1000000-0000-0000-0000-000000000010' order by created_at desc limit 1;
  assert jsonb_array_length(n.items) = 1 and n.items->0->>'id' = 'addon_work', 'only the newly added add-on is announced';
  assert (select action from public.admin_audit_logs where target_user_id = 'b1000000-0000-0000-0000-000000000010' order by created_at desc limit 1) = 'addon.set', 'audited';
end $$;

\echo '== P17-T3 changing the plan keeps add-on grants'
select public.test_login('b1000000-0000-0000-0000-000000000002');
select public.admin_set_plan('b1000000-0000-0000-0000-000000000010', 'plus', null, 'ลดเป็น plus') is not null;
reset role;
do $$ begin
  assert (select plan_id from public.kfp_effective_plan('b1000000-0000-0000-0000-000000000010')) = 'plus', 'now plus';
  assert (select count(*) from public.kfp_active_addons('b1000000-0000-0000-0000-000000000010')) = 2, 'add-ons kept';
end $$;

\echo '== P17-T4 validation + permissions'
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare got text; begin
  begin perform public.admin_set_addons('b1000000-0000-0000-0000-000000000010', array['premium'], null, 'ผิด'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_addon', 'a plan is not an add-on (' || got || ')';
  begin perform public.admin_set_addons('b1000000-0000-0000-0000-000000000010', array['addon_gold'], now() - interval '1 day', 'ผิด'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_expiry', 'past expiry refused';
end $$;
reset role;
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare got text; begin
  begin perform public.admin_set_addons('b1000000-0000-0000-0000-000000000010', array['addon_gold'], null, 'ให้ตัวเอง'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got <> 'ok', 'members cannot grant themselves add-ons';
  begin perform count(*) from public.user_notices; got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'no direct table access';
  begin insert into public.user_notices (user_id, kind, ref) values ('b1000000-0000-0000-0000-000000000010', 'gift', 'x'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'members cannot forge notices';
end $$;

\echo '== P17-T5 member reads own unseen notices, acknowledges them; others cannot ack'
do $$ declare j jsonb; ids uuid[]; begin
  j := public.get_my_notices();
  assert jsonb_array_length(j) = 4, 'four unseen notices: premium, 2 add-ons, add-on work, plus (' || jsonb_array_length(j) || ')';
  assert j->0->>'kind' = 'gift', 'oldest first';
  ids := array(select (x->>'id')::uuid from jsonb_array_elements(j) x);
  assert public.ack_my_notices(ids) = 4, 'acknowledged';
  assert jsonb_array_length(public.get_my_notices()) = 0, 'nothing left';
end $$;
reset role;

\echo '== P17-T6 Stripe subscription becoming active → one purchase notice (renewal/no-change → none)'
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id)
values ('b1000000-0000-0000-0000-000000000010', 'premium', 'incomplete', now(), now() + interval '30 days', 'month', 'THB', 19900, 'sub_p17');
do $$ begin
  assert (select count(*) from public.user_notices where ref like 'sub:sub_p17%') = 0, 'incomplete → no notice';
end $$;
update public.subscriptions set status = 'active' where provider_subscription_id = 'sub_p17';
update public.subscriptions set current_period_end = now() + interval '60 days' where provider_subscription_id = 'sub_p17';
update public.subscriptions set status = 'active' where provider_subscription_id = 'sub_p17';
do $$ declare n record; begin
  assert (select count(*) from public.user_notices where ref like 'sub:sub_p17%') = 1, 'exactly one purchase notice';
  select * into n from public.user_notices where ref like 'sub:sub_p17%';
  assert n.kind = 'purchase' and n.items->0->>'id' = 'premium', 'purchase premium';
end $$;
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id)
values ('b1000000-0000-0000-0000-000000000010', 'addon_gold', 'active', now(), now() + interval '30 days', 'month', 'THB', 6900, 'sub_p17_addon');
do $$ begin
  assert (select items->0->>'kind' from public.user_notices where ref like 'sub:sub_p17_addon%') = 'addon', 'add-on purchase notice';
end $$;
delete from public.subscriptions where provider_subscription_id in ('sub_p17', 'sub_p17_addon');

\echo '== P17-T7 security self-check'
select set_config('request.jwt.claims', '', false);
do $$ begin
  assert (select count(*) from public.kfp_security_report() where severity <> 'INFO') = 0,
    'security report: ' || coalesce((select string_agg(check_name || ' ' || object, '; ') from public.kfp_security_report() where severity <> 'INFO'), '');
end $$;

\echo '== ALL PHASE 17 SQL TESTS PASSED'
