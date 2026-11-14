-- Phase 7 tests: Stripe sync functions → subscriptions / payments / refunds → entitlements.
\set ON_ERROR_STOP on
\echo '== apply migration 0600 (twice)'
\ir ../../supabase/migrations/20261113000600_stripe.sql
\ir ../../supabase/migrations/20261113000600_stripe.sql

insert into auth.users (id, email, email_confirmed_at) values
 ('e0000000-0000-0000-0000-000000000001', 'buyer@x.com', now()),
 ('e0000000-0000-0000-0000-000000000002', 'legacy7@kfp.example.com', now()),
 ('e0000000-0000-0000-0000-000000000003', 'unverified7@x.com', null);
-- Stripe price ids for the current active prices
update public.plan_prices set provider_price_id = 'price_plus_m_thb' where active and plan_id='plus' and billing_interval='month' and currency='THB';
update public.plan_prices set provider_price_id = 'price_prem_m_thb' where active and plan_id='premium' and billing_interval='month' and currency='THB';

\echo '== P7-T1 checkout context'
set role service_role;
do $$ declare c jsonb; begin
  c := public.kfp_checkout_context('{"user_id":"e0000000-0000-0000-0000-000000000001","plan":"plus","interval":"month","currency":"thb"}');
  assert c->>'email' = 'buyer@x.com' and (c->>'verified')::boolean and not (c->>'legacy')::boolean, 'buyer flags';
  assert c->'price'->>'provider_price_id' = 'price_plus_m_thb', 'active price with stripe id';
  assert c->'customer_id' = 'null'::jsonb and c->'active_subscription' = 'null'::jsonb, 'no customer / sub yet';
  c := public.kfp_checkout_context('{"user_id":"e0000000-0000-0000-0000-000000000002","plan":"plus","interval":"month","currency":"THB"}');
  assert (c->>'legacy')::boolean, 'legacy flagged';
  c := public.kfp_checkout_context('{"user_id":"e0000000-0000-0000-0000-000000000003","plan":"plus","interval":"month","currency":"THB"}');
  assert not (c->>'verified')::boolean, 'unverified flagged';
  c := public.kfp_checkout_context('{"user_id":"e0000000-0000-0000-0000-000000000001","plan":"premium","interval":"year","currency":"KRW"}');
  assert c->>'price' is not null, 'KRW yearly premium exists (set by admin in phase 6)';
  assert public.kfp_set_price_provider_id(jsonb_build_object('price_id', c->'price'->>'id', 'provider_price_id', 'price_new')) = 'price_new', 'price id stored';
  assert public.kfp_set_price_provider_id(jsonb_build_object('price_id', c->'price'->>'id', 'provider_price_id', 'price_other')) = 'price_new', 'first writer wins (concurrent checkouts)';
end $$;

\echo '== P7-T2 checkout.session.completed → active Plus'
do $$ declare r jsonb; begin
  r := public.kfp_apply_subscription('{"provider_subscription_id":"sub_A","provider_customer_id":"cus_A","user_id":"e0000000-0000-0000-0000-000000000001",
     "price_provider_id":"price_plus_m_thb","billing_interval":"month","currency":"thb","status":"active","cancel_at_period_end":false,
     "current_period_start":"2026-11-13T00:00:00Z","current_period_end":"2026-12-13T00:00:00Z","unit_amount_minor":12900,"latest_invoice_id":"in_A1"}');
  assert r->>'plan_id' = 'plus', 'plan resolved from Stripe price id';
  assert (select provider_customer_id from public.billing_customers where user_id='e0000000-0000-0000-0000-000000000001') = 'cus_A', 'customer mapped';
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'plus', 'user is Plus now';
end $$;

\echo '== P7-T3 events without user metadata resolve the user via the customer; duplicates are idempotent'
do $$ begin
  perform public.kfp_apply_subscription('{"provider_subscription_id":"sub_A","provider_customer_id":"cus_A","price_provider_id":"price_plus_m_thb",
     "billing_interval":"month","currency":"THB","status":"active","current_period_start":"2026-11-13T00:00:00Z","current_period_end":"2026-12-13T00:00:00Z"}');
  perform public.kfp_apply_subscription('{"provider_subscription_id":"sub_A","provider_customer_id":"cus_A","price_provider_id":"price_plus_m_thb",
     "billing_interval":"month","currency":"THB","status":"active","current_period_start":"2026-11-13T00:00:00Z","current_period_end":"2026-12-13T00:00:00Z"}');
  assert (select count(*) from public.subscriptions where provider_subscription_id='sub_A') = 1, 'one row per subscription';
  assert (select latest_invoice_id from public.subscriptions where provider_subscription_id='sub_A') = 'in_A1', 'latest invoice kept';
  begin perform public.kfp_apply_subscription('{"provider_subscription_id":"sub_X","provider_customer_id":"cus_unknown","price_provider_id":"price_plus_m_thb","status":"active"}');
        assert false, 'unknown customer accepted!';
  exception when no_data_found then null; end;
  begin perform public.kfp_apply_subscription('{"provider_subscription_id":"sub_Y","provider_customer_id":"cus_A","price_provider_id":"price_unknown","status":"active"}');
        assert false, 'unknown price accepted!';
  exception when no_data_found then null; end;
