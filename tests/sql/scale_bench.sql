-- Phase 12 · scale benchmark: 100 / 1,000 / 10,000 / 50,000 members (everything rolled back).
-- Run after tests/run-sql-tests.sh:  tests/run-scale.sh
-- Per tier: 20% paying (THB/KRW, month/year), 20% active on each of the last 30 days, 1 payment per payer.
\set ON_ERROR_STOP on
set client_min_messages = notice;
begin;
create temp table bench (tier int, what text, ms numeric);
grant all on bench to public;
create or replace function pg_temp.grow(target int) returns void language plpgsql as $$
declare have int := (select count(*) from auth.users where email like '%@bench.test');
begin
  if have >= target then return; end if;
  insert into auth.users (id, email, email_confirmed_at, created_at)
  select gen_random_uuid(), 'b' || i || '@bench.test', now(), now() - (i % 400) * interval '1 day' from generate_series(have + 1, target) i;
  insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id)
  select p.user_id, case when random() < .5 then 'plus' else 'premium' end, 'active', now() - interval '3 days', now() + interval '27 days',
         case when random() < .8 then 'month' else 'year' end, case when random() < .6 then 'THB' else 'KRW' end, 12900, 'sub_bench_' || p.user_id
  from public.profiles p where p.email like '%@bench.test' and random() < .2
    and not exists (select 1 from public.subscriptions s where s.user_id = p.user_id);
  insert into public.payments (user_id, provider_invoice_id, currency, amount_due_minor, amount_paid_minor, status, paid_at, plan_id)
  select s.user_id, 'in_bench_' || s.user_id, s.currency, 12900, 12900, 'paid', now() - interval '3 days', s.plan_id
  from public.subscriptions s where s.provider_subscription_id like 'sub_bench_%'
    and not exists (select 1 from public.payments p where p.provider_invoice_id = 'in_bench_' || s.user_id);
  insert into public.user_activity_daily (user_id, day, events, pages, features)
  select p.user_id, public.kfp_seoul_day() - g, 1 + (random() * 15)::int, '{"index.html": 3, "gold.html": 1}', '{"expenses": 1}'
  from public.profiles p cross join generate_series(0, 29) g
  where p.email like '%@bench.test' and random() < .2 on conflict do nothing;
  analyze;
end $$;
create or replace function pg_temp.measure(tier int) returns void language plpgsql as $$
declare t0 timestamptz; u uuid; i int; ms numeric; adm uuid := (select user_id from public.admin_roles where role = 'owner' limit 1);
begin
  -- member-facing calls: average of 20 different members
  for i in 1..4 loop
    t0 := clock_timestamp();
    for u in select p.user_id from public.profiles p where p.email like '%@bench.test' order by random() limit 20 loop
      perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      if i = 1 then perform public.get_my_entitlements();
      elsif i = 2 then perform public.get_my_billing();
      elsif i = 3 then perform public.get_my_gold();
      else perform public.touch_activity('index.html', 'page'); end if;
    end loop;
    insert into bench values (tier, (array['get_my_entitlements','get_my_billing','get_my_gold','touch_activity'])[i] || ' (avg/member)',
                              round(extract(epoch from clock_timestamp() - t0) * 1000 / 20, 2));
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  t0 := clock_timestamp(); perform public.admin_overview(); insert into bench values (tier, 'admin_overview', round(extract(epoch from clock_timestamp() - t0) * 1000));
  t0 := clock_timestamp(); perform public.admin_list_users('{"sort":"last_active_at","page":2,"page_size":50}'); insert into bench values (tier, 'admin_list_users (page)', round(extract(epoch from clock_timestamp() - t0) * 1000));
  t0 := clock_timestamp(); perform public.admin_list_users('{"q":"b77@","plan":"premium"}'); insert into bench values (tier, 'admin_list_users (search)', round(extract(epoch from clock_timestamp() - t0) * 1000));
  t0 := clock_timestamp(); perform public.admin_revenue('{}'); insert into bench values (tier, 'admin_revenue', round(extract(epoch from clock_timestamp() - t0) * 1000));
  t0 := clock_timestamp(); perform public.admin_activity_analytics('{"days":30,"refresh":true}'); insert into bench values (tier, 'admin_activity_analytics (fresh)', round(extract(epoch from clock_timestamp() - t0) * 1000));
  t0 := clock_timestamp(); perform public.admin_activity_analytics('{"days":30}'); insert into bench values (tier, 'admin_activity_analytics (cached)', round(extract(epoch from clock_timestamp() - t0) * 1000));
  perform set_config('request.jwt.claims', '', true);
end $$;
select pg_temp.grow(100);   select pg_temp.measure(100);
select pg_temp.grow(1000);  select pg_temp.measure(1000);
select pg_temp.grow(10000); select pg_temp.measure(10000);
select pg_temp.grow(50000); select pg_temp.measure(50000);
\echo '== milliseconds (members = test members created; database also holds the earlier test rows)'
select what as "call", max(ms) filter (where tier = 100) as "100", max(ms) filter (where tier = 1000) as "1,000",
       max(ms) filter (where tier = 10000) as "10,000", max(ms) filter (where tier = 50000) as "50,000"
from bench group by what order by min(ctid);
rollback;
