-- Phase 8 tests: get_my_billing() + checkout context details.
\set ON_ERROR_STOP on
\echo '== apply migration 0700 (twice)'
\ir ../../supabase/migrations/20261114000700_billing_page.sql
\ir ../../supabase/migrations/20261114000700_billing_page.sql

insert into auth.users (id, email, email_confirmed_at) values
 ('a8000000-0000-0000-0000-000000000001', 'bill@x.com', now()),
 ('a8000000-0000-0000-0000-000000000002', 'nobill@x.com', now());
insert into public.billing_customers (user_id, provider_customer_id) values ('a8000000-0000-0000-0000-000000000001', 'cus_p8');
insert into public.subscriptions (user_id, plan_id, status, cancel_at_period_end, billing_interval, currency, unit_amount_minor,
                                  current_period_start, current_period_end, provider_subscription_id, created_at)
values ('a8000000-0000-0000-0000-000000000001', 'plus', 'canceled', false, 'month', 'THB', 12900, now() - interval '90 days', now() - interval '60 days', 'sub_p8_old', now() - interval '90 days'),
       ('a8000000-0000-0000-0000-000000000001', 'premium', 'past_due', true, 'year', 'KRW', 89000, now() - interval '2 days', now() + interval '363 days', 'sub_p8_cur', now() - interval '30 days');
insert into public.payments (user_id, provider_invoice_id, currency, amount_due_minor, amount_paid_minor, status, hosted_invoice_url, failure_reason, created_at)
values ('a8000000-0000-0000-0000-000000000001', 'in_p8_1', 'KRW', 89000, 89000, 'paid', 'https://inv/1', null, now() - interval '30 days'),
       ('a8000000-0000-0000-0000-000000000001', 'in_p8_2', 'KRW', 89000, 0, 'failed', 'https://inv/2', 'Card declined', now() - interval '1 day');

\echo '== P8-T1 member sees own billing summary'
select public.test_login('a8000000-0000-0000-0000-000000000001');
do $$ declare b jsonb; begin
  b := public.get_my_billing();
  assert b->'subscription'->>'provider' = 'stripe' and b->'subscription'->>'status' = 'past_due', 'current (past_due) subscription preferred over newer-but-ended rows';
  assert b->'subscription'->>'plan_name' = 'Finance Premium' and (b->'subscription'->>'cancel_at_period_end')::boolean, 'plan name + auto-renew off';
  assert (b->'subscription'->>'unit_amount_minor')::int = 89000 and b->'subscription'->>'currency' = 'KRW', 'price/currency';
  assert b->'open_invoice'->>'hosted_invoice_url' = 'https://inv/2' and b->'open_invoice'->>'failure_reason' = 'Card declined', 'open (failed) invoice to pay';
  assert (b->>'has_customer')::boolean and (b->>'payments_total')::int = 2, 'customer + count';
  assert b->'entitlements'->>'plan' = 'premium', 'entitlements included (past_due within grace)';
  assert jsonb_array_length(b->'grants') = 0, 'no grants';
end $$;
reset role;

\echo '== P8-T2 another member sees nothing of the first'
select public.test_login('a8000000-0000-0000-0000-000000000002');
do $$ declare b jsonb; begin
  b := public.get_my_billing();
  assert b->'subscription' = 'null'::jsonb and b->'open_invoice' = 'null'::jsonb, 'nothing leaks';
  assert not (b->>'has_customer')::boolean and (b->>'payments_total')::int = 0, 'empty';
  assert b->'entitlements'->>'plan' = 'free', 'free';
end $$;
reset role;
select public.test_login(null);
do $$ begin
  begin perform public.get_my_billing(); assert false, 'anon read billing!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== P8-T3 grants listed (legacy launch) ; checkout context exposes sub details to service_role only'
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values ('a8000000-0000-0000-0000-000000000002', 'premium', now() + interval '60 days', 'legacy_launch');
select public.test_login('a8000000-0000-0000-0000-000000000002');
do $$ declare b jsonb; begin
  b := public.get_my_billing();
  assert jsonb_array_length(b->'grants') = 1 and b->'grants'->0->>'reason' = 'legacy_launch', 'grant listed';
  assert b->'entitlements'->>'plan' = 'premium' and b->'entitlements'->>'source' = 'legacy_launch', 'premium via grant';
  begin perform public.kfp_checkout_context('{}'); assert false, 'user read ctx!'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ declare c jsonb; begin
  c := public.kfp_checkout_context('{"user_id":"a8000000-0000-0000-0000-000000000001","plan":"plus","interval":"year","currency":"KRW"}');
  assert c->'active_subscription'->>'id' = 'sub_p8_cur' and (c->'active_subscription'->>'cancel_at_period_end')::boolean
     and c->'active_subscription'->>'billing_interval' = 'year' and c->'active_subscription'->>'currency' = 'KRW', 'sub details for cancel/resume/switch';
end $$;
reset role;
\echo '== ALL PHASE 8 SQL TESTS PASSED'