end $$;

\echo '== P7-T4 invoice.paid → payment history'
do $$ declare r jsonb; begin
  r := public.kfp_apply_invoice('{"provider_invoice_id":"in_A1","provider_customer_id":"cus_A","provider_subscription_id":"sub_A",
     "provider_payment_intent_id":"pi_A1","provider_charge_id":"ch_A1","price_provider_id":"price_plus_m_thb","billing_interval":"month",
     "currency":"thb","amount_due_minor":12900,"amount_paid_minor":12900,"status":"paid","paid_at":"2026-11-13T00:01:00Z",
     "period_start":"2026-11-13T00:00:00Z","period_end":"2026-12-13T00:00:00Z","hosted_invoice_url":"https://pay.stripe.com/i/A1","invoice_pdf_url":"https://pay.stripe.com/i/A1.pdf"}');
  assert r->>'status' = 'paid', 'paid';
  assert (select plan_id = 'plus' and currency = 'THB' and subscription_id is not null and amount_paid_minor = 12900 from public.payments where provider_invoice_id='in_A1'), 'payment linked to plan + subscription';
  -- late/duplicate "failed" for the same invoice must not un-pay it
  perform public.kfp_apply_invoice('{"provider_invoice_id":"in_A1","provider_customer_id":"cus_A","currency":"THB","amount_due_minor":12900,"amount_paid_minor":0,"status":"failed","failure_reason":"late"}');
  assert (select status = 'paid' and amount_paid_minor = 12900 and failure_reason is null from public.payments where provider_invoice_id='in_A1'), 'paid invoice not downgraded';
end $$;

\echo '== P7-T5 renewal fails → past_due grace → recovered; action required'
do $$ begin
  perform public.kfp_apply_invoice('{"provider_invoice_id":"in_A2","provider_customer_id":"cus_A","provider_subscription_id":"sub_A","currency":"THB",
     "amount_due_minor":12900,"amount_paid_minor":0,"status":"failed","failure_reason":"Your card was declined."}');
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_A','provider_customer_id','cus_A','price_provider_id','price_plus_m_thb',
     'billing_interval','month','currency','THB','status','past_due','current_period_start', now() - interval '1 day','current_period_end', now() + interval '29 days'));
  assert (select status = 'failed' and failure_reason like '%declined%' from public.payments where provider_invoice_id='in_A2'), 'failed payment recorded with reason';
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'plus', 'still Plus during grace';
  perform public.kfp_apply_invoice('{"provider_invoice_id":"in_A2","provider_customer_id":"cus_A","currency":"THB","amount_due_minor":12900,"amount_paid_minor":0,"status":"action_required","failure_reason":"3DS required"}');
  assert (select status from public.payments where provider_invoice_id='in_A2') = 'action_required', 'action required';
  perform public.kfp_apply_invoice('{"provider_invoice_id":"in_A2","provider_customer_id":"cus_A","currency":"THB","amount_due_minor":12900,"amount_paid_minor":12900,"status":"paid","paid_at":"2026-11-14T00:00:00Z"}');
  assert (select status = 'paid' from public.payments where provider_invoice_id='in_A2'), 'retry paid';
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_A','provider_customer_id','cus_A','price_provider_id','price_plus_m_thb',
     'billing_interval','month','currency','THB','status','past_due','current_period_start', now() - interval '9 days','current_period_end', now() + interval '21 days'));
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'free', 'past grace → Free';
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_A','provider_customer_id','cus_A','price_provider_id','price_plus_m_thb',
     'billing_interval','month','currency','THB','status','active','current_period_start', now() - interval '9 days','current_period_end', now() + interval '21 days'));
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'plus', 'paid again → Plus';
end $$;

