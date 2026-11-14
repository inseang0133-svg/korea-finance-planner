-- Phase 5 tests: plan resolution matrix + server-side feature enforcement.
-- Runs after phase2_test.sql in the same database (see tests/run-sql-tests.sh).
\set ON_ERROR_STOP on
\echo '== apply migration 0400 (twice: re-runnable)'
\ir ../../supabase/migrations/20261113000400_entitlements.sql
\ir ../../supabase/migrations/20261113000400_entitlements.sql

-- ---------- users ----------
insert into auth.users (id, email, email_confirmed_at) values
 ('a0000000-0000-0000-0000-000000000001','free@x.com',now()),
 ('a0000000-0000-0000-0000-000000000002','plus@x.com',now()),
 ('a0000000-0000-0000-0000-000000000003','premcancel@x.com',now()),
 ('a0000000-0000-0000-0000-000000000004','plusexpired@x.com',now()),
 ('a0000000-0000-0000-0000-000000000005','pdgrace@x.com',now()),
 ('a0000000-0000-0000-0000-000000000006','pdover@x.com',now()),
 ('a0000000-0000-0000-0000-000000000007','unpaid@x.com',now()),
 ('a0000000-0000-0000-0000-000000000008','canceled@x.com',now()),
 ('a0000000-0000-0000-0000-000000000009','trial@x.com',now()),
 ('a0000000-0000-0000-0000-000000000010','incomplete@x.com',now()),
 ('a0000000-0000-0000-0000-000000000011','mix@x.com',now()),
 ('a0000000-0000-0000-0000-000000000012','oldgrant@x.com',now()),
 ('a0000000-0000-0000-0000-000000000013','susp@x.com',now()),
 ('a0000000-0000-0000-0000-000000000014','premium@x.com',now());

insert into public.subscriptions (user_id, plan_id, status, cancel_at_period_end, current_period_start, current_period_end, billing_interval, currency, provider_subscription_id) values
 ('a0000000-0000-0000-0000-000000000002','plus',   'active',   false, now()-interval '10 days', now()+interval '20 days','month','THB','sub_2'),
 ('a0000000-0000-0000-0000-000000000003','premium','active',   true,  now()-interval '27 days', now()+interval '3 days', 'month','KRW','sub_3'),
 ('a0000000-0000-0000-0000-000000000004','plus',   'active',   false, now()-interval '40 days', now()-interval '10 days','month','THB','sub_4'),
 ('a0000000-0000-0000-0000-000000000005','plus',   'past_due', false, now()-interval '3 days',  now()+interval '27 days','month','THB','sub_5'),
 ('a0000000-0000-0000-0000-000000000006','plus',   'past_due', false, now()-interval '10 days', now()+interval '20 days','month','THB','sub_6'),
 ('a0000000-0000-0000-0000-000000000007','premium','unpaid',   false, now()-interval '20 days', now()+interval '10 days','month','THB','sub_7'),
 ('a0000000-0000-0000-0000-000000000008','premium','canceled', false, now()-interval '5 days',  now()+interval '25 days','month','THB','sub_8'),
 ('a0000000-0000-0000-0000-000000000009','premium','trialing', false, now()-interval '2 days',  now()+interval '5 days', 'month','THB','sub_9'),
 ('a0000000-0000-0000-0000-000000000010','plus',   'incomplete',false,now(),                    now()+interval '30 days','month','THB','sub_10'),
 ('a0000000-0000-0000-0000-000000000011','plus',   'active',   false, now()-interval '1 day',   now()+interval '29 days','year', 'KRW','sub_11'),
 ('a0000000-0000-0000-0000-000000000013','plus',   'active',   false, now()-interval '1 day',   now()+interval '29 days','month','THB','sub_13'),
 ('a0000000-0000-0000-0000-000000000014','premium','active',   false, now()-interval '1 day',   now()+interval '29 days','month','THB','sub_14');
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values
 ('a0000000-0000-0000-0000-000000000011','premium', now()+interval '5 days', 'admin_grant'),
 ('a0000000-0000-0000-0000-000000000012','premium', now()-interval '1 day',  'admin_grant');
