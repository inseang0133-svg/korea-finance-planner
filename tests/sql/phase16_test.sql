-- Phase 16 tests: Smart Credit & Debt — Premium full access, read-only after expiry, never-Premium locked,
-- RLS / no browser writes, idempotency, versions, installment engine, transfers, payments, reconciliation.
-- Runs after phase 2–15 in the same database.
\set ON_ERROR_STOP on
\echo '== apply migration 1700 (twice: re-runnable)'
\ir ../../supabase/migrations/20261116001700_smart_debt.sql
\ir ../../supabase/migrations/20261116001700_smart_debt.sql

-- users:  A = Premium (grant)  ·  B = Premium (other member)  ·  F = never Premium  ·  S = paid subscription
insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data) values
 ('d1600000-0000-0000-0000-00000000000a', 'a@p16.test', now(), now(), '{"username":"p16a","country":"KR"}'),
 ('d1600000-0000-0000-0000-00000000000b', 'b@p16.test', now(), now(), '{"username":"p16b","country":"TH"}'),
 ('d1600000-0000-0000-0000-00000000000f', 'f@p16.test', now(), now(), '{"username":"p16f"}'),
 ('d1600000-0000-0000-0000-000000000005', 's@p16.test', now(), now(), '{"username":"p16s"}');
insert into public.user_entitlements (user_id, plan_id, expires_at, reason) values
 ('d1600000-0000-0000-0000-00000000000a', 'premium', now() + interval '30 days', 'admin_grant'),
 ('d1600000-0000-0000-0000-00000000000b', 'premium', null, 'admin_grant');

\echo '== P16-T1 feature: Premium only'
do $$ begin
  assert (select (features->>'credit_debt')::boolean from public.plans where id = 'premium'), 'premium has credit_debt';
  assert not (select (features->>'credit_debt')::boolean from public.plans where id = 'plus'), 'plus does not';
  assert not (select (features->>'credit_debt')::boolean from public.plans where id = 'free'), 'free does not';
  assert public.kfp_has_feature('d1600000-0000-0000-0000-00000000000a', 'credit_debt'), 'A premium';
  assert not public.kfp_has_feature('d1600000-0000-0000-0000-00000000000f', 'credit_debt'), 'F free';
end $$;

\echo '== P16-T2 installment engine (pure)'
do $$ declare s record; tot bigint; n int; last record; begin
  select count(*), sum(principal), sum(interest) into n, tot from public.kfp_debt_build_schedule(1000000, 0, 'zero', 3, '2026-01-31');
  assert n = 3 and tot = 1000000, 'zero: 3 rows sum = financed';
  select * into s from public.kfp_debt_build_schedule(1000000, 0, 'zero', 3, '2026-01-31') where seq = 3;
  assert s.principal = 333334 and s.due_date = '2026-03-31', 'zero: remainder on last row, month-end kept';
  select * into s from public.kfp_debt_build_schedule(1000000, 0, 'zero', 3, '2026-01-31') where seq = 2;
  assert s.due_date = '2026-02-28', 'Feb clamps to the 28th';
  select sum(interest) into tot from public.kfp_debt_build_schedule(1200000, 1200, 'fixed', 12, '2026-01-10');
  assert tot = 144000, 'fixed: 12%/yr flat over 12 months = 12% of financed';
  select sum(principal) into tot from public.kfp_debt_build_schedule(1200000, 1200, 'fixed', 12, '2026-01-10');
  assert tot = 1200000, 'fixed: principal sums';
  select sum(principal), sum(interest) into tot, n from public.kfp_debt_build_schedule(1000000, 1200, 'reducing', 12, '2026-01-10');
  assert tot = 1000000, 'reducing: principal closes exactly';
  select principal + interest as amt into s from public.kfp_debt_build_schedule(1000000, 1200, 'reducing', 12, '2026-01-10') where seq = 1;
  assert s.amt = 88849, 'reducing: payment of 10,000.00 THB @12% × 12 = 888.49 (' || s.amt || ')';
  select count(*), sum(principal) into n, tot from public.kfp_debt_build_schedule(0, 0, 'custom', 0, null,
    '[{"due_date":"2026-02-01","amount":500},{"due_date":"2026-03-01","amount":700}]');
  assert n = 2 and tot = 1200, 'custom rows';
end $$;

