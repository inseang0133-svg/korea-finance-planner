-- Phase 11 tests: activity tracking (throttled), daily rollup, analytics, retention, scale.
-- Runs after phase2…phase10 in the same database (tests/run-sql-tests.sh).
\set ON_ERROR_STOP on
\echo '== apply migration 1000 (twice: re-runnable)'
\ir ../../supabase/migrations/20261114001000_activity_analytics.sql
\ir ../../supabase/migrations/20261114001000_activity_analytics.sql

create or replace function public.t11_q(q text) returns text language plpgsql security definer set search_path = public as $$
declare r text; begin execute q into r; return r; end $$;
grant execute on function public.t11_q(text) to authenticated;

insert into auth.users (id, email, email_confirmed_at, created_at) values
 ('c1000000-0000-0000-0000-000000000001','track@p11.test', now(), now() - interval '20 days'),
 ('c1000000-0000-0000-0000-000000000002','viewer@p11.test',now(), now() - interval '200 days'),
 ('c1000000-0000-0000-0000-000000000003','payer@p11.test', now(), now() - interval '90 days'),
 ('c1000000-0000-0000-0000-000000000004','new@p11.test',   now(), now() - interval '1 hour');
insert into public.admin_roles (user_id, role) values ('c1000000-0000-0000-0000-000000000002', 'viewer');
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id)
values ('c1000000-0000-0000-0000-000000000003','premium','active', now()-interval '3 days', now()+interval '27 days','year','KRW', 89000, 'sub_p11_3');
update public.profiles set last_active_at = now() - interval '20 days' where user_id = 'c1000000-0000-0000-0000-000000000003';

