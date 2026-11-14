-- Phase 10 tests: admin dashboard functions (authorization, numbers, search, actions, audit, scale).
-- Runs after phase2…phase9 in the same database (tests/run-sql-tests.sh).
\set ON_ERROR_STOP on
\echo '== apply migration 0900 (twice: re-runnable)'
\ir ../../supabase/migrations/20261114000900_admin_dashboard.sql
\ir ../../supabase/migrations/20261114000900_admin_dashboard.sql

insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data) values
 ('b1000000-0000-0000-0000-000000000001','owner@p10.test', now(), now() - interval '400 days', '{"username":"p10owner"}'),
 ('b1000000-0000-0000-0000-000000000002','admin@p10.test', now(), now() - interval '300 days', '{"username":"p10admin"}'),
 ('b1000000-0000-0000-0000-000000000003','viewer@p10.test',now(), now() - interval '200 days', '{"username":"p10viewer"}'),
 ('b1000000-0000-0000-0000-000000000004','susadm@p10.test',now(), now() - interval '100 days', '{"username":"p10susadm"}'),
 ('b1000000-0000-0000-0000-000000000005','free@p10.test',  now(), now() - interval '2 hours',  '{"username":"p10free"}'),
 ('b1000000-0000-0000-0000-000000000006','plus@p10.test',  now(), now() - interval '40 days',  '{"username":"p10plus"}'),
 ('b1000000-0000-0000-0000-000000000007','prem@p10.test',  now(), now() - interval '50 days',  '{"username":"p10prem"}'),
 ('b1000000-0000-0000-0000-000000000008','pastdue@p10.test',now(),now() - interval '60 days',  '{"username":"p10pastdue"}'),
 ('b1000000-0000-0000-0000-000000000009','gone@p10.test',  now(), now() - interval '70 days',  '{"username":"p10gone"}'),
 ('b1000000-0000-0000-0000-000000000010','legacy@p10.test',now(), now() - interval '80 days',  '{"username":"p10legacy"}'),
 ('b1000000-0000-0000-0000-000000000011','admin2@p10.test',now(), now() - interval '90 days',  '{"username":"p10admin2"}'),
 ('b1000000-0000-0000-0000-000000000012','100%_off@p10.test',now(),now() - interval '1 day',  '{"username":"p10pct"}');
insert into public.admin_roles (user_id, role) values
 ('b1000000-0000-0000-0000-000000000001','owner'), ('b1000000-0000-0000-0000-000000000002','admin'),
 ('b1000000-0000-0000-0000-000000000003','viewer'), ('b1000000-0000-0000-0000-000000000004','admin'),
 ('b1000000-0000-0000-0000-000000000011','admin');
update public.profiles set suspended_at = now() where user_id = 'b1000000-0000-0000-0000-000000000004';
update public.profiles set country = 'KR', last_active_at = now() - interval '2 hours', last_page = 'gold.html' where user_id = 'b1000000-0000-0000-0000-000000000006';
update public.profiles set country = 'TH', last_active_at = now() - interval '3 days'  where user_id = 'b1000000-0000-0000-0000-000000000007';
update public.profiles set last_active_at = now() - interval '12 days' where user_id = 'b1000000-0000-0000-0000-000000000008';
update public.profiles set last_active_at = now() - interval '45 days' where user_id = 'b1000000-0000-0000-0000-000000000009';
insert into public.subscriptions (user_id, plan_id, status, cancel_at_period_end, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id, created_at, canceled_at, ended_at) values
 ('b1000000-0000-0000-0000-000000000006','plus',   'active',  false, now()-interval '5 days', now()+interval '25 days','month','THB', 12900, 'sub_p10_6', now()-interval '35 days', null, null),
 ('b1000000-0000-0000-0000-000000000007','premium','active',  true,  now()-interval '20 days',now()+interval '345 days','year','KRW', 89000, 'sub_p10_7', now()-interval '20 days', now()-interval '1 day', null),
 ('b1000000-0000-0000-0000-000000000008','plus',   'past_due',false, now()-interval '2 days', now()+interval '28 days','month','THB', 12900, 'sub_p10_8', now()-interval '58 days', null, null),
 ('b1000000-0000-0000-0000-000000000009','plus',   'canceled',false, now()-interval '40 days',now()-interval '10 days','month','THB', 12900, 'sub_p10_9', now()-interval '70 days', now()-interval '10 days', now()-interval '10 days');
