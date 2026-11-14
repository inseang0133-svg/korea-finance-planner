-- Phase 6 tests: billing + admin data model. Runs after phase5_test.sql (same database).
\set ON_ERROR_STOP on
\echo '== apply migration 0500 (twice: re-runnable)'
\ir ../../supabase/migrations/20261113000500_billing_admin.sql
\ir ../../supabase/migrations/20261113000500_billing_admin.sql

insert into auth.users (id, email, email_confirmed_at) values
 ('b0000000-0000-0000-0000-000000000001', 'owner@x.com', now()),
 ('b0000000-0000-0000-0000-000000000002', 'admin@x.com', now()),
 ('b0000000-0000-0000-0000-000000000003', 'viewer@x.com', now()),
 ('b0000000-0000-0000-0000-000000000004', 'cust@x.com', now()),
 ('b0000000-0000-0000-0000-000000000005', 'other@x.com', now()),
 ('b0000000-0000-0000-0000-000000000006', 'suspadmin@x.com', now());
-- the ONLY way to create admins: SQL as the database owner (docs/SETUP.md)
insert into public.admin_roles (user_id, role) values
 ('b0000000-0000-0000-0000-000000000001', 'owner'),
 ('b0000000-0000-0000-0000-000000000002', 'admin'),
 ('b0000000-0000-0000-0000-000000000003', 'viewer'),
 ('b0000000-0000-0000-0000-000000000006', 'admin');
update public.profiles set suspended_at = now() where user_id = 'b0000000-0000-0000-0000-000000000006';

\echo '== P6-T1 default prices seeded once (minor units; KRW zero-decimal; KRW yearly left to admin)'
do $$ begin
  assert (select count(*) from public.plan_prices where active) = 6, 'six default prices';
  assert (select amount_minor from public.plan_prices where plan_id='plus' and billing_interval='month' and currency='THB' and active) = 12900, '129 THB';
  assert (select amount_minor from public.plan_prices where plan_id='premium' and billing_interval='year' and currency='THB' and active) = 199000, '1,990 THB';
  assert (select amount_minor from public.plan_prices where plan_id='premium' and billing_interval='month' and currency='KRW' and active) = 8900, '8,900 KRW';
  assert not exists (select 1 from public.plan_prices where currency='KRW' and billing_interval='year'), 'KRW yearly not seeded';
  assert public.kfp_currency_exponent('KRW') = 0 and public.kfp_currency_exponent('THB') = 2, 'currency exponents';
end $$;

\echo '== P6-T2 guests/users read active prices only, cannot write'
select public.test_login(null);
do $$ declare n int; begin
  select count(*) into n from public.plan_prices; assert n = 6, 'anon sees active prices (' || n || ')';
  begin insert into public.plan_prices (plan_id, billing_interval, currency, amount_minor) values ('plus','month','THB',1); assert false, 'anon inserted price!';
  exception when insufficient_privilege then null; end;
  begin perform public.admin_set_price('plus','month','THB',1,'x'); assert false, 'anon set price!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b0000000-0000-0000-0000-000000000004');
do $$ begin
  assert not public.is_admin('viewer'), 'customer is not admin';
  begin perform public.admin_set_price('plus','month','THB',1,'x'); assert false, 'customer set price!';
  exception when insufficient_privilege then null; end;
  begin update public.plan_prices set amount_minor = 1; assert false, 'customer updated price!';
  exception when insufficient_privilege then null; end;
  begin insert into public.admin_roles (user_id, role) values (auth.uid(), 'owner'); assert false, 'self-promotion!';
  exception when insufficient_privilege then null; end;
  begin update public.admin_roles set role = 'owner'; assert false, 'role edit!';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from public.admin_roles) = 0, 'cannot see other admins';
  assert (select count(*) from public.admin_audit_logs) = 0, 'cannot read audit logs';
end $$;
reset role;