\echo '== P16-T3 Premium member: cards, idempotency, versions'
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare c jsonb; c2 jsonb; got text; begin
  c := public.debt_save_card('{"client_request_id":"11111111-1111-1111-1111-111111111111","name":"KB Kookmin","bank":"KB","country":"KR",
        "currency":"KRW","last4":"1234","credit_limit_minor":5000000,"opening_balance_minor":300000,"opening_date":"2026-10-01",
        "statement_day":25,"due_day":14,"apr_bp":1950,"installment_mode":"per_period"}');
  c2 := public.debt_save_card('{"client_request_id":"11111111-1111-1111-1111-111111111111","name":"dup","currency":"KRW"}');
  assert c->>'id' = c2->>'id' and c2->>'name' = 'KB Kookmin', 'same client_request_id → same card (no duplicate)';
  begin perform public.debt_save_card('{"name":"x","currency":"KRW","last4":"12345678"}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'too_long_last4', 'only 4 digits stored (got ' || got || ')';
  begin perform public.debt_save_card('{"name":"x","currency":"KRW","last4":"12ab"}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like '%credit_cards_last4_check%', 'last4 must be digits';
  begin perform public.debt_save_card('{"name":"x","currency":"USD"}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_currency', 'THB/KRW only';
  c2 := public.debt_save_card(c || '{"name":"KB Card","base_version":1}');
  assert c2->>'name' = 'KB Card' and (c2->>'version')::int = 2, 'update with version';
  begin perform public.debt_save_card(c || '{"name":"stale","base_version":1}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'conflict', 'stale version refused';
  perform public.debt_save_card('{"client_request_id":"22222222-2222-2222-2222-222222222222","name":"SCB","currency":"THB","country":"TH",
        "credit_limit_minor":10000000,"due_day":5,"installment_mode":"full_hold"}');
  perform public.debt_save_card('{"client_request_id":"33333333-3333-3333-3333-333333333333","name":"Shinhan","currency":"KRW","credit_limit_minor":3000000}');
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.credit_cards where user_id = 'd1600000-0000-0000-0000-00000000000a') = 3, 'A has 3 cards';
end $$;

\echo '== P16-T4 installments: create, edit money terms (new revision), edit text (same revision)'
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare kb uuid; p jsonb; p2 jsonb; got text; begin
  select id into kb from public.credit_cards where name = 'KB Card';
  p := public.debt_save_installment(jsonb_build_object('client_request_id', '44444444-4444-4444-4444-444444444444', 'card_id', kb,
        'product', 'iPhone', 'category', 'มือถือ', 'purchase_date', '2026-10-05', 'original_minor', 1500000, 'down_minor', 300000,
        'method', 'zero', 'months', 12, 'first_due_date', '2026-11-14'));
  assert p->>'currency' = 'KRW' and (p->>'financed_minor')::bigint = 1200000 and jsonb_array_length(p->'schedule') = 12, 'plan + 12 rows';
  assert (p->>'monthly_minor')::bigint = 100000 and (p->>'total_payable_minor')::bigint = 1200000, 'monthly 100,000 KRW';
  p2 := public.debt_save_installment((p - 'id' - 'schedule') || jsonb_build_object('card_id', kb, 'client_request_id', '44444444-4444-4444-4444-444444444444'));
  assert p2->>'id' = p->>'id', 'idempotent create';
  p2 := public.debt_save_installment(jsonb_build_object('id', p->>'id', 'base_version', 1, 'card_id', kb, 'product', 'iPhone 17',
        'category', 'มือถือ', 'purchase_date', '2026-10-05', 'original_minor', 1500000, 'down_minor', 300000,
        'method', 'zero', 'months', 12, 'first_due_date', '2026-11-14'));
  assert p2->>'product' = 'iPhone 17' and (p2->>'revision')::int = 1, 'text edit keeps the schedule';
  p2 := public.debt_save_installment(jsonb_build_object('id', p->>'id', 'base_version', 2, 'card_id', kb, 'product', 'iPhone 17',
        'purchase_date', '2026-10-05', 'original_minor', 1500000, 'down_minor', 300000,
        'method', 'fixed', 'rate_bp', 1200, 'months', 6, 'first_due_date', '2026-11-14'));
  assert (p2->>'revision')::int = 2 and jsonb_array_length(p2->'schedule') = 6, 'money edit → revision 2 with 6 rows';
  assert (p2->>'total_payable_minor')::bigint = 1200000 + 72000, 'flat 12% × 6 months';
  begin perform public.debt_save_installment(jsonb_build_object('id', p->>'id', 'base_version', 1, 'card_id', kb, 'product', 'x',
        'purchase_date', '2026-10-05', 'original_minor', 100, 'method', 'zero', 'months', 1, 'first_due_date', '2026-11-14'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'conflict', 'stale plan version refused';
  begin perform public.debt_save_installment(jsonb_build_object('card_id', kb, 'product', 'x', 'purchase_date', '2026-10-05',
        'original_minor', 100, 'down_minor', 100, 'method', 'zero', 'months', 1, 'first_due_date', '2026-11-14'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_amount', 'down payment must be below price';
  -- shop installment (no card), THB, reducing
  perform public.debt_save_installment(jsonb_build_object('client_request_id', '55555555-5555-5555-5555-555555555555',
        'currency', 'THB', 'product', 'มอเตอร์ไซค์', 'merchant', 'ไฟแนนซ์', 'purchase_date', '2026-09-01',
        'original_minor', 5000000, 'down_minor', 1000000, 'method', 'reducing', 'rate_bp', 1500, 'months', 24, 'first_due_date', '2026-10-01'));
end $$;
reset role;
do $$ declare pid uuid; begin
  select id into pid from public.installment_plans where product = 'iPhone 17';
  assert (select count(*) from public.installment_schedules where plan_id = pid and revision = 1 and superseded_at is not null) = 12, 'old rows kept as history';
  assert (select count(*) from public.installment_schedules where plan_id = pid and superseded_at is null) = 6, 'one live revision';
end $$;

\echo '== P16-T5 payments: shop plan FIFO, card plans paid through the card, settlement'
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare shop uuid; iph uuid; kb uuid; pm jsonb; pm2 jsonb; got text; begin
  select id into shop from public.installment_plans where product = 'มอเตอร์ไซค์';
  select id into iph from public.installment_plans where product = 'iPhone 17';
  select id into kb from public.credit_cards where name = 'KB Card';
  pm := public.debt_record_payment(jsonb_build_object('client_request_id', '66666666-6666-6666-6666-666666666666', 'plan_id', shop,
        'kind', 'partial', 'amount_minor', 150000, 'paid_on', '2026-10-01', 'method', 'bank_transfer'));
  pm2 := public.debt_record_payment(jsonb_build_object('client_request_id', '66666666-6666-6666-6666-666666666666', 'plan_id', shop,
        'kind', 'partial', 'amount_minor', 150000, 'paid_on', '2026-10-01'));
  assert pm->>'id' = pm2->>'id' and pm->>'currency' = 'THB', 'double submit → one payment';
  begin perform public.debt_record_payment(jsonb_build_object('plan_id', iph, 'kind', 'full', 'amount_minor', 1000, 'paid_on', '2026-11-14'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'plan_on_card', 'card installments are paid by paying the card';
  perform public.debt_record_payment(jsonb_build_object('card_id', kb, 'kind', 'statement', 'amount_minor', 250000, 'paid_on', '2026-10-14'));
  begin perform public.debt_record_payment(jsonb_build_object('card_id', kb, 'kind', 'full', 'amount_minor', 100, 'principal_minor', 90,
        'interest_minor', 20, 'paid_on', '2026-10-14')); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like '%debt_payment_split_ck%', 'principal + interest + fee ≤ amount';
  pm := public.debt_record_payment(jsonb_build_object('plan_id', shop, 'kind', 'settlement', 'amount_minor', 3900000, 'paid_on', '2026-11-01'));
  assert (select status from public.installment_plans where id = shop) = 'settled', 'settlement closes the plan';
  perform public.debt_cancel_payment((pm->>'id')::uuid);
  assert (select status from public.installment_plans where id = shop) = 'active', 'cancelling the settlement re-opens it';
  assert (select count(*) from public.debt_payments where plan_id = shop) = 2, 'cancelled payment kept as history';
end $$;
reset role;

\echo '== P16-T6 transfers: confirm is atomic, no double counting, cross-currency needs fx, reversal'
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare kb uuid; sh uuid; scb uuid; t jsonb; got text; pl int; begin
  select id into kb from public.credit_cards where name = 'KB Card';
  select id into sh from public.credit_cards where name = 'Shinhan';
  select id into scb from public.credit_cards where name = 'SCB';
  t := public.debt_save_transfer(jsonb_build_object('client_request_id', '77777777-7777-7777-7777-777777777777', 'type', 'balance_transfer',
        'from_card_id', kb, 'to_card_id', sh, 'amount_minor', 600000, 'fee_minor', 6000, 'rate_bp', 0, 'installments', 6,
        'transfer_date', '2026-11-01', 'effective_date', '2026-11-03'));
  assert t->>'status' = 'draft' and (t->>'dest_amount_minor')::bigint = 600000, 'draft, same currency dest = amount';
  assert (select count(*) from public.installment_plans where transfer_id = (t->>'id')::uuid) = 0, 'draft creates nothing';
  t := public.debt_set_transfer_status((t->>'id')::uuid, 'confirmed', (t->>'version')::bigint);
  assert t->>'status' = 'confirmed' and t->>'confirmed_at' is not null, 'confirmed';
  select count(*) into pl from public.installment_plans where transfer_id = (t->>'id')::uuid and card_id = sh and months = 6 and method = 'zero';
  assert pl = 1, '6-month 0% plan created on the destination card';
  begin perform public.debt_set_transfer_status((t->>'id')::uuid, 'confirmed', (t->>'version')::bigint); got := 'ok';
        exception when others then got := sqlerrm; end;
  assert got in ('invalid_transition', 'conflict'), 'cannot confirm twice';
  begin perform public.debt_save_transfer(jsonb_build_object('type', 'balance_transfer', 'from_card_id', kb, 'to_card_id', scb,
        'amount_minor', 100000, 'transfer_date', '2026-11-01')); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'fx_required', 'KRW → THB needs rate + destination amount';
  t := public.debt_save_transfer(jsonb_build_object('type', 'balance_transfer', 'from_card_id', kb, 'to_card_id', scb,
        'amount_minor', 100000, 'dest_amount_minor', 254000, 'fx_rate', '0.0254', 'fx_date', '2026-11-01', 'transfer_date', '2026-11-01',
        'status', 'confirmed'));
  assert t->>'status' = 'confirmed' and t->>'dest_currency' = 'THB' and t->>'fx_source' = 'manual', 'cross-currency snapshot stored';
  begin perform public.debt_save_transfer(jsonb_build_object('type', 'card_payment', 'from_card_id', kb, 'to_card_id', kb,
        'amount_minor', 1, 'transfer_date', '2026-11-01')); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'same_card', 'card cannot pay itself';
  select * into t from (select to_jsonb(x) j from public.debt_transfers x where client_request_id = '77777777-7777-7777-7777-777777777777') q, lateral (select j) z(t);
  t := public.debt_set_transfer_status((t->>'id')::uuid, 'cancelled', (t->>'version')::bigint);
  assert t->>'status' = 'cancelled', 'confirmed → cancelled (reversal)';
  assert (select status from public.installment_plans where transfer_id = (t->>'id')::uuid) = 'cancelled', 'its plan is cancelled too';
end $$;
reset role;

\echo '== P16-T7 adjustments / reconciliation · payoff plan · archive & delete rules'
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare kb uuid; a jsonb; got text; pp jsonb; c jsonb; begin
  select id into kb from public.credit_cards where name = 'KB Card';
  a := public.debt_add_adjustment(jsonb_build_object('card_id', kb, 'kind', 'refund', 'amount_minor', 5000, 'effective_date', '2026-10-20'));
  assert (a->>'amount_minor')::bigint = -5000, 'refund stored as negative';
  begin perform public.debt_add_adjustment(jsonb_build_object('card_id', kb, 'kind', 'reconcile', 'amount_minor', 1200, 'effective_date', '2026-10-25'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'statement_balance_required', 'reconcile needs the statement balance';
  a := public.debt_add_adjustment(jsonb_build_object('card_id', kb, 'kind', 'reconcile', 'amount_minor', 1200, 'statement_balance_minor', 451200,
        'effective_date', '2026-10-25'));
  assert a->>'kind' = 'reconcile' and (a->>'statement_balance_minor')::bigint = 451200, 'reconciled to the statement';
  pp := public.debt_save_payoff_plan('{"name":"ปลดหนี้ปีหน้า","strategy":"avalanche","currency":"KRW","budget_minor":800000,
        "priorities":[],"assumptions":{"min_pct":3},"result":{"months":14}}');
  assert pp->>'strategy' = 'avalanche', 'payoff plan saved';
  begin perform public.debt_delete_card(kb); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'card_has_history', 'card with history cannot be deleted';
  select to_jsonb(x) into c from public.credit_cards x where id = kb;
  c := public.debt_set_card_status(kb, 'archived', (c->>'version')::bigint);
  assert c->>'status' = 'archived', 'archive instead';
  begin perform public.debt_save_installment(jsonb_build_object('card_id', kb, 'product', 'x', 'purchase_date', '2026-10-05',
        'original_minor', 100, 'method', 'zero', 'months', 1, 'first_due_date', '2026-11-14')); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'card_archived', 'no new plans on an archived card';
end $$;
reset role;

\echo '== P16-T8 other members: no reading, no writing through ids'
select public.test_login('d1600000-0000-0000-0000-00000000000b');
do $$ declare kb uuid; got text; begin
  assert (select count(*) from public.credit_cards) = 0, 'B sees none of A''s cards';
  assert (select count(*) from public.installment_schedules) = 0 and (select count(*) from public.debt_payments) = 0, 'nor rows';
  select id into kb from public.credit_cards limit 1;
  assert kb is null, 'RLS hides ids';
end $$;
reset role;
do $$ declare kb uuid; iph uuid; got text; begin
  select id into kb from public.credit_cards where name = 'Shinhan';
  select id into iph from public.installment_plans where product = 'iPhone 17';
  perform public.test_login('d1600000-0000-0000-0000-00000000000b');
  begin perform public.debt_record_payment(jsonb_build_object('card_id', kb, 'kind', 'full', 'amount_minor', 1, 'paid_on', '2026-11-01'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'card_not_found', 'B cannot pay A''s card';
  begin perform public.debt_save_installment(jsonb_build_object('id', iph, 'base_version', 1, 'product', 'hack', 'currency', 'KRW',
        'purchase_date', '2026-10-05', 'original_minor', 1, 'method', 'zero', 'months', 1, 'first_due_date', '2026-11-14'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'plan_not_found', 'B cannot edit A''s plan';
  begin perform public.debt_delete_payoff_plan((select id from public.debt_payoff_plans limit 1)); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'payoff_not_found', 'B cannot delete A''s plan';
  reset role;
end $$;

\echo '== P16-T9 no direct table writes from the browser (REST bypass)'
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare got text; begin
  begin insert into public.credit_cards (user_id, name, currency) values ('d1600000-0000-0000-0000-00000000000a', 'x', 'THB'); got := 'ok';
        exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'no INSERT';
  begin update public.credit_cards set credit_limit_minor = 1; got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'no UPDATE';
  begin delete from public.debt_payments; got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'no DELETE';
  begin update public.installment_schedules set amount_minor = 0; got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'schedules read-only';
  begin perform public.kfp_debt_write_guard(); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'internal helpers not callable';
end $$;
reset role;
select public.test_login(null);
do $$ declare got text; begin
  begin perform count(*) from public.credit_cards; got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'anon cannot read';
  begin perform public.get_my_debt_access(); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like 'permission denied%', 'anon cannot call';
end $$;
reset role;

\echo '== P16-T10 Premium expired → read-only (sees everything, writes nothing)'
update public.user_entitlements set expires_at = now() - interval '1 minute' where user_id = 'd1600000-0000-0000-0000-00000000000a';
select public.test_login('d1600000-0000-0000-0000-00000000000a');
do $$ declare acc jsonb; ex jsonb; got text; kb uuid; begin
  acc := public.get_my_debt_access();
  assert acc->>'mode' = 'read_only' and (acc->>'has_data')::boolean, 'mode read_only: ' || (acc->>'mode');
  assert (select count(*) from public.credit_cards) = 3, 'all cards visible';
  assert (select count(*) from public.installment_plans) = 3, 'all plans visible (incl. transfer plan)';
  assert (select count(*) from public.installment_schedules) > 40, 'all rows visible incl. history';
  assert (select count(*) from public.debt_payments) = 3 and (select count(*) from public.debt_transfers) = 2, 'payments + transfers visible';
  assert (select count(*) from public.debt_payoff_plans) = 1, 'saved payoff plan visible';
  ex := public.export_my_debt();
  assert jsonb_array_length(ex->'credit_cards') = 3 and jsonb_array_length(ex->'installment_schedules') > 40, 'export works';
  select id into kb from public.credit_cards where name = 'Shinhan';
  begin perform public.debt_save_card('{"name":"new","currency":"KRW"}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'add card refused';
  begin perform public.debt_record_payment(jsonb_build_object('card_id', kb, 'kind', 'full', 'amount_minor', 1, 'paid_on', '2026-11-01'));
        got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'payment refused';
  begin perform public.debt_delete_payoff_plan((select id from public.debt_payoff_plans limit 1)); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'delete refused';
  begin perform public.debt_set_card_status(kb, 'archived', 1); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'archive refused';
  begin perform public.debt_confirm_schedule((select id from public.installment_schedules limit 1), 1); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'statement confirm refused';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.credit_cards where user_id = 'd1600000-0000-0000-0000-00000000000a') = 3, 'nothing deleted on expiry';
end $$;

\echo '== P16-T11 never Premium → locked; subscription states (cancel within period, period over, grace, resubscribe)'
select public.test_login('d1600000-0000-0000-0000-00000000000f');
do $$ declare got text; begin
  assert public.get_my_debt_access()->>'mode' = 'locked', 'never premium + no data = locked';
  begin perform public.debt_save_card('{"name":"x","currency":"THB"}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'free cannot create';
end $$;
reset role;
-- S: Premium subscription cancelled but still inside the paid period
insert into public.subscriptions (user_id, plan_id, status, cancel_at_period_end, canceled_at, current_period_start, current_period_end,
                                  billing_interval, currency, unit_amount_minor, provider_subscription_id)
values ('d1600000-0000-0000-0000-000000000005', 'premium', 'active', true, now() - interval '2 days', now() - interval '10 days',
        now() + interval '20 days', 'month', 'THB', 19900, 'sub_p16_s');
select public.test_login('d1600000-0000-0000-0000-000000000005');
do $$ declare acc jsonb; begin
  acc := public.get_my_debt_access();
  assert acc->>'mode' = 'full' and (acc->>'cancel_at_period_end')::boolean and acc->>'canceled_at' is not null, 'cancelled in paid period = full';
  perform public.debt_save_card('{"name":"KTC","currency":"THB"}');
end $$;
reset role;
update public.subscriptions set current_period_end = now() - interval '1 minute', current_period_start = now() - interval '31 days'
where provider_subscription_id = 'sub_p16_s';
select public.test_login('d1600000-0000-0000-0000-000000000005');
do $$ begin assert public.get_my_debt_access()->>'mode' = 'read_only', 'period over = read-only'; end $$;
reset role;
update public.subscriptions set status = 'past_due', current_period_start = now() - interval '2 days', current_period_end = now() - interval '1 minute'
where provider_subscription_id = 'sub_p16_s';
select public.test_login('d1600000-0000-0000-0000-000000000005');
do $$ begin assert public.get_my_debt_access()->>'mode' = 'full', 'payment failed inside grace = full'; end $$;
reset role;
update public.subscriptions set status = 'past_due', current_period_start = now() - interval '9 days' where provider_subscription_id = 'sub_p16_s';
select public.test_login('d1600000-0000-0000-0000-000000000005');
do $$ begin assert public.get_my_debt_access()->>'mode' = 'read_only', 'grace over = read-only'; end $$;
reset role;
update public.subscriptions set status = 'active', cancel_at_period_end = false, current_period_start = now(), current_period_end = now() + interval '30 days'
where provider_subscription_id = 'sub_p16_s';
select public.test_login('d1600000-0000-0000-0000-000000000005');
do $$ begin
  assert public.get_my_debt_access()->>'mode' = 'full', 'resubscribed = full again';
  perform public.debt_save_card('{"name":"KTC 2","currency":"THB"}');
end $$;
reset role;

\echo '== P16-T12 suspended member: read-only on own data'
update public.profiles set suspended_at = now() where user_id = 'd1600000-0000-0000-0000-00000000000b';
insert into public.credit_cards (user_id, name, currency) values ('d1600000-0000-0000-0000-00000000000b', 'B card', 'THB');
select public.test_login('d1600000-0000-0000-0000-00000000000b');
do $$ declare got text; begin
  assert public.get_my_debt_access()->>'mode' = 'read_only', 'suspended = read only';
  begin perform public.debt_save_card('{"name":"x","currency":"THB"}'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'premium_required', 'suspended cannot write';
end $$;
reset role;
update public.profiles set suspended_at = null where user_id = 'd1600000-0000-0000-0000-00000000000b';

\echo '== P16-T13 security self-check'
select set_config('request.jwt.claims', '', false);
do $$ begin
  assert (select count(*) from public.kfp_security_report() where severity <> 'INFO') = 0,
    'security report: ' || coalesce((select string_agg(check_name || ' ' || object, '; ') from public.kfp_security_report() where severity <> 'INFO'), '');
end $$;

\echo '== ALL PHASE 16 SQL TESTS PASSED'