insert into public.billing_customers (user_id, provider_customer_id) values ('b1000000-0000-0000-0000-000000000006','cus_p10_6');
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values ('b1000000-0000-0000-0000-000000000010','premium', now()+interval '60 days','legacy_launch');
insert into public.payments (user_id, provider_invoice_id, plan_id, billing_interval, currency, amount_due_minor, amount_paid_minor, amount_refunded_minor, status, paid_at, created_at, failure_reason) values
 ('b1000000-0000-0000-0000-000000000006','in_p10_1','plus','month','THB',12900,12900,5000,'partially_refunded', now()-interval '5 days', now()-interval '5 days', null),
 ('b1000000-0000-0000-0000-000000000007','in_p10_2','premium','year','KRW',89000,89000,0,'paid', now()-interval '20 days', now()-interval '20 days', null),
 ('b1000000-0000-0000-0000-000000000008','in_p10_3','plus','month','THB',12900,0,0,'failed', null, now()-interval '2 days', 'Card declined');
insert into public.payment_refunds (payment_id, provider_refund_id, amount_minor, currency, reason)
select id, 're_p10_1', 5000, 'THB', 'requested_by_customer' from public.payments where provider_invoice_id = 'in_p10_1';
insert into public.user_activity (user_id, kind, page, created_at) values
 ('b1000000-0000-0000-0000-000000000006','login','index.html', now()-interval '2 hours'),
 ('b1000000-0000-0000-0000-000000000006','page','gold.html', now()-interval '2 hours');

-- test helpers (owner-run, readable from any role during the test; dropped at the end)
create or replace function public.t10_eff(p uuid) returns table (plan_id text, source text, status text, valid_until timestamptz)
language sql security definer set search_path = public as $$ select * from public.kfp_effective_plan(p) $$;
create or replace function public.t10_q(q text) returns text language plpgsql security definer set search_path = public as $$
declare r text; begin execute q into r; return r; end $$;
grant execute on function public.t10_eff(uuid), public.t10_q(text) to authenticated;

\echo '== P10-T1 authorization: anon / member / suspended admin refused; viewer read-only'
select public.test_login(null);
do $$ begin
  begin perform public.admin_overview(); assert false, 'anon overview'; exception when insufficient_privilege then null; end;
  begin perform public.admin_list_users('{}'); assert false, 'anon list'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b1000000-0000-0000-0000-000000000006');   -- paying member
do $$ begin
  begin perform public.admin_whoami(); assert false, 'member whoami'; exception when insufficient_privilege then null; end;
  begin perform public.admin_overview(); assert false, 'member overview'; exception when insufficient_privilege then null; end;
  begin perform public.admin_list_users('{}'); assert false, 'member list'; exception when insufficient_privilege then null; end;
  begin perform public.admin_user_detail('b1000000-0000-0000-0000-000000000007'); assert false, 'member detail'; exception when insufficient_privilege then null; end;
  begin perform public.admin_revenue('{}'); assert false, 'member revenue'; exception when insufficient_privilege then null; end;
  begin perform public.admin_audit_list('{}'); assert false, 'member audit'; exception when insufficient_privilege then null; end;
  begin perform public.admin_list_prices(); assert false, 'member prices'; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000006', 'premium', null, 'self upgrade'); assert false, 'member set_plan'; exception when insufficient_privilege then null; end;
  begin insert into public.admin_roles (user_id, role) values (auth.uid(), 'owner'); assert false, 'member became admin'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_effective_plans_all(); assert false, 'member read all plans'; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.profiles) = 1, 'member still sees only own profile';
end $$;
reset role;
select public.test_login('b1000000-0000-0000-0000-000000000004');   -- admin but suspended
do $$ begin
  begin perform public.admin_overview(); assert false, 'suspended admin'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b1000000-0000-0000-0000-000000000003');   -- viewer