\echo '== P6-T3 admin changes a price → new row, old kept inactive, audit written'
select public.test_login('b0000000-0000-0000-0000-000000000002');
do $$ declare v_id uuid; v_same uuid; n int; begin
  assert public.is_admin('admin') and not public.is_admin('owner'), 'admin rank';
  begin perform public.admin_set_price('plus','month','THB',14900,''); assert false, 'no reason accepted!';
  exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_price('free','month','THB',100,'x'); assert false, 'free priced!';
  exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_price('plus','week','THB',100,'x'); assert false, 'bad interval!';
  exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_price('plus','month','USD',100,'x'); assert false, 'bad currency!';
  exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_price('plus','month','THB',0,'x'); assert false, 'zero price!';
  exception when invalid_parameter_value then null; end;
  v_id := public.admin_set_price('plus','month','THB',14900,'ปรับราคาเดือน ธ.ค.');
  assert (select amount_minor from public.plan_prices where id = v_id and active) = 14900, 'new active price';
  select count(*) into n from public.plan_prices where plan_id='plus' and billing_interval='month' and currency='THB';
  assert n = 2, 'old price kept as history (' || n || ')';
  v_same := public.admin_set_price('plus','month','THB',14900,'กดซ้ำ');
  assert v_same = v_id, 'same amount = no-op';
  perform public.admin_set_price('plus','year','KRW',59000,'กำหนดราคารายปีวอน');
  perform public.admin_set_price('premium','year','KRW',89000,'กำหนดราคารายปีวอน');
  select count(*) into n from public.admin_audit_logs where action = 'price.set';
  assert n = 3, 'three audit rows (no-op not logged): ' || n;
  assert (select (before->>'amount_minor')::int = 12900 and (after->>'amount_minor')::int = 14900 and admin_id = auth.uid()
          from public.admin_audit_logs where action='price.set' and target_id = v_id::text), 'audit has before/after/admin';
  select count(*) into n from public.plan_prices; assert n = 9, 'admin sees history incl. inactive (' || n || ')';
end $$;
reset role;
do $$ begin
  begin insert into public.plan_prices (plan_id, billing_interval, currency, amount_minor) values ('plus','month','THB',1);
        assert false, 'two active prices for one slot!';
  exception when unique_violation then null; end;
end $$;

\echo '== P6-T4 viewer reads, cannot change; suspended admin has no power'
select public.test_login('b0000000-0000-0000-0000-000000000003');
do $$ begin
  assert public.is_admin('viewer') and not public.is_admin('admin'), 'viewer rank';
  assert (select count(*) from public.admin_audit_logs) >= 3, 'viewer reads audit log';
  begin perform public.admin_set_price('plus','month','THB',100,'x'); assert false, 'viewer set price!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b0000000-0000-0000-0000-000000000006');
do $$ begin
  assert not public.is_admin('viewer'), 'suspended admin is not admin';
  begin perform public.admin_set_price('plus','month','THB',100,'x'); assert false, 'suspended admin set price!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P6-T5 audit log is append-only (even for service_role); user deletion still works'
set role service_role;
do $$ begin
  begin update public.admin_audit_logs set reason = 'edited'; assert false, 'audit edited!';
  exception when insufficient_privilege then null; end;
  begin delete from public.admin_audit_logs; assert false, 'audit deleted!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  begin update public.admin_audit_logs set reason = 'edited by owner'; assert false, 'owner edited audit!';
  exception when insufficient_privilege then null; end;
end $$;
insert into auth.users (id, email) values ('b0000000-0000-0000-0000-000000000099', 'gone@x.com');
insert into public.admin_roles (user_id, role) values ('b0000000-0000-0000-0000-000000000099', 'admin');
select public.kfp_audit('test.action', 'b0000000-0000-0000-0000-000000000004', null, null, null, '{"x":1}', 'by soon-deleted admin', 'b0000000-0000-0000-0000-000000000099');
delete from auth.users where id = 'b0000000-0000-0000-0000-000000000099';
do $$ begin
  assert (select admin_id is null and reason = 'by soon-deleted admin' from public.admin_audit_logs where action = 'test.action'), 'row kept, admin nulled';
end $$;

