-- Phase 18 tests: support chat (member ↔ staff), announcements, unread counters, roles, rate limits.
-- Runs after phase 2–17. Users from phase 10: …001 owner, …002 admin, …003 viewer, …005 free (signed up 2 h ago), …007 premium, …010 member.
\set ON_ERROR_STOP on
\echo '== apply migration 1900 (twice: re-runnable)'
\ir ../../supabase/migrations/20261119001900_support_chat.sql
\ir ../../supabase/migrations/20261119001900_support_chat.sql

delete from public.support_messages; delete from public.support_threads; delete from public.announcements;
delete from public.rate_limits where key like 'support%' or key like 'announce%';

\echo '== P18-T1 member sends a message → thread + message; own unread stays 0; bad input rejected'
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare j jsonb; got text; begin
  j := public.support_send('  สวัสดีครับ แอดมิน  ');
  assert j->>'sender' = 'user' and j->>'body' = 'สวัสดีครับ แอดมิน', 'stored trimmed: ' || j::text;
  assert public.get_my_support_unread() = 0, 'own message is not unread';
  j := public.get_my_support();
  assert jsonb_array_length(j->'messages') = 1 and j->>'status' = 'open', 'feed has the message';
  begin perform public.support_send('   '); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_message', 'empty rejected: ' || got;
  begin perform public.support_send(repeat('ก', 2001)); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_message', 'too long rejected: ' || got;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.support_threads where user_id = 'b1000000-0000-0000-0000-000000000010' and last_user_at is not null) = 1, 'thread row';
end $$;

