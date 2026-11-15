-- Phase 15 tests: country at sign-up, monthly_digest, add-ons merged into entitlements.
-- Runs after phase10/13/14 in the same database.
\set ON_ERROR_STOP on
\echo '== apply migration 1600 (twice: re-runnable)'
\ir ../../supabase/migrations/20261115001600_country_addons_digest.sql
\ir ../../supabase/migrations/20261115001600_country_addons_digest.sql

\echo '== P15-T1 sign-up keeps TH / KR, ignores anything else'
insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data) values
 ('c1500000-0000-0000-0000-000000000001', 'th@p15.test', now(), now(), '{"username":"p15th","country":"th"}'),
 ('c1500000-0000-0000-0000-000000000002', 'jp@p15.test', now(), now(), '{"username":"p15jp","country":"JP"}'),
 ('c1500000-0000-0000-0000-000000000003', 'kr@p15.test', now(), now(), '{"username":"p15kr","country":"KR"}');
do $$ begin
  assert (select country from public.profiles where user_id = 'c1500000-0000-0000-0000-000000000001') = 'TH', 'th → TH';
  assert (select country from public.profiles where user_id = 'c1500000-0000-0000-0000-000000000002') is null, 'JP ignored';
  assert (select country from public.profiles where user_id = 'c1500000-0000-0000-0000-000000000003') = 'KR', 'KR';
end $$;

\echo '== P15-T2 plans: monthly_digest Premium only; 6 add-ons with THB prices'
do $$ begin
  assert (select (features->>'monthly_digest')::boolean from public.plans where id = 'premium'), 'premium digest';
  assert not (select (features->>'monthly_digest')::boolean from public.plans where id = 'plus'), 'plus no digest';
  assert (select count(*) from public.plans where kind = 'addon' and active) = 6, '6 add-ons';
  assert (select count(*) from public.plans where kind = 'plan') = 3, '3 plans';
  assert (select amount_minor from public.plan_prices where plan_id = 'addon_work' and currency = 'THB' and active) = 6900, 'work 69 THB';
  assert (select amount_minor from public.plan_prices where plan_id = 'addon_planning' and currency = 'THB' and active) = 4900, 'planning 49 THB';
  assert (select count(*) from public.plan_prices where plan_id like 'addon_%' and currency = 'KRW') = 0, 'KRW set later';
  assert (select count(*) from public.plan_prices where plan_id like 'addon_%' and active) = 6, 'not duplicated on re-run';
end $$;

\echo '== P15-T3 Free member + add-ons: plan stays Free, features/limits merged'
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, billing_interval, currency, unit_amount_minor, provider_subscription_id) values
 ('c1500000-0000-0000-0000-000000000001', 'addon_gold',   'active', now() - interval '3 days', now() + interval '27 days', 'month', 'THB', 6900, 'sub_p15_gold'),
 ('c1500000-0000-0000-0000-000000000001', 'addon_salary', 'active', now() - interval '3 days', now() + interval '27 days', 'month', 'THB', 5900, 'sub_p15_sal'),
 ('c1500000-0000-0000-0000-000000000001', 'addon_cloud',  'canceled', now() - interval '40 days', now() - interval '10 days', 'month', 'THB', 6900, 'sub_p15_cloud');
do $$ declare b jsonb; begin
  assert (select plan_id from public.kfp_effective_plan('c1500000-0000-0000-0000-000000000001')) = 'free', 'plan is still free';
  b := public.kfp_entitlement_bundle('c1500000-0000-0000-0000-000000000001');
  assert (b->'features'->>'gold_portfolio')::boolean and (b->'features'->>'advanced_statistics')::boolean and (b->'features'->>'export')::boolean, 'add-on features on';
  assert not (b->'features'->>'cloud_sync')::boolean, 'ended add-on not counted';
  assert not (b->'features'->>'monthly_digest')::boolean and not (b->'features'->>'work_records')::boolean, 'others still off';
  assert b->'limits'->'salary_records_max' = 'null'::jsonb and (b->'limits'->>'expense_items_max')::int = 10, 'salary unlimited, expenses still 10';
  assert jsonb_array_length(b->'addons') = 2, 'two live add-ons';
  assert public.kfp_has_feature('c1500000-0000-0000-0000-000000000001', 'gold_portfolio'), 'has_feature sees add-on';
  assert (select plan_id from public.kfp_effective_plans_all() where user_id = 'c1500000-0000-0000-0000-000000000001') = 'free', 'admin list: free';