do $$ declare w jsonb; begin
  w := public.admin_whoami();
  assert w->>'role' = 'viewer' and not (w->>'can_write')::boolean, 'viewer whoami';
  perform public.admin_overview(); perform public.admin_list_users('{}'); perform public.admin_revenue('{}');
  perform public.admin_user_detail('b1000000-0000-0000-0000-000000000006');
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000005', 'premium', null, 'viewer try'); assert false, 'viewer wrote'; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_suspended('b1000000-0000-0000-0000-000000000005', true, 'viewer try'); assert false, 'viewer suspended'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b1000000-0000-0000-0000-000000000001');
do $$ begin assert public.admin_whoami()->>'role' = 'owner' and (public.admin_whoami()->>'is_owner')::boolean, 'owner whoami'; end $$;
reset role;

\echo '== P10-T2 set-based plan = per-user plan for EVERY user'
do $$ declare n int; begin
  select count(*) into n
  from public.kfp_effective_plans_all() a
  cross join lateral public.kfp_effective_plan(a.user_id) e
  where a.plan_id is distinct from e.plan_id or a.valid_until is distinct from e.valid_until or a.status is distinct from e.status;
  assert n = 0, n || ' users differ between kfp_effective_plans_all and kfp_effective_plan';
  assert (select count(*) from public.kfp_effective_plans_all()) = (select count(*) from auth.users), 'one row per user';
end $$;

\echo '== P10-T3 overview: totals add up; MRR/ARR per currency (yearly ÷ 12); deltas exact'
select public.test_login('b1000000-0000-0000-0000-000000000002');
create temp table ov0 as select public.admin_overview('Asia/Seoul') as o;
reset role;
do $$ declare o jsonb := (select o from ov0); begin
  assert (o->'users'->>'total')::int = (select count(*) from auth.users), 'total users';
  assert (o->'plans'->>'free')::int + (o->'plans'->>'plus')::int + (o->'plans'->>'premium')::int = (o->'users'->>'total')::int, 'plans add up to total';
  assert (o->'users'->>'new_today')::int >= 2 and (o->'users'->>'new_month')::int >= (o->'users'->>'new_today')::int, 'new users today/month';
  assert (o->'mrr'->'THB'->>'mrr_minor')::bigint = (select round(sum(case when billing_interval='year' then unit_amount_minor/12.0 else unit_amount_minor end))
                                                     from public.subscriptions where status in ('active','past_due') and currency = 'THB'), 'THB MRR';
  assert (o->'mrr'->'KRW'->>'arr_minor')::bigint = (o->'mrr'->'KRW'->>'mrr_minor')::bigint * 12, 'ARR = MRR × 12';
  assert (o->'revenue'->'THB'->>'net_minor')::bigint = (o->'revenue'->'THB'->>'gross_minor')::bigint - (o->'revenue'->'THB'->>'refunded_minor')::bigint, 'net = gross − refunds';
  assert (o->'subscriptions'->>'cancelling')::int >= 1 and (o->'subscriptions'->>'past_due')::int >= 1 and (o->'subscriptions'->>'expired')::int >= 1, 'subscription states';
  assert (o->'churn_30d'->>'churned')::int >= 1 and (o->'churn_30d'->>'rate_pct')::numeric between 0 and 100, 'churn';
  assert o->'activity' ? 'active' and o->'activity' ? 'dormant', 'activity buckets';
end $$;
-- a new KRW monthly subscriber (9,900 won) and a yearly THB one (199,000 satang/yr)
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id) values
 ('b1000000-0000-0000-0000-000000000012','premium','active', now(), now()+interval '30 days','month','KRW', 9900, 'sub_p10_12');
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id) values
 ('b1000000-0000-0000-0000-000000000005','premium','active', now(), now()+interval '365 days','year','THB', 199000, 'sub_p10_5');