update public.profiles set suspended_at = now() where user_id = 'a0000000-0000-0000-0000-000000000013';

\echo '== P5-T1 plan resolution matrix'
do $$
declare r record;
  exp text[][] := array[
    ['01','free','default'], ['02','plus','subscription:stripe'], ['03','premium','subscription:stripe'],
    ['04','free','default'], ['05','plus','subscription:stripe'], ['06','free','default'],
    ['07','free','default'], ['08','free','default'], ['09','premium','subscription:stripe'],
    ['10','free','default'], ['11','premium','admin_grant'], ['12','free','default'],
    ['13','free','suspended'], ['14','premium','subscription:stripe']];
  i int;
begin
  for i in 1 .. array_length(exp, 1) loop
    select * into r from public.kfp_effective_plan(('a0000000-0000-0000-0000-0000000000' || exp[i][1])::uuid);
    assert r.plan_id = exp[i][2] and r.source = exp[i][3],
      format('user %s: expected %s/%s got %s/%s', exp[i][1], exp[i][2], exp[i][3], r.plan_id, r.source);
  end loop;
  -- cancel_at_period_end keeps access only until the period ends
  select valid_until into r from public.kfp_effective_plan('a0000000-0000-0000-0000-000000000003');
  assert r.valid_until between now() + interval '2 days' and now() + interval '4 days', 'valid until period end';
  -- past_due grace counted from period start (7 days for plus)
  select valid_until into r from public.kfp_effective_plan('a0000000-0000-0000-0000-000000000005');
  assert r.valid_until between now() + interval '3 days' and now() + interval '5 days', 'grace ends 7 days after period start';
  -- legacy launch grant (from phase 2) still gives premium
  assert (select plan_id from public.kfp_effective_plan('11111111-1111-1111-1111-111111111111')) = 'premium', 'legacy 90-day premium';
end $$;

\echo '== P5-T2 revoking a grant falls back to the subscription; expiry falls back to free'
update public.user_entitlements set revoked_at = now() where user_id = 'a0000000-0000-0000-0000-000000000011';
do $$ begin
  assert (select plan_id from public.kfp_effective_plan('a0000000-0000-0000-0000-000000000011')) = 'plus', 'back to plus';
end $$;
update public.subscriptions set current_period_end = now() - interval '1 minute' where user_id = 'a0000000-0000-0000-0000-000000000002';
do $$ begin
  assert (select plan_id from public.kfp_effective_plan('a0000000-0000-0000-0000-000000000002')) = 'free', 'expired → free';
end $$;
update public.subscriptions set current_period_end = now() + interval '20 days' where user_id = 'a0000000-0000-0000-0000-000000000002';

\echo '== P5-T3 browser API only describes the caller'
select public.test_login('a0000000-0000-0000-0000-000000000002');
do $$ declare j jsonb; n int; begin
  j := public.get_my_entitlements();
  assert j->>'plan' = 'plus' and (j->'features'->>'work_records')::boolean and not (j->'features'->>'gold_portfolio')::boolean, 'plus entitlements: ' || j::text;
  assert (j->>'user_id')::uuid = auth.uid(), 'own entitlements';
  assert public.has_feature('cloud_sync') and not public.has_feature('gold_portfolio'), 'has_feature for caller';
  begin perform public.kfp_effective_plan('a0000000-0000-0000-0000-000000000014'); assert false, 'can resolve other user plan!';
  exception when insufficient_privilege then null; end;
  begin perform public.kfp_has_feature('a0000000-0000-0000-0000-000000000014', 'gold_portfolio'); assert false, 'can check other user!';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.subscriptions; assert n = 1, 'sees only own subscription';
  begin insert into public.subscriptions (user_id, plan_id, status) values (auth.uid(), 'premium', 'active'); assert false, 'can insert subscription!';
  exception when insufficient_privilege then null; end;
  begin update public.subscriptions set plan_id = 'premium' where user_id = auth.uid(); assert false, 'can upgrade itself!';
  exception when insufficient_privilege then null; end;
  begin update public.plans set features = features || '{"gold_portfolio":true}' where id = 'plus'; assert false, 'can edit plan features!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login(null);