end $$;
select public.test_login('c1500000-0000-0000-0000-000000000001');
do $$ declare j jsonb; bl jsonb; begin
  j := public.get_my_entitlements();
  assert j->>'plan' = 'free' and (j->'features'->>'gold_portfolio')::boolean and jsonb_array_length(j->'addons') = 2, 'member payload';
  assert not (j->'plan_features'->>'gold_portfolio')::boolean, 'plan_features = plan only';
  assert public.has_feature('gold_portfolio'), 'browser has_feature';
  bl := public.get_my_billing();
  assert bl->'subscription' = 'null'::jsonb, 'no plan subscription';
  assert jsonb_array_length(bl->'addons') = 3, 'add-on list incl. recently ended';
end $$;
reset role;

\echo '== P15-T4 checkout context: kind, active add-on, already included'
do $$ declare c jsonb; begin
  c := public.kfp_checkout_context('{"user_id":"c1500000-0000-0000-0000-000000000001","plan":"addon_gold","interval":"month","currency":"THB"}');
  assert c->>'kind' = 'addon' and (c->'active_addon'->>'plan') = 'addon_gold' and c->'active_subscription' = 'null'::jsonb, 'gold already live';
  assert (c->'price'->>'amount_minor')::int = 6900, 'price';
  assert not (c->>'addon_included')::boolean, 'not included in free';
  c := public.kfp_checkout_context('{"user_id":"c1500000-0000-0000-0000-000000000003","plan":"addon_expense","interval":"month","currency":"THB"}');
  assert not (c->>'addon_included')::boolean, 'free has expenses but limited → unlimited add-on not included';
  c := public.kfp_checkout_context('{"user_id":"b1000000-0000-0000-0000-000000000006","plan":"addon_expense","interval":"month","currency":"THB"}');
  assert (c->>'addon_included')::boolean, 'plus: expenses unlimited already';
  c := public.kfp_checkout_context('{"user_id":"c1500000-0000-0000-0000-000000000001","plan":"addon_work","interval":"month","currency":"KRW"}');
  assert c->'price' = 'null'::jsonb and c->'active_addon' = 'null'::jsonb, 'no KRW price yet';
  c := public.kfp_checkout_context('{"user_id":"b1000000-0000-0000-0000-000000000006","plan":"addon_work","interval":"month","currency":"THB"}');
  assert (c->>'addon_included')::boolean, 'plus already includes work records';
  c := public.kfp_checkout_context('{"user_id":"b1000000-0000-0000-0000-000000000006","plan":"addon_gold","interval":"month","currency":"THB"}');
  assert not (c->>'addon_included')::boolean, 'plus does not include gold';
  c := public.kfp_checkout_context('{"user_id":"b1000000-0000-0000-0000-000000000006","plan":"premium","interval":"month","currency":"THB"}');
  assert c->>'kind' = 'plan', 'plan kind';
end $$;

\echo '== P15-T5 suspended: add-ons off too'
update public.profiles set suspended_at = now() where user_id = 'c1500000-0000-0000-0000-000000000001';
do $$ begin
  assert not public.kfp_has_feature('c1500000-0000-0000-0000-000000000001', 'gold_portfolio'), 'suspended → no add-on';
end $$;
update public.profiles set suspended_at = null where user_id = 'c1500000-0000-0000-0000-000000000001';

\echo '== ALL PHASE 15 SQL TESTS PASSED'