select public.test_login('b1000000-0000-0000-0000-000000000002');
create temp table ov1 as select public.admin_overview('Asia/Seoul') as o;
reset role;
do $$ declare a jsonb := (select o from ov0); b jsonb := (select o from ov1); begin
  assert coalesce((b->'mrr'->'KRW'->>'mrr_minor')::bigint, 0) - coalesce((a->'mrr'->'KRW'->>'mrr_minor')::bigint, 0) = 9900, 'KRW MRR +9,900 won';
  assert (b->'mrr'->'THB'->>'mrr_minor')::bigint - (a->'mrr'->'THB'->>'mrr_minor')::bigint between 16583 and 16584, 'THB MRR +199,000/12 satang';
  assert (b->'plans'->>'premium')::int - (a->'plans'->>'premium')::int = 2, 'premium +2';
  assert (b->'subscriptions'->>'active')::int - (a->'subscriptions'->>'active')::int = 2, 'active subscribers +2';
end $$;
delete from public.subscriptions where provider_subscription_id in ('sub_p10_12', 'sub_p10_5');

\echo '== P10-T4 user list: search, filters, sort, pagination (server side)'
select public.test_login('b1000000-0000-0000-0000-000000000003');
do $$ declare r jsonb; row1 jsonb; begin
  r := public.admin_list_users('{"q":"@p10.test","page_size":100}');
  assert (r->>'total')::int = 12 and jsonb_array_length(r->'rows') = 12, 'search by e-mail domain: ' || (r->>'total');
  r := public.admin_list_users('{"q":"P10PLUS"}');
  assert (r->>'total')::int = 1 and r->'rows'->0->>'email' = 'plus@p10.test', 'search by username, case-insensitive';
  r := public.admin_list_users('{"q":"b1000000-0000-0000-0000-000000000007"}');
  assert (r->>'total')::int = 1 and r->'rows'->0->>'plan' = 'premium', 'search by user id';
  r := public.admin_list_users('{"q":"100%_"}');
  assert (r->>'total')::int = 1, '% and _ are literal, not wildcards (' || (r->>'total') || ')';
  r := public.admin_list_users('{"q":"@p10.test","plan":"premium","page_size":100}');
  assert (r->>'total')::int = 2, 'plan filter (prem + legacy grant): ' || (r->>'total');
  r := public.admin_list_users('{"q":"@p10.test","sub_status":"cancelling"}');
  assert (r->>'total')::int = 1 and r->'rows'->0->>'email' = 'prem@p10.test', 'cancelling filter';
  r := public.admin_list_users('{"q":"@p10.test","sub_status":"past_due"}');
  assert (r->>'total')::int = 1 and r->'rows'->0->>'plan' = 'plus', 'past_due (in grace → still plus)';
  r := public.admin_list_users('{"q":"@p10.test","sub_status":"none","page_size":100}');
  assert (r->>'total')::int = 8, 'no subscription: ' || (r->>'total');
  r := public.admin_list_users('{"q":"@p10.test","activity":"dormant"}');
  assert (r->>'total')::int = 1 and (r->'rows'->0->>'days_since_active')::int = 45, 'dormant + days since active';
  r := public.admin_list_users('{"q":"@p10.test","activity":"inactive"}');
  assert (r->>'total')::int = 1 and r->'rows'->0->>'email' = 'pastdue@p10.test', 'inactive 8–30 days';
  r := public.admin_list_users('{"q":"@p10.test","country":"kr"}');
  assert (r->>'total')::int = 1, 'country filter';
  r := public.admin_list_users('{"q":"@p10.test","suspended":"true"}');
  assert (r->>'total')::int = 1 and (r->'rows'->0->>'is_admin')::boolean, 'suspended filter + admin flag';
  r := public.admin_list_users('{"q":"@p10.test","sort":"last_active_at","dir":"desc","page_size":5}');
  assert r->'rows'->0->>'email' in ('plus@p10.test') and jsonb_array_length(r->'rows') = 5 and (r->>'total')::int = 12, 'sort by last active, page size 5';
  row1 := r->'rows'->0;
  assert row1->>'last_page' = 'gold.html' and row1->>'sub_status' = 'active' and row1 ? 'sub_started_at' and row1 ? 'expires_at' and row1 ? 'registered_at', 'row fields';
  r := public.admin_list_users('{"q":"@p10.test","sort":"last_active_at","dir":"desc","page_size":5,"page":3}');
  assert jsonb_array_length(r->'rows') = 2, 'page 3 = last 2 rows';
  r := public.admin_list_users('{"q":"@p10.test","sort":"email","dir":"asc","page_size":1000}');
  assert (r->>'page_size')::int = 100 and r->'rows'->0->>'email' = '100%_off@p10.test', 'page size capped at 100, sort by e-mail';
  r := public.admin_list_users('{"sort":"drop table users","dir":"x"}');
  assert jsonb_typeof(r->'rows') = 'array', 'unknown sort ignored';
