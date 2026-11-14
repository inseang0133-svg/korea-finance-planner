-- Phase 12 · Security audit (database). Runs after phase2…phase11 (tests/run-sql-tests.sh).
-- Checks the whole schema generically, so a future table/function that forgets RLS or a
-- grant is caught here, not only the cases written by hand.
\set ON_ERROR_STOP on
\echo '== apply migration 1100 (twice: re-runnable)'
select set_config('request.jwt.claims', '', false);
\ir ../../supabase/migrations/20261114001100_security_hardening.sql
\ir ../../supabase/migrations/20261114001100_security_hardening.sql

\echo '== S1 self-check report is clean, and detects problems'
set role service_role;
do $$ declare n int; r record; begin
  select count(*) into n from public.kfp_security_report() where severity in ('HIGH', 'MEDIUM');
  if n > 0 then
    for r in select * from public.kfp_security_report() loop raise notice '%', r; end loop;
  end if;
  assert n = 0, n || ' security findings';
end $$;
reset role;
begin;
  create table public.t12_leaky (id int);                                         -- no RLS
  create function public.t12_backdoor() returns int language sql security definer as $$ select 1 $$;   -- no search_path, PUBLIC execute
  grant select on public.subscriptions to anon;
  set role service_role;
  do $$ declare c text[]; begin
    select array_agg(distinct check_name) into c from public.kfp_security_report();
    assert c @> array['rls_disabled', 'definer_without_search_path', 'definer_callable_by_anon', 'definer_callable_by_authenticated', 'anon_readable_table'],
      'report must flag the planted problems: ' || c::text;
  end $$;
  reset role;
rollback;
select public.test_login('a0000000-0000-0000-0000-000000000014');
do $$ begin
  begin perform public.kfp_security_report(); assert false, 'member ran the report'; exception when insufficient_privilege then null; end;
end $$;
reset role;

\echo '== S2 every SECURITY DEFINER function: search_path set; only the published API is callable'
do $$ declare r record; bad text := ''; begin
  for r in select p.oid::regprocedure::text as f, p.proname,
                  has_function_privilege('anon', p.oid, 'execute') as a, has_function_privilege('authenticated', p.oid, 'execute') as u
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef loop
    if r.proname like 'kfp\_%' and (r.a or r.u) then bad := bad || ' ' || r.f; end if;              -- internals never callable
    if r.proname like 'admin\_%' and r.a then bad := bad || ' anon:' || r.f; end if;
  end loop;
  assert bad = '', 'internal functions callable from the browser:' || bad;
end $$;

\echo '== S3 data isolation: member X sees nothing of member Y in ANY table (generic, all tables)'
insert into auth.users (id, email, email_confirmed_at) values
 ('d1000000-0000-0000-0000-00000000000a', 'x@p12.test', now()), ('d1000000-0000-0000-0000-00000000000b', 'y@p12.test', now());
-- Y gets a row in every member table
insert into public.user_data (user_id, data) values ('d1000000-0000-0000-0000-00000000000b', '{"salary":"999"}'), ('d1000000-0000-0000-0000-00000000000a', '{"salary":"1"}');
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, provider_subscription_id, currency, billing_interval, unit_amount_minor)
values ('d1000000-0000-0000-0000-00000000000b', 'premium', 'active', now(), now() + interval '30 days', 'sub_p12_y', 'THB', 'month', 19900);
insert into public.billing_customers (user_id, provider_customer_id) values ('d1000000-0000-0000-0000-00000000000b', 'cus_p12_y');
insert into public.payments (user_id, provider_invoice_id, currency, amount_due_minor, amount_paid_minor, status) values ('d1000000-0000-0000-0000-00000000000b', 'in_p12_y', 'THB', 19900, 19900, 'paid');
insert into public.payment_refunds (payment_id, amount_minor, currency) select id, 100, 'THB' from public.payments where provider_invoice_id = 'in_p12_y';
insert into public.user_entitlements (user_id, plan_id, reason) values ('d1000000-0000-0000-0000-00000000000b', 'plus', 'admin_grant');
insert into public.user_activity (user_id, page) values ('d1000000-0000-0000-0000-00000000000b', 'index.html');
insert into public.user_activity_daily (user_id, day, events) values ('d1000000-0000-0000-0000-00000000000b', current_date, 1);
insert into public.user_gold_data (user_id, lots) values ('d1000000-0000-0000-0000-00000000000b', '[{"id":"y1"}]');
select public.test_login('d1000000-0000-0000-0000-00000000000a');
do $$ declare t record; n bigint; leaks text := ''; checked int := 0; begin
  for t in select c.relname as tbl, exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'user_id') as has_uid
           from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and c.relname not in ('plans', 'plan_prices') loop
    begin
      if t.tbl = 'payment_refunds' then
        execute 'select count(*) from public.payment_refunds r where not exists (select 1 from public.payments p where p.id = r.payment_id and p.user_id = auth.uid())' into n;
      elsif t.has_uid then
        execute format('select count(*) from public.%I where user_id is distinct from auth.uid()', t.tbl) into n;
      else
        execute format('select count(*) from public.%I', t.tbl) into n;
      end if;
      if n > 0 then leaks := leaks || ' ' || t.tbl || '=' || n; end if;
    exception when insufficient_privilege then null;                -- not readable at all: fine
    end;
    checked := checked + 1;
  end loop;
  assert leaks = '', 'member X can read other people''s rows:' || leaks;
  assert checked >= 16, 'checked ' || checked || ' tables';
  raise notice 'P12 isolation: % tables checked for member X', checked;