\echo '== P11-T1 heartbeat throttling: not every call writes'
select public.test_login('c1000000-0000-0000-0000-000000000001');
do $$ declare d record; n int; i int; uid uuid := auth.uid(); q text := 'select count(*) from public.user_activity where user_id = ''c1000000-0000-0000-0000-000000000001'''; begin
  perform public.touch_activity('index.html', 'login');
  select * into d from public.user_activity_daily where user_id = uid and day = public.kfp_seoul_day();
  assert d.events = 1 and d.pages = '{"index.html": 1}'::jsonb, 'first touch → daily row: ' || coalesce(d.pages::text, 'none');
  for i in 1..100 loop perform public.touch_activity('index.html', 'heartbeat'); end loop;
  n := public.t11_q(q)::int;
  assert n = 1, '100 quick heartbeats on the same page → still 1 raw row (' || n || ')';
  select * into d from public.user_activity_daily where user_id = uid and day = public.kfp_seoul_day();
  assert d.events = 1, 'daily not bumped by throttled calls';
  perform public.touch_activity('gold.html', 'page');
  select * into d from public.user_activity_daily where user_id = uid and day = public.kfp_seoul_day();
  assert d.events = 2 and (d.pages->>'gold.html')::int = 1 and public.t11_q('select last_page from public.profiles where user_id = ''' || uid || '''') = 'gold.html', 'page change recorded + last visited page';
  -- feature usage: once per 30 min per feature, does not overwrite the last page
  perform public.touch_activity('work_records', 'feature');
  perform public.touch_activity('work_records', 'feature');
  perform public.touch_activity('Export', 'feature');
  perform public.touch_activity('<script>', 'feature');
  perform public.touch_activity('!!!', 'feature');
  select * into d from public.user_activity_daily where user_id = uid and day = public.kfp_seoul_day();
  assert d.features = '{"export": 1, "script": 1, "work_records": 1}'::jsonb, 'features counted once, sanitised: ' || d.features::text;
  assert public.t11_q('select last_page from public.profiles where user_id = ''' || uid || '''') = 'gold.html', 'feature does not change last page';
  begin perform public.touch_activity('index.html', 'hack'); exception when others then assert false, 'bad kind should be coerced'; end;
end $$;
reset role;
-- time passes (6 minutes) → the next heartbeat writes again
update public.user_activity set created_at = created_at - interval '6 minutes' where user_id = 'c1000000-0000-0000-0000-000000000001';
update public.profiles set last_active_at = now() - interval '6 minutes' where user_id = 'c1000000-0000-0000-0000-000000000001';
select public.test_login('c1000000-0000-0000-0000-000000000001');
do $$ declare d record; begin
  perform public.touch_activity('gold.html', 'heartbeat');
  select * into d from public.user_activity_daily where user_id = auth.uid() and day = public.kfp_seoul_day();
  assert d.events = 6 and (d.pages->>'gold.html')::int = 2, 'after 6 min the heartbeat counts (5 earlier events incl. 3 features): events=' || d.events;
  assert (select count(*) from public.user_activity_daily) = 1, 'member sees only own daily rows';
  begin perform public.admin_activity_analytics('{}'); assert false, 'member read analytics'; exception when insufficient_privilege then null; end;
  begin perform public.admin_user_activity(auth.uid(), 30); assert false, 'member read user activity'; exception when insufficient_privilege then null; end;
  begin insert into public.user_activity_daily (user_id, day) values (auth.uid(), current_date - 1); assert false, 'member wrote daily'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- junk page names cannot bloat the daily row
select public.test_login('c1000000-0000-0000-0000-000000000001');
do $$ declare i int; k int; begin
  for i in 1..80 loop perform public.touch_activity('junk' || i || '.html', 'page'); end loop;
  select count(*) into k from public.user_activity_daily d, jsonb_object_keys(d.pages) where d.user_id = auth.uid() and d.day = public.kfp_seoul_day();
  assert k <= 60, 'pages capped at 60 keys (' || k || ')';
end $$;
reset role;
select public.test_login(null);
do $$ begin
  begin perform public.touch_activity('index.html', 'page'); assert false, 'anon touched'; exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P11-T2 analytics (viewer): DAU/WAU/MAU, series, buckets, features, retention, at-risk'
-- history for the tracked member: active on 10 of the last 20 days; payer active 20 days ago only
insert into public.user_activity_daily (user_id, day, first_at, last_at, events, pages, features)
select 'c1000000-0000-0000-0000-000000000001', public.kfp_seoul_day() - g, now() - g * interval '1 day', now() - g * interval '1 day' + interval '30 minutes', 6,
       '{"index.html": 4, "gold.html": 2}', case when g % 2 = 0 then '{"expenses": 1}'::jsonb else '{}'::jsonb end
from generate_series(2, 20, 2) g on conflict do nothing;
insert into public.user_activity_daily (user_id, day, events, pages) values ('c1000000-0000-0000-0000-000000000003', public.kfp_seoul_day() - 20, 3, '{"gold.html": 3}')
on conflict do nothing;
select public.test_login('c1000000-0000-0000-0000-000000000002');
create temp table an as select public.admin_activity_analytics('{"days":30,"refresh":true}') as res;
create temp table ua as select public.admin_user_activity('c1000000-0000-0000-0000-000000000001', 30) as res;
reset role;
do $$ declare a jsonb := (select res from an); t jsonb; begin
  assert (a->>'days')::int = 30 and jsonb_array_length(a->'series') = 30, '30-day series';
  assert (a->'kpi'->>'dau')::int = (select count(*) from public.user_activity_daily where day = public.kfp_seoul_day()), 'DAU today';
  assert (a->'kpi'->>'mau')::int = (select count(distinct user_id) from public.user_activity_daily where day > public.kfp_seoul_day() - 30), 'MAU';
  assert (a->'kpi'->>'wau')::int <= (a->'kpi'->>'mau')::int and (a->'kpi'->>'dau')::int <= (a->'kpi'->>'wau')::int, 'DAU ≤ WAU ≤ MAU';
  assert (a->'series'->-1->>'signups')::int >= 1 and (a->'series'->-1->>'day')::date = public.kfp_seoul_day(), 'today signups in series';
  assert (select sum(value::int) from jsonb_each_text(a->'buckets')) = (select count(*) from public.profiles), 'buckets cover every member';
  assert (select sum((x->>'users')::int) from jsonb_array_elements(a->'buckets_by_plan') x) = (select count(*) from public.profiles), 'bucket × plan covers every member';
  assert exists (select 1 from jsonb_array_elements(a->'pages') x where x->>'page' = 'index.html' and (x->>'views')::int >= 40), 'top pages';
  assert exists (select 1 from jsonb_array_elements(a->'features') x where x->>'feature' = 'expenses' and (x->>'users')::int >= 1 and (x->>'adoption_pct')::numeric > 0), 'feature adoption';
  assert jsonb_array_length(a->'hours') = 24 and jsonb_array_length(a->'weekdays') = 7, 'hour/weekday distribution';
  assert jsonb_array_length(a->'retention') between 1 and 8, 'weekly cohorts (≤ 8)';
  t := (select x from jsonb_array_elements(a->'retention') x order by x->>'week' desc limit 1);
  assert t->'w1' = 'null'::jsonb, 'current week cohort has no week-1 value yet';
  assert exists (select 1 from jsonb_array_elements(a->'at_risk') x where x->>'email' = 'payer@p11.test' and (x->>'days_inactive')::int = 20 and (x->>'mrr_minor')::int = 7417),
     'paying member inactive 20 days is "at risk" (MRR ₩89,000/12)';
  t := (select res from ua);
  assert jsonb_array_length(t->'daily') = 30 and (t->>'active_days')::int = 11, 'user strip: 30 days, 11 active (' || (t->>'active_days') || ')';
  assert (t->'pages'->>'index.html')::int >= 40 and t->'features' ? 'expenses', 'user top pages/features';
end $$;

select public.test_login('c1000000-0000-0000-0000-000000000002');
do $$ declare r jsonb; begin
  r := public.admin_activity_analytics('{"days":30}');
  assert (r->>'cached')::boolean, 'cached within 10 minutes';
  begin perform 1 from public.admin_analytics_cache; assert false, 'cache table readable'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_compute_activity_analytics('{}'); assert false, 'compute callable'; exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P11-T3 retention job (service_role only)'
insert into public.user_activity (user_id, kind, page, created_at) values ('c1000000-0000-0000-0000-000000000001', 'page', 'old.html', now() - interval '100 days');
insert into public.user_activity_daily (user_id, day, events) values ('c1000000-0000-0000-0000-000000000001', public.kfp_seoul_day() - 500, 1);
select public.test_login('c1000000-0000-0000-0000-000000000002');
do $$ begin
  begin perform public.kfp_activity_maintenance(); assert false, 'browser ran maintenance'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ declare r jsonb; begin
  r := public.kfp_activity_maintenance();
  assert (r->>'raw_deleted')::int >= 1 and (r->>'daily_deleted')::int >= 1, 'pruned: ' || r::text;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.user_activity where page = 'old.html'), 'raw > 90 days removed';
  assert exists (select 1 from public.user_activity_daily where user_id = 'c1000000-0000-0000-0000-000000000001' and day = public.kfp_seoul_day() - 20), 'recent daily kept';
end $$;

\echo '== P11-T4 scale: 50,000 members × 30 days of activity (rolled back)'
begin;
insert into auth.users (id, email, email_confirmed_at, created_at)
select gen_random_uuid(), 'act' || i || '@scale.test', now(), now() - (i % 400) * interval '1 day' from generate_series(1, 50000) i;
insert into public.user_activity_daily (user_id, day, events, pages, features)
select p.user_id, public.kfp_seoul_day() - g, 1 + (random() * 20)::int, '{"index.html": 3, "gold.html": 1}', '{"expenses": 1}'
from public.profiles p cross join generate_series(0, 29) g
where p.email like '%@scale.test' and random() < 0.2;
insert into public.user_activity (user_id, kind, page, created_at)
select user_id, 'heartbeat', 'index.html', now() - random() * interval '30 days' from public.profiles where email like '%@scale.test' and random() < 0.5;
analyze;
select public.test_login('c1000000-0000-0000-0000-000000000002');
do $$ declare t0 timestamptz; ms numeric; ms2 numeric; ms3 numeric; r jsonb; begin
  t0 := clock_timestamp(); r := public.admin_activity_analytics('{"days":30,"refresh":true}'); ms := extract(epoch from clock_timestamp() - t0) * 1000;
  assert (r->'kpi'->>'mau')::int > 40000 and not (r->>'cached')::boolean, 'MAU over 50k members (fresh)';
  t0 := clock_timestamp(); r := public.admin_activity_analytics('{"days":30}'); ms2 := extract(epoch from clock_timestamp() - t0) * 1000;
  assert (r->>'cached')::boolean, 'second call served from the 10-minute cache';
  t0 := clock_timestamp(); r := public.admin_activity_analytics('{"days":180,"refresh":true}'); ms3 := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'P11 scale (50k users, 10k daily actives, ~300k daily rows): analytics fresh 30d % ms · cached % ms · fresh 180d % ms', round(ms), round(ms2), round(ms3);
  assert ms < 3000 and ms3 < 3000 and ms2 < 100, 'fresh under 3 s, cached under 0.1 s';
end $$;
reset role;
rollback;
drop function public.t11_q(text);
\echo '== ALL PHASE 11 SQL TESTS PASSED'
