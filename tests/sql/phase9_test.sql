-- Phase 9 tests: gold portfolio in its own Premium-only table.
-- Runs after phase2…phase8 in the same database (tests/run-sql-tests.sh).
\set ON_ERROR_STOP on

-- ---------- users + legacy data BEFORE the migration ----------
insert into auth.users (id, email, email_confirmed_at) values
 ('a9000000-0000-0000-0000-000000000001','free9@x.com',now()),
 ('a9000000-0000-0000-0000-000000000002','plus9@x.com',now()),
 ('a9000000-0000-0000-0000-000000000003','prem9@x.com',now()),
 ('a9000000-0000-0000-0000-000000000004','pdgrace9@x.com',now()),
 ('a9000000-0000-0000-0000-000000000005','suspended9@x.com',now()),
 ('a9000000-0000-0000-0000-000000000006','broken9@x.com',now()),
 ('a9000000-0000-0000-0000-000000000007','grant9@x.com',now());
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, provider_subscription_id) values
 ('a9000000-0000-0000-0000-000000000002','plus',   'active',  now()-interval '1 day', now()+interval '29 days','month','THB','sub_p9_2'),
 ('a9000000-0000-0000-0000-000000000003','premium','active',  now()-interval '1 day', now()+interval '29 days','month','THB','sub_p9_3'),
 ('a9000000-0000-0000-0000-000000000004','premium','past_due',now()-interval '2 days',now()+interval '28 days','month','THB','sub_p9_4'),
 ('a9000000-0000-0000-0000-000000000005','premium','active',  now()-interval '1 day', now()+interval '29 days','month','THB','sub_p9_5');
update public.profiles set suspended_at = now() where user_id = 'a9000000-0000-0000-0000-000000000005';
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values ('a9000000-0000-0000-0000-000000000007','premium', now()+interval '60 days','legacy_launch');
-- user_data as the app stored it until Phase 8: raw localStorage strings
insert into public.user_data (user_id, data) values
 ('a9000000-0000-0000-0000-000000000001', '{"salary":"1","kfp_gold_lots_v1":"[{\"id\":\"f1\",\"grams\":15.2,\"costThb\":40000}]","kfp_gold_settings_v1":"{\"valuationSource\":\"market\"}"}'),
 ('a9000000-0000-0000-0000-000000000003', '{"salary":"3","kfp_gold_lots_v1":"[{\"id\":\"p1\",\"grams\":1,\"costThb\":3000},{\"id\":\"p2\",\"grams\":2,\"costThb\":6100}]"}'),
 ('a9000000-0000-0000-0000-000000000006', '{"salary":"6","kfp_gold_lots_v1":"[{broken json","kfp_gold_settings_v1":"{}"}');

\echo '== apply migration 0800 (twice: re-runnable)'
\ir ../../supabase/migrations/20261114000800_gold_premium.sql
\ir ../../supabase/migrations/20261114000800_gold_premium.sql