end $$;
reset role;
select public.test_login(null);
do $$ declare t record; n bigint; leaks text := ''; begin
  for t in select c.relname as tbl from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and c.relname not in ('plans', 'plan_prices') loop
    begin execute format('select count(*) from public.%I', t.tbl) into n; if n > 0 then leaks := leaks || ' ' || t.tbl; end if;
    exception when insufficient_privilege then null; end;
  end loop;
  assert leaks = '', 'anonymous visitor can read:' || leaks;
  assert (select count(*) from public.plan_prices where not active) = 0, 'anon sees only active prices';
end $$;
reset role;

\echo '== S4 privilege escalation & subscription manipulation (member X)'
select public.test_login('d1000000-0000-0000-0000-00000000000a');
do $$ declare n int; begin
  -- own profile: only nickname/country
  begin update public.profiles set suspended_at = null, username = 'root' where user_id = auth.uid(); assert false, 'profile protected columns';
  exception when insufficient_privilege then null; end;
  begin update public.profiles set email = 'other@x' where user_id = auth.uid(); assert false, 'email column'; exception when insufficient_privilege then null; end;
  begin update public.profiles set nickname = 'x', updated_at = now() where user_id = auth.uid(); assert false, 'updated_at is not a browser column';
  exception when insufficient_privilege then null; end;
  update public.profiles set nickname = 'นิค' where user_id = auth.uid();               -- what auth.js sends (Phase 12 fix)
  get diagnostics n = row_count; assert n = 1, 'nickname update works';
  begin update public.profiles set nickname = repeat('a', 61) where user_id = auth.uid(); assert false, 'nickname > 60'; exception when check_violation then null; end;
  begin update public.profiles set country = 'th' where user_id = auth.uid(); assert false, 'country format'; exception when check_violation then null; end;
  update public.profiles set country = 'TH' where user_id = auth.uid();
  update public.profiles set nickname = 'hijack' where user_id = 'd1000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count; assert n = 0, 'cannot edit another profile';
  begin insert into public.profiles (user_id, username) values (gen_random_uuid(), 'fake'); assert false, 'profile insert'; exception when insufficient_privilege then null; end;
  begin delete from public.profiles where user_id = auth.uid(); assert false, 'profile delete'; exception when insufficient_privilege then null; end;
  -- billing / entitlement tables are read-only for members
  begin insert into public.subscriptions (user_id, plan_id, status) values (auth.uid(), 'premium', 'active'); assert false, 'sub insert'; exception when insufficient_privilege then null; end;
  begin update public.subscriptions set status = 'active'; assert false, 'sub update'; exception when insufficient_privilege then null; end;
  begin insert into public.user_entitlements (user_id, plan_id) values (auth.uid(), 'premium'); assert false, 'grant insert'; exception when insufficient_privilege then null; end;
  begin insert into public.payments (user_id, currency, status) values (auth.uid(), 'THB', 'paid'); assert false, 'payment insert'; exception when insufficient_privilege then null; end;
  begin insert into public.admin_roles (user_id, role) values (auth.uid(), 'owner'); assert false, 'admin insert'; exception when insufficient_privilege then null; end;
  begin insert into public.user_gold_data (user_id) values (auth.uid()); assert false, 'gold insert'; exception when insufficient_privilege then null; end;
  begin perform public.save_my_gold('[]', '{}', null); assert false, 'free member saved gold'; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_plan(auth.uid(), 'premium', null, 'self upgrade'); assert false, 'self upgrade'; exception when insufficient_privilege then null; end;
  -- internal/service functions
  begin perform public.kfp_apply_subscription('{}'); assert false, 'apply_subscription'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_audit('x', null, null, null, null, null, 'x'); assert false, 'audit'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_rate_hit('x', 1, 1); assert false, 'rate_hit'; exception when insufficient_privilege then null; end;
  begin perform public.kfp_effective_plan(auth.uid()); assert false, 'effective_plan'; exception when insufficient_privilege then null; end;
  -- user_data: own row only, shape + size limits, plan rules
  update public.user_data set data = '{"salary":"0"}' where user_id = 'd1000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count; assert n = 0, 'cannot overwrite Y''s cloud data';
  begin insert into public.user_data (user_id, data) values ('d1000000-0000-0000-0000-00000000000b', '{}') on conflict (user_id) do update set data = excluded.data;
        assert false, 'upsert into Y'; exception when insufficient_privilege or check_violation then null; end;
  begin delete from public.user_data where user_id = 'd1000000-0000-0000-0000-00000000000b'; get diagnostics n = row_count; assert n = 0, 'deleted Y'; end;
  -- entitlements are computed, not claimed
  assert public.get_my_entitlements()->>'plan' = 'free', 'X is free no matter what the browser says';
