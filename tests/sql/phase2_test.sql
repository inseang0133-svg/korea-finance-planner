-- Phase 2 tests. Run order: 00_supabase_stub.sql → ../../supabase_schema.sql (current prod)
-- → seed below → migrations 0100 + 0200 → assertions below.
\set ON_ERROR_STOP on

-- ---------- seed: production as it is today (legacy accounts) ----------
insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, created_at) values
 ('11111111-1111-1111-1111-111111111111', 'john@kfp.example.com',   now() - interval '200 days', now() - interval '1 day', now() - interval '200 days'),
 ('22222222-2222-2222-2222-222222222222', 'somchai@kfp.example.com',now() - interval '100 days', now() - interval '3 days', now() - interval '100 days');
-- old client also upserted profiles with nickname
update public.profiles set nickname = 'จอห์น' where user_id = '11111111-1111-1111-1111-111111111111';
insert into public.user_data (user_id, data) values
 ('11111111-1111-1111-1111-111111111111', '{"salary":"2500000","kfp_gold_lots_v1":"[{\"id\":\"a\"}]"}'),
 ('22222222-2222-2222-2222-222222222222', '{"salary":"2100000"}');

\echo '== apply migrations'
\ir ../../supabase/migrations/20261113000100_saas_core_auth.sql
\ir ../../supabase/migrations/20261113000100_saas_core_auth.sql
\echo '   (applied twice: re-runnable OK)'
\ir ../../supabase/migrations/20261113000200_legacy_launch_grant.sql
\ir ../../supabase/migrations/20261113000200_legacy_launch_grant.sql
\ir ../../supabase/migrations/20261113000300_rate_limits.sql
\ir ../../supabase/migrations/20261113000300_rate_limits.sql

\echo '== T1 legacy data preserved, profile backfilled'
do $$ declare r record; begin
  select * into r from public.profiles where user_id = '11111111-1111-1111-1111-111111111111';
  assert r.username = 'john' and r.nickname = 'จอห์น', 'legacy username/nickname kept';
  assert r.email = 'john@kfp.example.com' and r.is_legacy_email, 'legacy email flagged';
  assert r.email_verified_at is not null, 'legacy verified timestamp copied';
  assert (select data->>'salary' from public.user_data where user_id = r.user_id) = '2500000', 'user_data untouched';
  assert (select count(*) from public.user_entitlements where reason = 'legacy_launch') = 2, 'one 90-day grant per legacy user (idempotent)';
  assert (select bool_and(expires_at between now() + interval '89 days' and now() + interval '91 days')
          from public.user_entitlements where reason='legacy_launch'), 'grant lasts 90 days';
end $$;

\echo '== T2 R1 fixed: real e-mail whose local part equals an existing username can sign up'
insert into auth.users (id, email, raw_user_meta_data) values
 ('33333333-3333-3333-3333-333333333333', 'john@gmail.com', '{"username":"johnny","display_name":"Johnny B"}'),
 ('44444444-4444-4444-4444-444444444444', 'john@yahoo.com', '{}'),
 ('55555555-5555-5555-5555-555555555555', 'x@hotmail.com',  '{"username":"johnny"}');
do $$ begin
  assert (select username from public.profiles where user_id='33333333-3333-3333-3333-333333333333') = 'johnny', 'metadata username used';
  assert (select nickname from public.profiles where user_id='33333333-3333-3333-3333-333333333333') = 'Johnny B', 'display name used';
  assert (select username from public.profiles where user_id='44444444-4444-4444-4444-444444444444') like 'john-%', 'clash on fallback gets suffix, signup not blocked';
  assert (select username from public.profiles where user_id='55555555-5555-5555-5555-555555555555') like 'johnny-%', 'race on chosen username gets suffix';
  assert not (select is_legacy_email from public.profiles where user_id='33333333-3333-3333-3333-333333333333'), 'real email not legacy';
  assert (select email_verified_at from public.profiles where user_id='33333333-3333-3333-3333-333333333333') is null, 'unverified until confirmed';
  assert (select count(*) from public.user_entitlements where user_id='33333333-3333-3333-3333-333333333333') = 0, 'new users get no legacy grant';
end $$;

\echo '== T3 e-mail confirmation + legacy link-email sync'
update auth.users set email_confirmed_at = now() where id = '33333333-3333-3333-3333-333333333333';
update auth.users set email = 'john.real@gmail.com', email_confirmed_at = now() where id = '11111111-1111-1111-1111-111111111111';
do $$ begin
  assert (select email_verified_at from public.profiles where user_id='33333333-3333-3333-3333-333333333333') is not null, 'verification synced';
  assert (select email from public.profiles where user_id='11111111-1111-1111-1111-111111111111') = 'john.real@gmail.com', 'linked email synced';
  assert not (select is_legacy_email from public.profiles where user_id='11111111-1111-1111-1111-111111111111'), 'legacy flag cleared after link';
  assert (select username from public.profiles where user_id='11111111-1111-1111-1111-111111111111') = 'john', 'username unchanged by email link';