\echo '== P7-T6 upgrade in the portal → Premium; cancel at period end; deleted → Free; data untouched'
do $$ begin
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_A','provider_customer_id','cus_A','price_provider_id','price_prem_m_thb',
     'billing_interval','month','currency','THB','status','active','current_period_start', now(),'current_period_end', now() + interval '30 days','unit_amount_minor',19900));
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'premium', 'upgraded';
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_A','provider_customer_id','cus_A','price_provider_id','price_prem_m_thb',
     'billing_interval','month','currency','THB','status','active','cancel_at_period_end',true,'current_period_start', now(),'current_period_end', now() + interval '30 days'));
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'premium', 'cancelled at period end: still premium';
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_A','provider_customer_id','cus_A','price_provider_id','price_prem_m_thb',
     'billing_interval','month','currency','THB','status','canceled','canceled_at', now(),'ended_at', now(),'current_period_start', now() - interval '30 days','current_period_end', now()));
  assert (select plan_id from public.kfp_effective_plan('e0000000-0000-0000-0000-000000000001')) = 'free', 'deleted → Free';
  assert (select count(*) from public.payments where user_id='e0000000-0000-0000-0000-000000000001') = 2, 'payment history kept';
end $$;

\echo '== P7-T7 refunds: partial then full; duplicates idempotent; never above paid'
do $$ begin
  perform public.kfp_apply_refund('{"provider_charge_id":"ch_A1","provider_payment_intent_id":"pi_A1","provider_invoice_id":"in_A1","currency":"thb",
     "amount_refunded_minor":5000,"refunds":[{"id":"re_A1","amount_minor":5000,"status":"succeeded","reason":"requested_by_customer"}]}');
  assert (select status = 'partially_refunded' and amount_refunded_minor = 5000 from public.payments where provider_invoice_id='in_A1'), 'partial refund';
  perform public.kfp_apply_refund('{"provider_charge_id":"ch_A1","currency":"THB","amount_refunded_minor":12900,
     "refunds":[{"id":"re_A1","amount_minor":5000},{"id":"re_A2","amount_minor":7900}]}');
  perform public.kfp_apply_refund('{"provider_charge_id":"ch_A1","currency":"THB","amount_refunded_minor":12900,
     "refunds":[{"id":"re_A1","amount_minor":5000},{"id":"re_A2","amount_minor":7900}]}');
  assert (select status = 'refunded' and amount_refunded_minor = 12900 from public.payments where provider_invoice_id='in_A1'), 'fully refunded';
  assert (select count(*) from public.payment_refunds r join public.payments p on p.id = r.payment_id where p.provider_invoice_id='in_A1') = 2, 'two refund rows, no duplicates';
  perform public.kfp_apply_invoice('{"provider_invoice_id":"in_A1","provider_customer_id":"cus_A","currency":"THB","amount_due_minor":12900,"amount_paid_minor":12900,"status":"paid"}');
  assert (select status from public.payments where provider_invoice_id='in_A1') = 'refunded', 'late invoice.paid does not erase refund';
  perform public.kfp_apply_refund('{"provider_charge_id":"ch_A1","currency":"THB","amount_refunded_minor":999999,"refunds":[]}');
  assert (select amount_refunded_minor from public.payments where provider_invoice_id='in_A1') = 12900, 'refund capped at amount paid';
  begin perform public.kfp_apply_refund('{"provider_charge_id":"ch_nope","refunds":[]}'); assert false, 'refund for unknown charge accepted!';
  exception when no_data_found then null; end;
end $$;

\echo '== P7-T8 KRW (zero-decimal) subscription'
do $$ begin
  perform public.kfp_apply_subscription(jsonb_build_object('provider_subscription_id','sub_K','provider_customer_id','cus_A','price_provider_id','price_new',
     'billing_interval','year','currency','krw','status','active','current_period_start', now(),'current_period_end', now() + interval '365 days','unit_amount_minor',89000));
  assert (select currency = 'KRW' and unit_amount_minor = 89000 and plan_id = 'premium' from public.subscriptions where provider_subscription_id='sub_K'), 'KRW stored in won';
end $$;
reset role;

\echo '== P7-T9 browser cannot call any sync function'
select public.test_login('e0000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform public.kfp_apply_subscription('{}'); assert false, 'user applied subscription!'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_apply_invoice('{}'); assert false, 'user applied invoice!'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_apply_refund('{}'); assert false, 'user applied refund!'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_checkout_context('{}'); assert false, 'user read checkout ctx!'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_set_price_provider_id('{}'); assert false, 'user set price id!'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_upsert_billing_customer('{}'); assert false, 'user set customer!'; exception when insufficient_privilege then null; end;
end $$;
reset role;
\echo '== ALL PHASE 7 SQL TESTS PASSED'