\echo '== P18-T2 browser roles cannot touch the tables directly; anon cannot call'
select public.test_login('b1000000-0000-0000-0000-000000000007');
do $$ declare got text; begin
  begin perform 1 from public.support_messages limit 1; got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like '%permission denied%', 'no select grant: ' || got;
  begin insert into public.support_messages (user_id, sender, body) values ('b1000000-0000-0000-0000-000000000010', 'admin', 'fake'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like '%permission denied%', 'no insert grant: ' || got;
  assert jsonb_array_length(public.get_my_support()->'messages') = 0, 'another member sees nothing of …010';
  begin perform public.admin_support_threads(); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'forbidden', 'member cannot list threads: ' || got;
end $$;
reset role;
set role anon;
do $$ declare got text; begin
  begin perform public.support_send('x'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got like '%permission denied%' or got = 'not_authenticated', 'anon blocked: ' || got;
end $$;
reset role;

\echo '== P18-T3 staff inbox: unread for staff; viewer reading does not clear it, admin reading does'
select public.test_login('b1000000-0000-0000-0000-000000000003');
do $$ declare j jsonb; got text; begin
  j := public.admin_support_threads();
  assert (j->>'total')::int = 1 and (j->>'unread_total')::int = 1, 'one thread, one unread: ' || j::text;
  assert j->'rows'->0->>'email' = 'legacy@p10.test' and j->'rows'->0->'last'->>'sender' = 'user', 'row shows member + last message';
  j := public.admin_support_thread('b1000000-0000-0000-0000-000000000010');
  assert jsonb_array_length(j->'messages') = 1 and j->'user'->>'email' = 'legacy@p10.test', 'viewer can read the conversation';
  assert (public.admin_support_threads()->>'unread_total')::int = 1, 'viewer reading keeps it unread';
  begin perform public.admin_support_reply('b1000000-0000-0000-0000-000000000010', 'viewer reply'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'forbidden', 'viewer cannot reply: ' || got;
  begin perform public.admin_announce('t', 'b'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'forbidden', 'viewer cannot announce: ' || got;
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare j jsonb; begin
  j := public.admin_support_thread('b1000000-0000-0000-0000-000000000010');
  assert (public.admin_support_threads()->>'unread_total')::int = 0, 'admin reading clears it';
  assert (public.admin_support_threads('unread')->>'total')::int = 0, 'unread filter empty';
end $$;

\echo '== P18-T4 admin replies → member sees 1 unread; reading in the chat clears it'
do $$ declare j jsonb; got text; begin
  j := public.admin_support_reply('b1000000-0000-0000-0000-000000000010', 'ได้รับแล้วครับ <b>ขอบคุณ</b>');
  assert j->>'sender' = 'admin', 'reply stored';
  begin perform public.admin_support_reply('b1000000-0000-0000-0000-000000000010', ''); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_message', 'empty reply rejected: ' || got;
  begin perform public.admin_support_reply('b1000000-0000-0000-0000-0000000000ff', 'x'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'user_not_found', 'unknown member: ' || got;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.admin_audit_logs where action = 'support.reply' and target_user_id = 'b1000000-0000-0000-0000-000000000010') = 1, 'reply audited';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare j jsonb; begin
  assert public.get_my_support_unread() = 1, 'one unread reply';
  j := public.get_my_support();
  assert j->'messages'->1->>'body' = 'ได้รับแล้วครับ <b>ขอบคุณ</b>' and (j->>'unread')::int = 1, 'reply stored as plain text';
  perform public.support_mark_read();
  assert public.get_my_support_unread() = 0, 'read clears the badge';
end $$;
reset role;

\echo '== P18-T5 announcements: every existing member +1; deleted / expired / older-than-sign-up do not count'
update auth.users set created_at = now() - interval '2 hours' where id = 'b1000000-0000-0000-0000-000000000005';
insert into public.announcements (title, body, created_at) values ('เก่ากว่าวันสมัคร', 'old', now() - interval '1 day');
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare a jsonb; got text; begin
  a := public.admin_announce('ปรับปรุงระบบ', 'คืนนี้ 23:00–23:30 ระบบจะปิดปรับปรุง', 'warning', now() + interval '7 days');
  assert a->>'kind' = 'warning', 'announcement created';
  begin perform public.admin_announce('', 'x'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_message', 'empty title rejected: ' || got;
  begin perform public.admin_announce('t', 'b', 'party'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_kind', 'bad kind: ' || got;
  begin perform public.admin_announce('t', 'b', 'info', now() - interval '1 hour'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_expiry', 'past expiry: ' || got;
end $$;
reset role;
insert into public.announcements (title, body, expires_at, created_at) values ('หมดอายุแล้ว', 'gone', now() - interval '1 minute', now() - interval '1 hour');
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare j jsonb; begin
  assert public.get_my_support_unread() = 1, 'member …010: only the new live announcement is unread (' || public.get_my_support_unread() || ')';
  j := public.get_my_support();
  assert jsonb_array_length(j->'announcements') = 2, 'feed shows the 2 live announcements (old + new), not the expired one';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000005');
do $$ begin
  assert public.get_my_support_unread() = 1, 'new member: announcement from before sign-up not counted (' || public.get_my_support_unread() || ')';
  perform public.support_mark_read();
  assert public.get_my_support_unread() = 0, 'cleared';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare l jsonb; id uuid; begin
  l := public.admin_announcements();
  assert jsonb_array_length(l) = 3, 'staff list shows all 3 (incl. expired)';
  select (x->>'id')::uuid into id from jsonb_array_elements(l) x where x->>'title' = 'ปรับปรุงระบบ';
  assert (select (x->>'reads')::int from jsonb_array_elements(l) x where x->>'title' = 'ปรับปรุงระบบ') = 1, 'read by 1 member (…005)';
  perform public.admin_announce_delete(id, 'พิมพ์ผิด');
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ begin
  assert public.get_my_support_unread() = 0, 'deleted announcement no longer unread';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.admin_audit_logs where action in ('announce.create', 'announce.delete')) = 2, 'announcements audited';
end $$;

\echo '== P18-T6 close / reopen: closed thread reopens when the member writes again'
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare got text; begin
  perform public.admin_support_set_status('b1000000-0000-0000-0000-000000000010', 'closed');
  assert (public.admin_support_threads('closed')->>'total')::int = 1, 'closed filter';
  begin perform public.admin_support_set_status('b1000000-0000-0000-0000-000000000010', 'archived'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_status', 'bad status: ' || got;
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000010');
select public.support_send('ยังมีคำถามอีกข้อครับ') is not null;
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ begin
  assert (public.admin_support_threads('open')->>'total')::int = 1, 'reopened';
  assert (public.admin_support_threads('all', 'legacy@')->>'total')::int = 1 and (public.admin_support_threads('all', 'nobody@')->>'total')::int = 0, 'search';
end $$;
reset role;

\echo '== P18-T7 rate limit: 20 messages per hour per member'
delete from public.rate_limits where key like 'support:%';
select public.test_login('b1000000-0000-0000-0000-000000000007');
do $$ declare got text; i int; begin
  for i in 1..20 loop perform public.support_send('ข้อความ ' || i); end loop;
  begin perform public.support_send('ข้อความที่ 21'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'rate_limited', '21st blocked: ' || got;
end $$;
reset role;

\echo '== P18-T8 deleting a member removes their conversation'
do $$ begin
  insert into auth.users (id, email, email_confirmed_at, created_at, raw_user_meta_data) values ('b1000000-0000-0000-0000-000000000099', 'bye@p18.test', now(), now(), '{"username":"p18bye"}');
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000099');
select public.support_send('ลาก่อน') is not null;
reset role;
delete from auth.users where id = 'b1000000-0000-0000-0000-000000000099';
do $$ begin
  assert (select count(*) from public.support_messages where user_id = 'b1000000-0000-0000-0000-000000000099') = 0, 'messages cascade';
end $$;

\echo '== P18-T9 security self-check'
select set_config('request.jwt.claims', '', false);
do $$ begin
  assert (select count(*) from public.kfp_security_report() where severity <> 'INFO') = 0,
    'security report: ' || coalesce((select string_agg(check_name || ' ' || object, '; ') from public.kfp_security_report() where severity <> 'INFO'), '');
end $$;

\echo '== ALL PHASE 18 SQL TESTS PASSED'