end $$;

\echo '== T4 RLS / privileges as an authenticated user'
select public.test_login('22222222-2222-2222-2222-222222222222');
do $$ declare n int; begin
  -- can read only own profile
  select count(*) into n from public.profiles; assert n = 1, 'sees only own profile, saw ' || n;
  -- may update nickname
  update public.profiles set nickname = 'สมชาย' where user_id = auth.uid();
  -- may NOT change email / legacy flag / username / suspension
  begin update public.profiles set email = 'evil@x.com' where user_id = auth.uid(); assert false, 'email writable!';
  exception when insufficient_privilege then null; end;
  begin update public.profiles set suspended_at = null, is_legacy_email = false where user_id = auth.uid(); assert false, 'flags writable!';
  exception when insufficient_privilege then null; end;
  begin update public.profiles set username = 'admin' where user_id = auth.uid(); assert false, 'username writable!';
  exception when insufficient_privilege then null; end;
  -- cannot grant itself premium
  begin insert into public.user_entitlements (user_id, plan_id) values (auth.uid(), 'premium'); assert false, 'entitlement insertable!';
  exception when insufficient_privilege then null; end;
  begin update public.user_entitlements set expires_at = null where user_id = auth.uid(); assert false, 'entitlement updatable!';
  exception when insufficient_privilege then null; end;
  -- sees only own entitlements
  select count(*) into n from public.user_entitlements; assert n = 1, 'own entitlement only, saw ' || n;
  -- cannot edit plans
  begin update public.plans set features = '{}' where id = 'free'; assert false, 'plans writable!';
  exception when insufficient_privilege then null; end;
  -- legacy cloud data still readable/writable exactly as before
  select count(*) into n from public.user_data; assert n = 1, 'own user_data only';
  update public.user_data set data = data || '{"goal":"1"}' where user_id = auth.uid();
end $$;
reset role;
do $$ begin
  assert (select nickname from public.profiles where user_id='22222222-2222-2222-2222-222222222222') = 'สมชาย', 'nickname update worked';
end $$;

\echo '== T5 anon: username check only returns booleans, cannot read profiles'
select public.test_login(null);
do $$ declare n int; begin
  assert public.is_username_available('john') = false, 'taken';
  assert public.is_username_available('newname') = true, 'free';
  assert public.is_username_available('JOHN') = false, 'uppercase rejected';
  assert public.is_username_available('a b') = false, 'invalid rejected';
  assert public.is_username_available('ab') = false, 'too short rejected';
  begin select count(*) into n from public.profiles; assert false, 'anon read profiles!';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.plans; assert n = 3, 'anon can read plans for pricing page';
end $$;
reset role;
\echo '== T6 username-login helpers (service_role only)'
set role service_role;
do $$ begin
  assert public.kfp_login_email_for_username('somchai') = 'somchai@kfp.example.com', 'legacy username resolves';
  assert public.kfp_login_email_for_username('john') = 'john.real@gmail.com', 'linked account resolves to real email';
  assert public.kfp_login_email_for_username('nobody') is null, 'unknown -> null';
  for i in 1..3 loop assert public.kfp_rate_hit('t:k', 3, 600), 'within limit'; end loop;
  assert not public.kfp_rate_hit('t:k', 3, 600), '4th hit blocked';
  update public.rate_limits set window_start = now() - interval '11 minutes' where key = 't:k';
  assert public.kfp_rate_hit('t:k', 3, 600), 'window resets';
end $$;
reset role;
update public.profiles set suspended_at = now() where username = 'somchai';
set role service_role;
do $$ begin assert public.kfp_login_email_for_username('somchai') is null, 'suspended cannot use username login'; end $$;
reset role;
update public.profiles set suspended_at = null where username = 'somchai';
select public.test_login('22222222-2222-2222-2222-222222222222');
do $$ begin
  begin perform public.kfp_login_email_for_username('john'); assert false, 'user can resolve emails!';
  exception when insufficient_privilege then null; end;
  begin perform public.kfp_rate_hit('x', 1, 1); assert false, 'user can call rate hit!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.test_login(null);
do $$ begin
  begin perform public.kfp_login_email_for_username('john'); assert false, 'anon can resolve emails!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
\echo '== ALL PHASE 2 SQL TESTS PASSED'