\echo '== P9-T1 migration: gold copied to user_gold_data, removed from user_data, nothing lost'
do $$ declare g public.user_gold_data; d jsonb; n int; begin
  select * into g from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000001';
  assert g.lots = '[{"id":"f1","grams":15.2,"costThb":40000}]'::jsonb and g.settings = '{"valuationSource":"market"}'::jsonb and g.version = 1, 'free user gold moved as real JSON: ' || coalesce(g.lots::text, 'null');
  select * into g from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000003';
  assert jsonb_array_length(g.lots) = 2 and g.settings = '{}'::jsonb, 'premium gold moved (no settings key → {})';
  assert (select data from public.user_data where user_id = 'a9000000-0000-0000-0000-000000000001') = '{"salary":"1"}'::jsonb, 'gold keys removed from user_data, other keys kept';
  select count(*) into n from public.user_data where data ?| array['kfp_gold_lots_v1','kfp_gold_settings_v1'];
  assert n = 0, 'no gold left in user_data (' || n || ')';
  -- Phase 5 test rows (plus user 0002 with "old" gold, premium 0014 with "mine") moved too
  assert (select lots from public.user_gold_data where user_id = 'a0000000-0000-0000-0000-000000000002') = '["old"]'::jsonb, 'phase-5 plus user gold kept';
  assert (select lots from public.user_gold_data where user_id = 'a0000000-0000-0000-0000-000000000014') = '["mine"]'::jsonb, 'phase-5 premium gold kept';
  -- unparseable value: raw copy kept, user_gold_data row with empty lots
  d := (select raw from public.user_gold_legacy_raw where user_id = 'a9000000-0000-0000-0000-000000000006');
  assert d->>'kfp_gold_lots_v1' = '[{broken json', 'broken JSON kept verbatim in user_gold_legacy_raw';
  assert (select lots from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000006') = '[]'::jsonb, 'broken → empty lots';
  assert (select data from public.user_data where user_id = 'a9000000-0000-0000-0000-000000000006') = '{"salary":"6"}'::jsonb, 'stripped after the raw copy';
  select count(*) into n from public.user_gold_data where user_id::text like 'a9000000-%';
  assert n = 3, 're-run created no duplicates (' || n || ')';
end $$;

\echo '== P9-T2 read: Premium only, checked on every call'
select public.test_login('a9000000-0000-0000-0000-000000000003');            -- premium
do $$ declare r jsonb; begin
  r := public.get_my_gold();
  assert (r->>'allowed')::boolean and (r->>'version')::int = 1 and jsonb_array_length(r->'lots') = 2, 'premium reads own gold: ' || r::text;
  assert (select count(*) from public.user_gold_data) = 1, 'RLS: premium sees only own row';
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000001');            -- free, has stored gold
do $$ declare r jsonb; begin
  r := public.get_my_gold();
  assert r = '{"allowed": false, "stored_lots": 1}'::jsonb, 'free: no content, only "1 lot kept": ' || r::text;
  assert (select count(*) from public.user_gold_data) = 0, 'RLS: free cannot select own gold row';
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000002');            -- plus
do $$ begin
  assert not (public.get_my_gold()->>'allowed')::boolean, 'plus: not allowed';
  assert (select count(*) from public.user_gold_data) = 0, 'plus: RLS hides rows';
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000005');            -- premium but suspended
do $$ begin assert not (public.get_my_gold()->>'allowed')::boolean, 'suspended premium: not allowed'; end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000004');            -- past_due within grace
do $$ declare r jsonb; begin
  r := public.get_my_gold();
  assert (r->>'allowed')::boolean and not (r->>'exists')::boolean and (r->>'version')::int = 0, 'past_due grace: allowed, nothing stored yet';
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000007');            -- legacy 90-day grant
do $$ begin assert (public.get_my_gold()->>'allowed')::boolean, 'legacy premium grant: allowed'; end $$;
reset role;
select public.test_login(null);
do $$ begin
  begin perform public.get_my_gold(); assert false, 'anon read gold!'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.user_gold_data; assert false, 'anon select table!'; exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P9-T3 write: Premium only, validated, versioned'
select public.test_login('a9000000-0000-0000-0000-000000000003');
do $$ declare r jsonb; begin
  r := public.save_my_gold('[{"id":"p1","grams":1,"costThb":3000}]', '{"valuationSource":"gold2go"}', 1);
  assert (r->>'ok')::boolean and (r->>'version')::int = 2, 'save with current base → version 2: ' || r::text;
  r := public.save_my_gold('[{"id":"p1","grams":1,"costThb":3000}]', '{"valuationSource":"gold2go"}', 2);
  assert (r->>'ok')::boolean and (r->>'version')::int = 2 and (r->>'unchanged')::boolean, 'same content → no new version';
  -- another device still on version 1 → conflict, gets the server copy back
  r := public.save_my_gold('[]', '{}', 1);
  assert r->>'error' = 'conflict' and (r->>'version')::int = 2 and jsonb_array_length(r->'lots') = 1, 'stale base → conflict + server copy: ' || r::text;
  assert (select version from public.user_gold_data where user_id = auth.uid()) = 2, 'conflict changed nothing';
  -- member chose "keep this device" → null base overwrites
  r := public.save_my_gold('[{"id":"x","grams":3,"costThb":9000,"note":"มือถือ"}]', '{}', null);
  assert (r->>'ok')::boolean and (r->>'version')::int = 3, 'forced overwrite → version 3';
  -- validation
  begin perform public.save_my_gold('{"id":1}', '{}', 3); assert false, 'object as lots accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold('[1,2]', '{}', 3); assert false, 'non-object lot accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold('[{"grams":1}]', '{}', 3); assert false, 'lot without id accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold('[{"id":"a","grams":"lots"}]', '{}', 3); assert false, 'string grams accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold('[{"id":"a","costThb":-5}]', '{}', 3); assert false, 'negative cost accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold('[]', '[]', 3); assert false, 'array settings accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold((select jsonb_agg(jsonb_build_object('id', 'l' || i)) from generate_series(1, 2001) i), '{}', 3);
        assert false, '2001 lots accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.save_my_gold('[]', jsonb_build_object('x', repeat('a', 20000)), 3); assert false, 'huge settings accepted'; exception when invalid_parameter_value then null; end;
  assert (select version from public.user_gold_data where user_id = auth.uid()) = 3, 'rejected writes changed nothing';
  -- no direct table writes, even for Premium
  begin insert into public.user_gold_data (user_id) values (auth.uid()); assert false, 'direct insert'; exception when insufficient_privilege then null; end;
  begin update public.user_gold_data set version = 99; assert false, 'direct update'; exception when insufficient_privilege then null; end;
  begin delete from public.user_gold_data; assert false, 'direct delete'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000004');            -- past_due grace: first save
do $$ declare r jsonb; begin
  r := public.save_my_gold('[{"id":"g1","grams":0.5,"costThb":1500,"buyFx":null}]', '{}', 0);
  assert (r->>'ok')::boolean and (r->>'version')::int = 1, 'first save with base 0 creates the row';
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000001');            -- free
do $$ begin
  begin perform public.save_my_gold('[]', '{}', null); assert false, 'free wrote gold!';
  exception when insufficient_privilege then
    assert sqlerrm = 'premium_required', 'error says premium_required: ' || sqlerrm;
  end;
end $$;
reset role;
select public.test_login('a9000000-0000-0000-0000-000000000002');            -- plus
do $$ begin
  begin perform public.save_my_gold('[]', '{}', null); assert false, 'plus wrote gold!'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select lots from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000001') = '[{"id":"f1","grams":15.2,"costThb":40000}]'::jsonb, 'free user data untouched';
end $$;

\echo '== P9-T4 old cached app still sending gold inside user_data'
select public.test_login('a9000000-0000-0000-0000-000000000003');            -- premium → routed to user_gold_data
update public.user_data set data = '{"salary":"33","kfp_gold_lots_v1":"[{\"id\":\"old-app\",\"grams\":1,\"costThb\":1}]","kfp_gold_settings_v1":"{}"}' where user_id = auth.uid();
reset role;
do $$ begin
  assert (select data from public.user_data where user_id = 'a9000000-0000-0000-0000-000000000003') = '{"salary":"33"}'::jsonb, 'user_data stays gold-free';
  assert (select lots->0->>'id' || '|' || version from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000003') = 'old-app|4', 'premium old app: routed, version bumped';
end $$;
select public.test_login('a9000000-0000-0000-0000-000000000002');            -- plus (cloud_sync ok, no gold)
insert into public.user_data (user_id, data) values (auth.uid(), '{"salary":"22","kfp_gold_lots_v1":"[{\"id\":\"sneaky\"}]"}')
on conflict (user_id) do update set data = excluded.data;
reset role;
do $$ begin
  assert (select data from public.user_data where user_id = 'a9000000-0000-0000-0000-000000000002') = '{"salary":"22"}'::jsonb, 'plus: gold stripped, rest saved';
  assert not exists (select 1 from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000002'), 'plus: nothing written to gold table';
end $$;

\echo '== P9-T5 downgrade keeps data hidden; upgrade shows it again'
update public.subscriptions set status = 'canceled', ended_at = now(), current_period_end = now() - interval '1 minute' where provider_subscription_id = 'sub_p9_3';
select public.test_login('a9000000-0000-0000-0000-000000000003');
do $$ begin
  assert public.get_my_gold() = '{"allowed": false, "stored_lots": 1}'::jsonb, 'after expiry: hidden, 1 lot kept';
  begin perform public.save_my_gold('[]', '{}', null); assert false, 'expired premium wrote'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.subscriptions set status = 'active', ended_at = null, current_period_end = now() + interval '30 days' where provider_subscription_id = 'sub_p9_3';
select public.test_login('a9000000-0000-0000-0000-000000000003');
do $$ declare r jsonb; begin
  r := public.get_my_gold();
  assert (r->>'allowed')::boolean and r->'lots'->0->>'id' = 'old-app' and (r->>'version')::int = 4, 're-subscribed: same data back';
end $$;
reset role;

\echo '== P9-T6 rate limit (120 saves / minute)'
select public.test_login('a9000000-0000-0000-0000-000000000004');
do $$ declare i int; ok_n int := 0; begin
  for i in 1..125 loop
    begin perform public.save_my_gold('[]', jsonb_build_object('n', i), null); ok_n := ok_n + 1;
    exception when sqlstate '54000' then exit; end;
  end loop;
  assert ok_n between 118 and 120, 'stopped at the limit (' || ok_n || ')';
end $$;
reset role;
delete from public.rate_limits where key like 'gold:a9000000-%';

\echo '== P9-T7 account deletion removes gold (cascade)'
delete from auth.users where id = 'a9000000-0000-0000-0000-000000000006';
do $$ begin
  assert not exists (select 1 from public.user_gold_data where user_id = 'a9000000-0000-0000-0000-000000000006')
     and not exists (select 1 from public.user_gold_legacy_raw where user_id = 'a9000000-0000-0000-0000-000000000006'), 'cascade';
end $$;
\echo '== ALL PHASE 9 SQL TESTS PASSED'