end $$;
reset role;
-- size / shape limits apply to everyone who can write user_data (here: a Premium member)
select public.test_login('a0000000-0000-0000-0000-000000000014');
do $$ begin
  begin update public.user_data set data = '[1,2,3]' where user_id = auth.uid(); assert false, 'array accepted'; exception when invalid_parameter_value then null; end;
  begin update public.user_data set data = jsonb_build_object('blob', repeat('x', 2100000)) where user_id = auth.uid(); assert false, '2 MB accepted';
  exception when invalid_parameter_value then null; end;
  update public.user_data set data = data || '{"salary":"7"}' where user_id = auth.uid();
end $$;
reset role;

\echo '== S5 injection strings are data, never SQL'
select public.test_login('b1000000-0000-0000-0000-000000000001');       -- owner from phase 10
do $$ declare r jsonb; n0 bigint := (select count(*) from public.admin_audit_logs); begin
  r := public.admin_list_users(jsonb_build_object('q', $q$'; delete from public.profiles; --$q$, 'sort', 'email; drop table public.plans', 'dir', 'asc'));
  assert jsonb_typeof(r->'rows') = 'array' and (r->>'total')::int = 0, 'search string treated as text';
  r := public.admin_audit_list(jsonb_build_object('action_prefix', $q$%' or 1=1 --$q$));
  assert (r->>'total')::int = 0, 'audit filter treated as text';
  assert public.is_username_available($q$a'; drop table public.profiles; --$q$) = false, 'username check';
  perform public.touch_activity($q$x'); drop table public.profiles; --$q$, 'page');
  perform public.touch_activity($q$<script>alert(1)</script>$q$, 'feature');
end $$;
reset role;
do $$ begin
  assert to_regclass('public.profiles') is not null and to_regclass('public.plans') is not null, 'tables intact';
  assert (select last_page from public.profiles where user_id = 'b1000000-0000-0000-0000-000000000001') !~ '[''; ]', 'page name sanitised';
  assert exists (select 1 from public.user_activity where user_id = 'b1000000-0000-0000-0000-000000000001' and kind = 'feature' and page = 'scriptalert1script'), 'feature name sanitised';
end $$;

\echo '== S6 every browser-callable function refuses anonymous callers (except the username check)'
do $$ declare r record; bad text := ''; begin
  for r in select p.oid::regprocedure::text as f, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') loop
    if r.proname <> 'is_username_available' then bad := bad || ' ' || r.f; end if;
  end loop;
  assert bad = '', 'anon can call:' || bad;
end $$;

\echo '== S7 data portability: own gold exportable on any plan, never someone else''s'
insert into public.user_gold_data (user_id, lots) values ('d1000000-0000-0000-0000-00000000000a', '[{"id":"x1","grams":1,"costThb":3000}]');
select public.test_login('d1000000-0000-0000-0000-00000000000a');      -- X: Free, but has gold from a past Premium period
do $$ declare r jsonb; i int; begin
  assert not (public.get_my_gold()->>'allowed')::boolean, 'X cannot USE the gold portfolio';
  r := public.export_my_gold();
  assert r->'lots' = '[{"id":"x1","grams":1,"costThb":3000}]'::jsonb, 'but can download own gold data (and only own): ' || r::text;
  begin perform public.save_my_gold('[]', '{}', null); assert false, 'export must not allow writing'; exception when insufficient_privilege then null; end;
  for i in 1..9 loop perform public.export_my_gold(); end loop;
  begin perform public.export_my_gold(); assert false, 'no rate limit'; exception when sqlstate '54000' then null; end;
end $$;
reset role;
select public.test_login(null);
do $$ begin begin perform public.export_my_gold(); assert false, 'anon export'; exception when insufficient_privilege then null; end; end $$;
reset role;
delete from public.rate_limits where key like 'goldexport:%';

\echo '== ALL PHASE 12 SQL TESTS PASSED'
