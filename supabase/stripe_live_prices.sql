-- Korea Finance Planner · link the Stripe LIVE prices (account "planner", acct_1UawqTFuf3NEqdjZ)
-- Run ONCE in the PRODUCTION Supabase SQL Editor, after install_all.sql.
-- Products/prices were created in Stripe on 2026-11-14 (products kfp_plus / kfp_premium, lookup_key kfp_<plan>_<interval>_<cur>).
-- Without this file the Edge Function would create a second, duplicate Price on the first checkout.
-- Only fills empty rows whose amount matches exactly — safe to run again; never touches a staging/test database
-- that already holds test ids (those rows are skipped because provider_price_id is not null).
with v(plan_id, billing_interval, currency, amount_minor, price_id) as (values
  ('plus',    'month', 'THB',  12900::bigint, 'price_1Ubc2GFuf3NEqdjZJEMpIbLv'),
  ('plus',    'year',  'THB', 129000::bigint, 'price_1Ubc2JFuf3NEqdjZblyffSc5'),
  ('plus',    'month', 'KRW',   5900::bigint, 'price_1Ubc2LFuf3NEqdjZ6S5O6ekR'),
  ('premium', 'month', 'THB',  19900::bigint, 'price_1Ubc2MFuf3NEqdjZR4hULdf8'),
  ('premium', 'year',  'THB', 199000::bigint, 'price_1Ubc2OFuf3NEqdjZWqtik3KX'),
  ('premium', 'month', 'KRW',   8900::bigint, 'price_1Ubc2PFuf3NEqdjZm1he93af')
)
update public.plan_prices p
   set provider_price_id = v.price_id
  from v
 where p.provider = 'stripe' and p.active and p.provider_price_id is null
   and p.plan_id = v.plan_id and p.billing_interval = v.billing_interval
   and p.currency = v.currency and p.amount_minor = v.amount_minor;

-- expect 6 rows, all with a price_… id
select plan_id, billing_interval, currency, amount_minor, provider_price_id
  from public.plan_prices where active order by plan_id, currency, billing_interval;