\echo '== P6-T6 payments / invoices / refunds: own rows only, no client writes; kept after account deletion'
insert into public.subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end, provider_subscription_id, unit_amount_minor, currency, billing_interval)
values ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'plus', 'active', now(), now() + interval '30 days', 'sub_cust', 12900, 'THB', 'month');
insert into public.payments (id, user_id, subscription_id, provider_invoice_id, plan_id, billing_interval, currency, amount_due_minor, amount_paid_minor, status, paid_at, hosted_invoice_url)
values ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', 'in_1', 'plus', 'month', 'THB', 12900, 12900, 'paid', now(), 'https://invoice.example/in_1'),
       ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000005', null, 'in_2', 'premium', 'month', 'KRW', 8900, 0, 'failed', null, null);
insert into public.payment_refunds (payment_id, provider_refund_id, amount_minor, currency) values ('d0000000-0000-0000-0000-000000000001', 're_1', 5000, 'THB');
do $$ begin
  begin insert into public.payments (provider_invoice_id, currency, status) values ('in_1', 'THB', 'paid'); assert false, 'duplicate invoice!';
  exception when unique_violation then null; end;
  begin update public.payments set amount_refunded_minor = 99999 where provider_invoice_id = 'in_1'; assert false, 'refund > paid!';
  exception when check_violation then null; end;
end $$;
insert into public.billing_customers (user_id, provider_customer_id, email) values ('b0000000-0000-0000-0000-000000000004', 'cus_1', 'cust@x.com');
select public.test_login('b0000000-0000-0000-0000-000000000004');
do $$ declare n int; begin
  select count(*) into n from public.payments; assert n = 1, 'own payment only (' || n || ')';
  select count(*) into n from public.payment_refunds; assert n = 1, 'own refund visible';
  select count(*) into n from public.billing_customers; assert n = 1, 'own customer row';
  begin insert into public.payments (user_id, currency, status) values (auth.uid(), 'THB', 'paid'); assert false, 'user inserted payment!';
  exception when insufficient_privilege then null; end;
  begin update public.payments set status = 'paid' where user_id = auth.uid(); assert false, 'user updated payment!';
  exception when insufficient_privilege then null; end;
  begin insert into public.billing_customers (user_id, provider_customer_id) values (auth.uid(), 'cus_fake'); assert false, 'user set customer id!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b0000000-0000-0000-0000-000000000003');   -- viewer admin
do $$ begin assert (select count(*) from public.payments) = 2, 'admin viewer sees all payments'; end $$;
reset role;

\echo '== P6-T7 webhook idempotency (service_role only)'
set role service_role;
do $$ begin
  assert public.kfp_claim_webhook_event('evt_1', 'invoice.paid', '{"id":"evt_1"}'), 'first delivery claimed';
  assert not public.kfp_claim_webhook_event('evt_1', 'invoice.paid', '{}'), 'duplicate while processing → skip';
  perform public.kfp_finish_webhook_event('evt_1', 'processed');
  assert not public.kfp_claim_webhook_event('evt_1', 'invoice.paid', '{}'), 'duplicate after processed → skip';
  assert public.kfp_claim_webhook_event('evt_2', 'customer.subscription.updated', '{}'), 'evt_2 claimed';
  perform public.kfp_finish_webhook_event('evt_2', 'failed', 'db timeout');
  assert public.kfp_claim_webhook_event('evt_2', 'customer.subscription.updated', '{}'), 'failed event can be retried';
  assert (select attempts = 2 and last_error is null from public.stripe_webhook_events where event_id = 'evt_2'), 'attempts counted';
  assert public.kfp_claim_webhook_event('evt_3', 'invoice.payment_failed', '{}'), 'evt_3 claimed';
end $$;
reset role;
update public.stripe_webhook_events set updated_at = now() - interval '6 minutes' where event_id = 'evt_3';   -- worker crashed
set role service_role;
do $$ begin assert public.kfp_claim_webhook_event('evt_3', 'invoice.payment_failed', '{}'), 'stuck event reclaimed after 5 min'; end $$;
reset role;
select public.test_login('b0000000-0000-0000-0000-000000000002');   -- even an admin user cannot touch it from the browser
do $$ begin
  begin perform public.kfp_claim_webhook_event('evt_x', 't', '{}'); assert false, 'browser claimed webhook!';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.stripe_webhook_events; assert false, 'browser read webhook log!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P6-T8 activity: throttled, own only'