end $$;
reset role;

\echo '== P10-T5 user detail'
select public.test_login('b1000000-0000-0000-0000-000000000003');
do $$ declare d jsonb; begin
  d := public.admin_user_detail('b1000000-0000-0000-0000-000000000006');
  assert d->'user'->>'email' = 'plus@p10.test' and d->'user'->>'country' = 'KR' and d->'user'->>'activity' = 'active', 'profile';
  assert d->'customer'->>'customer_id' = 'cus_p10_6' and d->'subscriptions'->0->>'provider_subscription_id' = 'sub_p10_6', 'Stripe ids';
  assert jsonb_array_length(d->'payments') = 1 and (d->'payments'->0->>'amount_refunded_minor')::int = 5000, 'payments + refund';
  assert jsonb_array_length(d->'activity') = 2 and d->'effective'->>'plan_id' = 'plus', 'activity + entitlements';
  begin perform public.admin_user_detail('b1000000-0000-0000-0000-0000000000ff'); assert false, 'missing user';
  exception when sqlstate 'P0002' then null; end;
end $$;
reset role;

\echo '== P10-T6 admin actions: grant / change / extend / revoke / suspend — audited'
select public.test_login('b1000000-0000-0000-0000-000000000002');   -- admin
do $$ declare r jsonb; n0 bigint; e record; v1 timestamptz; begin
  n0 := (select count(*) from public.admin_audit_logs);
  -- validation
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000005', 'premium', null, ''); assert false, 'empty reason'; exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000005', 'gold', null, 'test reason'); assert false, 'bad plan'; exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000005', 'premium', now() - interval '1 day', 'test reason'); assert false, 'past expiry'; exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-000000000002', 'premium', null, 'myself'); assert false, 'self'; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_suspended('b1000000-0000-0000-0000-000000000011', true, 'admin vs admin'); assert false, 'admin on admin'; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_plan('b1000000-0000-0000-0000-0000000000ff', 'premium', null, 'nobody'); assert false, 'missing user'; exception when sqlstate 'P0002' then null; end;
  assert (select count(*) from public.admin_audit_logs) = n0, 'refused actions write no audit rows';
  -- Grant Premium for 30 days
  r := public.admin_set_plan('b1000000-0000-0000-0000-000000000005', 'premium', now() + interval '30 days', 'promo: beta tester');
  select * into e from public.t10_eff('b1000000-0000-0000-0000-000000000005');
  assert e.plan_id = 'premium' and e.source = 'admin_grant', 'granted premium';
  -- Change plan → Plus (old admin grant revoked, one active admin grant)
  perform public.admin_set_plan('b1000000-0000-0000-0000-000000000005', 'plus', now() + interval '30 days', 'downgrade promo');
  assert (select count(*) from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000005' and revoked_at is null) = 1, 'one active grant';
  select * into e from public.t10_eff('b1000000-0000-0000-0000-000000000005');
  assert e.plan_id = 'plus', 'changed to plus';
  v1 := e.valid_until;
  -- Extend 10 days (grant row extended)
  perform public.admin_extend_access('b1000000-0000-0000-0000-000000000005', 10, 'support goodwill');
  select * into e from public.t10_eff('b1000000-0000-0000-0000-000000000005');
  assert e.valid_until = v1 + interval '10 days', 'grant extended by 10 days';
  -- Extend a Stripe subscriber: bridging grant from period end, billing untouched
  perform public.admin_extend_access('b1000000-0000-0000-0000-000000000006', 7, 'outage compensation');
  assert (select count(*) from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000006' and revoked_at is null
          and plan_id = 'plus' and expires_at > now() + interval '31 days') = 1, 'bridging grant to period end + 7 days';
  assert (select current_period_end::date from public.subscriptions where provider_subscription_id = 'sub_p10_6') = (now() + interval '25 days')::date, 'subscription untouched';
  begin perform public.admin_extend_access('b1000000-0000-0000-0000-000000000009', 5, 'nothing'); assert false, 'extend free';
  exception when invalid_parameter_value then null; end;
  -- Revoke grants: free user → free; subscriber keeps the paid plan
  r := public.admin_revoke_access('b1000000-0000-0000-0000-000000000005', 'promo ended');
  assert (r->>'revoked')::int = 1 and (select plan_id from public.t10_eff('b1000000-0000-0000-0000-000000000005')) = 'free', 'revoked → free';
  perform public.admin_revoke_access('b1000000-0000-0000-0000-000000000006', 'remove bridge');
  assert (select plan_id from public.t10_eff('b1000000-0000-0000-0000-000000000006')) = 'plus', 'paid subscription not affected';
  -- Change plan → Free also removes the legacy launch grant
  perform public.admin_set_plan('b1000000-0000-0000-0000-000000000010', 'free', null, 'abuse of legacy grant');
  assert (select plan_id from public.t10_eff('b1000000-0000-0000-0000-000000000010')) = 'free', 'legacy grant revoked';
  assert exists (select 1 from public.user_entitlements where user_id = 'b1000000-0000-0000-0000-000000000010' and revoked_at is not null), 'row kept (revoked, not deleted)';
  -- Suspend / reactivate
  perform public.admin_set_suspended('b1000000-0000-0000-0000-000000000006', true, 'chargeback investigation');
  select * into e from public.t10_eff('b1000000-0000-0000-0000-000000000006');
  assert e.plan_id = 'free' and e.source = 'suspended', 'suspended → free';
  perform public.admin_set_suspended('b1000000-0000-0000-0000-000000000006', false, 'resolved');
  assert (select plan_id from public.t10_eff('b1000000-0000-0000-0000-000000000006')) = 'plus', 'reactivated → plus again';
  -- audit trail
  assert (select count(*) from public.admin_audit_logs where admin_id = auth.uid() and created_at > now() - interval '1 minute') = 9, 'one audit row per action';
  assert exists (select 1 from public.admin_audit_logs where action = 'user.suspend' and target_user_id = 'b1000000-0000-0000-0000-000000000006'
                 and reason = 'chargeback investigation' and before->'effective'->>'plan_id' = 'plus' and after->'effective'->>'plan_id' = 'free'), 'before/after recorded';
  r := public.admin_audit_list('{"target":"b1000000-0000-0000-0000-000000000005","page_size":5}');
  assert (r->>'total')::int = 4 and jsonb_array_length(r->'rows') = 4 and r->'rows'->0->>'admin' = 'admin@p10.test' and r->'rows'->0->>'action' = 'plan.revoke', 'audit list by target, newest first';
  r := public.admin_audit_list('{"action_prefix":"user."}');
  assert (r->>'total')::int >= 2 and (select bool_and(x->>'action' like 'user.%') from jsonb_array_elements(r->'rows') x), 'audit filter by action';
end $$;
reset role;
do $$ begin
  begin update public.admin_audit_logs set reason = 'x'; assert false, 'audit editable'; exception when insufficient_privilege then null; end;
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000001');   -- owner can act on an admin
do $$ begin
  perform public.admin_set_suspended('b1000000-0000-0000-0000-000000000011', true, 'owner suspends admin2');
end $$;
reset role;
select public.test_login('b1000000-0000-0000-0000-000000000011');
do $$ begin
  begin perform public.admin_overview(); assert false, 'suspended admin2 still admin'; exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P10-T7 revenue: per currency, never mixed; by plan; monthly; failed; refunds'
select public.test_login('b1000000-0000-0000-0000-000000000003');
do $$ declare r jsonb; begin
  r := public.admin_revenue('{"months":12}');
  assert (r->'by_currency'->'THB'->>'gross_minor')::bigint = (select sum(amount_paid_minor) from public.payments where currency = 'THB' and status in ('paid','partially_refunded','refunded')), 'THB gross';
  assert (r->'by_currency'->'KRW'->>'net_minor')::bigint = (select sum(amount_paid_minor - amount_refunded_minor) from public.payments where currency = 'KRW' and status in ('paid','partially_refunded','refunded')), 'KRW net';
  assert (r->'by_currency'->'THB'->>'refunded_minor')::bigint >= 5000, 'refunds counted';
  assert exists (select 1 from jsonb_array_elements(r->'by_plan') x where x->>'plan_id' = 'premium' and x->>'currency' = 'KRW' and (x->>'gross_minor')::bigint >= 89000), 'by plan + currency';
  assert exists (select 1 from jsonb_array_elements(r->'monthly') x where x->>'month' = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM')), 'monthly series';
  assert exists (select 1 from jsonb_array_elements(r->'failed'->'latest') x where x->>'email' = 'pastdue@p10.test' and x->>'failure_reason' = 'Card declined'), 'failed payments';
  assert exists (select 1 from jsonb_array_elements(r->'refunds'->'latest') x where x->>'email' = 'plus@p10.test' and (x->>'amount_minor')::int = 5000), 'refund list';
end $$;
reset role;

\echo '== P10-T8 Edge Function helpers are service_role only'
select public.test_login('b1000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform public.kfp_admin_role(auth.uid()); assert false, 'browser read kfp_admin_role'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_admin_audit('{}'); assert false, 'browser wrote audit'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ begin
  assert public.kfp_admin_role('b1000000-0000-0000-0000-000000000001') = 'owner' and public.kfp_admin_role('b1000000-0000-0000-0000-000000000011') is null
     and public.kfp_admin_role('b1000000-0000-0000-0000-000000000006') is null, 'roles (suspended admin → null)';
end $$;
reset role;

\echo '== P10-T9 scale: 50,000 members (rolled back)'
begin;
insert into auth.users (id, email, email_confirmed_at, created_at)
select gen_random_uuid(), 'load' || i || '@scale.test', now(), now() - (i % 900) * interval '1 day' from generate_series(1, 50000) i;
update public.profiles set last_active_at = now() - (random() * 60) * interval '1 day' where email like '%@scale.test';
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id)
select user_id, case when random() < .5 then 'plus' else 'premium' end, 'active', now() - interval '3 days', now() + interval '27 days', 'month',
       case when random() < .6 then 'THB' else 'KRW' end, 12900, 'sub_scale_' || row_number() over ()
from public.profiles where email like '%@scale.test' and random() < .2;
analyze;
select public.test_login('b1000000-0000-0000-0000-000000000003');
do $$ declare t0 timestamptz; ms_list numeric; ms_search numeric; ms_ov numeric; ms_rev numeric; r jsonb; begin
  t0 := clock_timestamp(); r := public.admin_list_users('{"sort":"last_active_at","page_size":50,"page":3}'); ms_list := extract(epoch from clock_timestamp() - t0) * 1000;
  assert (r->>'total')::int > 50000 and jsonb_array_length(r->'rows') = 50, 'list page of 50 from 50k+';
  t0 := clock_timestamp(); r := public.admin_list_users('{"q":"load4242@","plan":"free"}'); ms_search := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp(); r := public.admin_overview(); ms_ov := extract(epoch from clock_timestamp() - t0) * 1000;
  assert (r->'users'->>'total')::int > 50000, 'overview counts 50k';
  t0 := clock_timestamp(); r := public.admin_revenue('{}'); ms_rev := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'P10 scale (50k users): list % ms · search % ms · overview % ms · revenue % ms', round(ms_list), round(ms_search), round(ms_ov), round(ms_rev);
  assert ms_list < 3000 and ms_ov < 3000 and ms_search < 3000 and ms_rev < 3000, 'each call under 3 s';
end $$;
reset role;
rollback;
drop function public.t10_eff(uuid); drop function public.t10_q(text);
\echo '== ALL PHASE 10 SQL TESTS PASSED'