do $$ begin
  begin perform public.get_my_entitlements(); assert false, 'anon got entitlements!';
  exception when insufficient_privilege then null; end;
  begin perform public.has_feature('gold_portfolio'); assert false, 'anon has_feature!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P5-T4 Cloud Sync enforced by RLS (free cannot write, can still read/download)'
insert into public.user_data (user_id, data) values ('a0000000-0000-0000-0000-000000000001', '{"salary":"1"}');   -- pre-existing row (as owner)
select public.test_login('a0000000-0000-0000-0000-000000000001');
do $$ declare n int; begin
  begin
    insert into public.user_data (user_id, data) values (auth.uid(), '{"salary":"2"}')
    on conflict (user_id) do update set data = excluded.data;
    assert false, 'free user uploaded to cloud!';
  exception when insufficient_privilege then null; end;
  begin update public.user_data set data = '{"salary":"3"}' where user_id = auth.uid(); assert false, 'free user updated cloud!';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.user_data where data->>'salary' = '1'; assert n = 1, 'free user can still read own cloud data';
end $$;
reset role;

\echo '== P5-T5 gold keys: Plus can sync but cannot add/change/remove gold; Premium can'
select public.test_login('a0000000-0000-0000-0000-000000000002');   -- plus
insert into public.user_data (user_id, data) values (auth.uid(), '{"salary":"5","kfp_gold_lots_v1":"[1,2,3]"}')
on conflict (user_id) do update set data = excluded.data;
reset role;
do $$ begin
  assert (select data from public.user_data where user_id='a0000000-0000-0000-0000-000000000002') = '{"salary":"5"}'::jsonb, 'plus cannot add gold keys';
end $$;
update public.user_data set data = data || '{"kfp_gold_lots_v1":"[\"old\"]","kfp_gold_settings_v1":"{}"}' where user_id='a0000000-0000-0000-0000-000000000002';  -- as owner (e.g. data from before a downgrade)
select public.test_login('a0000000-0000-0000-0000-000000000002');
insert into public.user_data (user_id, data) values (auth.uid(), '{"salary":"6","kfp_gold_lots_v1":"[\"hacked\"]"}')
on conflict (user_id) do update set data = excluded.data;
update public.user_data set data = '{"salary":"7"}' where user_id = auth.uid();
reset role;
do $$ declare d jsonb; begin
  d := (select data from public.user_data where user_id='a0000000-0000-0000-0000-000000000002');
  assert d->>'salary' = '7', 'plus can sync other data';
  assert d->>'kfp_gold_lots_v1' = '["old"]' and d ? 'kfp_gold_settings_v1', 'existing gold data kept, not changed nor removed: ' || d::text;
end $$;
select public.test_login('a0000000-0000-0000-0000-000000000014');   -- premium
insert into public.user_data (user_id, data) values (auth.uid(), '{"kfp_gold_lots_v1":"[\"mine\"]"}')
on conflict (user_id) do update set data = excluded.data;
reset role;
do $$ begin
  assert (select data->>'kfp_gold_lots_v1' from public.user_data where user_id='a0000000-0000-0000-0000-000000000014') = '["mine"]', 'premium can write gold';
end $$;

\echo '== P5-T6 indexes exist for scale'
do $$ begin
  assert exists (select 1 from pg_indexes where indexname = 'subscriptions_user_idx'), 'subscriptions_user_idx';
  assert exists (select 1 from pg_indexes where indexname = 'user_entitlements_user_idx'), 'user_entitlements_user_idx';
end $$;
\echo '== ALL PHASE 5 SQL TESTS PASSED'