select public.test_login('b0000000-0000-0000-0000-000000000004');
do $$ declare n int; begin
  perform public.touch_activity('index.html', 'login');
  perform public.touch_activity('index.html');
  perform public.touch_activity('index.html', 'heartbeat');
  select count(*) into n from public.user_activity; assert n = 1, 'repeat within 5 min not logged (' || n || ')';
  perform public.touch_activity('gold.html');
  perform public.touch_activity('<script>alert(1)</script>');
  select count(*) into n from public.user_activity; assert n = 3, 'new pages logged (' || n || ')';
  assert not exists (select 1 from public.user_activity where page like '%<%'), 'page name sanitised';
  begin insert into public.user_activity (user_id, page) values (auth.uid(), 'x'); assert false, 'direct insert!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select last_active_at > now() - interval '1 minute' from public.profiles where user_id='b0000000-0000-0000-0000-000000000004'), 'last_active_at updated';
end $$;
select public.test_login('b0000000-0000-0000-0000-000000000005');
do $$ begin
  assert (select count(*) from public.user_activity) = 0, 'cannot see others activity';
  assert (select count(*) from public.profiles) = 1, 'customer still sees only own profile';
end $$;
reset role;
select public.test_login(null);
do $$ begin
  begin perform public.touch_activity('x'); assert false, 'anon logged activity!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login('b0000000-0000-0000-0000-000000000003');
do $$ begin
  assert (select count(*) from public.profiles) > 10, 'admin viewer can list profiles';
  assert (select count(*) from public.user_activity) >= 3, 'admin viewer can read activity';
end $$;
reset role;

\echo '== P6-T9 account deletion: personal rows cascade, payments kept anonymised'
delete from auth.users where id = 'b0000000-0000-0000-0000-000000000004';
do $$ begin
  assert (select user_id is null from public.payments where provider_invoice_id = 'in_1'), 'payment kept, user nulled';
  assert (select count(*) from public.payment_refunds where provider_refund_id = 're_1') = 1, 'refund kept';
  assert not exists (select 1 from public.user_activity where user_id = 'b0000000-0000-0000-0000-000000000004'), 'activity deleted';
  assert not exists (select 1 from public.billing_customers where user_id = 'b0000000-0000-0000-0000-000000000004'), 'customer row deleted';
  assert not exists (select 1 from public.subscriptions where user_id = 'b0000000-0000-0000-0000-000000000004'), 'subscription deleted';
end $$;

\echo '== P6-T9b owner can set prices from the SQL Editor (no token); API users still cannot'
select set_config('request.jwt.claims', '', false);
do $$ declare v uuid; begin
  assert public.kfp_is_db_owner_session(), 'direct owner session detected';
  v := public.admin_set_price('premium', 'month', 'KRW', 9900, 'SQL Editor ปรับราคา');
  assert (select amount_minor from public.plan_prices where id = v) = 9900, 'price set from SQL Editor';
  assert (select admin_id is null and reason = 'SQL Editor ปรับราคา' from public.admin_audit_logs where target_id = v::text), 'audited (admin_id null = database owner)';
end $$;
select public.test_login('b0000000-0000-0000-0000-000000000005');   -- API user: claims present → refused
do $$ begin
  assert not public.kfp_is_db_owner_session(), 'API session is not owner session';
  begin perform public.admin_set_price('plus','month','THB',1,'x'); assert false, 'API user passed owner check!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
do $$ begin assert not public.kfp_is_db_owner_session(), 'service_role token is not owner session'; end $$;
select set_config('request.jwt.claims', '', false);

\echo '== P6-T10 indexes for scale'
do $$ declare i text; begin
  foreach i in array array['payments_user_idx','payments_status_idx','user_activity_user_idx','user_activity_created_idx',
                           'admin_audit_logs_created_idx','admin_audit_logs_target_idx','stripe_webhook_events_status_idx',
                           'plan_prices_one_active','payments_provider_invoice_uidx','billing_customers_provider_uidx'] loop
    assert exists (select 1 from pg_indexes where indexname = i), 'missing index ' || i;
  end loop;
end $$;
\echo '== ALL PHASE 6 SQL TESTS PASSED'
