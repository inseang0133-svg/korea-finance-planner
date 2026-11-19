-- Phase 19 tests: pictures in the support chat (storage bucket rules, send, hide on close, 30-day expiry, sweep).
-- Runs after phase 2–18. Users from phase 10: …001 owner, …002 admin, …003 viewer, …007 premium, …010 member.
\set ON_ERROR_STOP on
\echo '== apply migration 2000 (twice: re-runnable)'
\ir ../../supabase/migrations/20261119002000_support_images.sql
\ir ../../supabase/migrations/20261119002000_support_images.sql

delete from public.support_messages; delete from public.support_threads; delete from public.announcements;
delete from public.rate_limits where key like 'support%';
delete from storage.objects where bucket_id = 'support-images';

-- helper: "upload" a file as the current role (goes through the storage RLS policies like the Storage API)
create or replace function public.test_upload(p_name text, p_size bigint default 180000) returns text language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, metadata) values ('support-images', p_name, jsonb_build_object('size', p_size, 'mimetype', 'image/webp'));
  return 'ok';
exception when others then return sqlerrm;
end $$;
grant execute on function public.test_upload(text, bigint) to authenticated, anon;

\echo '== P19-T1 private bucket: 1 MB per file, pictures only'
do $$ begin
  assert (select not public and file_size_limit = 1048576 and allowed_mime_types = array['image/jpeg','image/png','image/webp']
          from storage.buckets where id = 'support-images'), 'bucket settings';
  assert (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'planner_support_img_%') = 3, 'three storage policies';
end $$;

\echo '== P19-T2 upload rules: own folder + file name pattern only, 10 per 24 h, no overwrite/delete by members'
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare me text := 'b1000000-0000-0000-0000-000000000010'; got text; i int; begin
  assert public.test_upload(me || '/a0000000-0000-4000-8000-000000000001.webp') = 'ok', 'own folder ok';
  got := public.test_upload('b1000000-0000-0000-0000-000000000007/a0000000-0000-4000-8000-000000000002.webp');
  assert got like '%row-level security%', 'someone else''s folder blocked: ' || got;
  got := public.test_upload(me || '/evil.gif');
  assert got like '%row-level security%', 'bad file name blocked: ' || got;
  got := public.test_upload(me || '/sub/a0000000-0000-4000-8000-000000000003.webp');
  assert got like '%row-level security%', 'sub-folder blocked: ' || got;
  for i in 2..10 loop
    assert public.test_upload(me || '/a0000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0') || '.jpg') = 'ok', 'upload ' || i;
  end loop;
  got := public.test_upload(me || '/a0000000-0000-4000-8000-000000000011.jpg');
  assert got like '%row-level security%', '11th picture in 24 h blocked: ' || got;
  assert (select count(*) from storage.objects where bucket_id = 'support-images') = 10, 'member sees own 10 files';
  delete from storage.objects where bucket_id = 'support-images';
  update storage.objects set name = name || 'x' where bucket_id = 'support-images';
end $$;
reset role;
do $$ begin
  assert (select count(*) from storage.objects where bucket_id = 'support-images' and name not like '%x') = 10, 'member cannot delete or rename';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000007');
do $$ begin
  assert (select count(*) from storage.objects where bucket_id = 'support-images') = 0, 'another member sees none of them';
end $$;
reset role;
set role anon;
do $$ declare got text; begin
  got := public.test_upload('b1000000-0000-0000-0000-000000000010/a0000000-0000-4000-8000-000000000012.webp');
  assert got <> 'ok', 'anon cannot upload: ' || got;
end $$;
reset role;

\echo '== P19-T3 send a picture: caption optional, own uploaded file only, each file once'
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare me text := 'b1000000-0000-0000-0000-000000000010'; j jsonb; got text; begin
  j := public.support_send_image(me || '/a0000000-0000-4000-8000-000000000001.webp', '  สลิปโอนเงินครับ ', 1280, 960);
  assert j->>'image' = me || '/a0000000-0000-4000-8000-000000000001.webp' and j->>'body' = 'สลิปโอนเงินครับ'
     and (j->>'image_w')::int = 1280 and (j->>'image_h')::int = 960, 'picture + caption: ' || j::text;
  j := public.support_send_image(me || '/a0000000-0000-4000-8000-000000000002.jpg');
  assert j->>'body' = '' and j ? 'image', 'picture without caption: ' || j::text;
  begin perform public.support_send_image(me || '/a0000000-0000-4000-8000-000000000001.webp'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_image', 'same file twice: ' || got;
  begin perform public.support_send_image(me || '/a0000000-0000-4000-8000-000000000099.webp'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'image_not_found', 'not uploaded: ' || got;
  begin perform public.support_send_image('b1000000-0000-0000-0000-000000000007/a0000000-0000-4000-8000-000000000003.webp'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_image', 'another member''s path: ' || got;
  begin perform public.support_send_image('../etc/passwd'); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_image', 'bad path: ' || got;
  begin perform public.support_send(''); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'invalid_message', 'text message still needs text: ' || got;
  j := public.get_my_support();
  assert jsonb_array_length(j->'messages') = 2 and j->'messages'->0 ? 'image' and not (j->'messages'->0 ? 'image_removed'), 'feed has both pictures';
  assert (j->'images'->>'per_day')::int = 10 and (j->'images'->>'left_today')::int = 0, 'quota in the feed: ' || (j->'images')::text;
end $$;
reset role;
do $$ declare got text; begin
  begin insert into public.support_messages (user_id, sender, body) values ('b1000000-0000-0000-0000-000000000010', 'user', '  '); got := 'ok';
  exception when others then got := sqlerrm; end;
  assert got like '%support_messages_body_or_image%', 'empty message without picture rejected by the table: ' || got;
  begin insert into public.support_messages (user_id, sender, body, image_path) values ('b1000000-0000-0000-0000-000000000010', 'user', '', 'x/../y.webp'); got := 'ok';
  exception when others then got := sqlerrm; end;
  assert got like '%support_messages_image_path_fmt%', 'bad stored path rejected: ' || got;
  assert (select image_bytes from public.support_messages where image_path like '%000000000001.webp') = 180000, 'size recorded from storage';
end $$;
-- both were sent inside one transaction (same now()); make the picture-only one the latest, as in real life
update public.support_messages set created_at = created_at + interval '1 second' where image_path like '%000000000002.jpg';

\echo '== P19-T4 staff: viewer sees pictures but cannot delete files or sweep; inbox preview says [รูปภาพ]'
select public.test_login('b1000000-0000-0000-0000-000000000003');
do $$ declare j jsonb; got text; begin
  j := public.admin_support_thread('b1000000-0000-0000-0000-000000000010');
  assert jsonb_array_length(j->'messages') = 2 and j->'messages'->0 ? 'image', 'viewer sees pictures';
  j := public.admin_support_threads();
  assert j->'rows'->0->'last'->>'body' = '[รูปภาพ]' and (j->'rows'->0->'last'->>'image')::boolean, 'preview: ' || (j->'rows'->0->'last')::text;
  assert (select count(*) from storage.objects where bucket_id = 'support-images') = 10, 'viewer can read files (signed links)';
  delete from storage.objects where bucket_id = 'support-images';
  begin perform public.admin_support_image_sweep(); got := 'ok'; exception when others then got := sqlerrm; end;
  assert got = 'forbidden', 'viewer cannot sweep: ' || got;
end $$;
reset role;
do $$ begin assert (select count(*) from storage.objects where bucket_id = 'support-images') = 10, 'viewer deleted nothing'; end $$;

\echo '== P19-T5 closing hides pictures at once; sweep lists them; admin deletes; text stays'
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare j jsonb; begin
  j := public.admin_support_image_sweep();
  assert jsonb_array_length(j->'paths') = 0 and (j->>'files')::int = 10 and (j->>'bytes')::bigint = 1800000, 'nothing to delete yet: ' || j::text;
  j := public.admin_support_set_status('b1000000-0000-0000-0000-000000000010', 'closed');
  assert (j->>'images_removed')::int = 2, 'two pictures hidden: ' || j::text;
  j := public.admin_support_thread('b1000000-0000-0000-0000-000000000010');
  assert (j->'messages'->0->>'image_removed')::boolean and not (j->'messages'->0 ? 'image') and j->'messages'->0->>'body' = 'สลิปโอนเงินครับ', 'text kept, picture gone';
  j := public.admin_support_image_sweep();
  assert jsonb_array_length(j->'paths') = 2, 'sweep lists the two closed pictures: ' || j::text;
  -- what the Admin Console does through the Storage API
  delete from storage.objects where bucket_id = 'support-images' and name in (select jsonb_array_elements_text(j->'paths'));
  j := public.admin_support_image_sweep();
  assert jsonb_array_length(j->'paths') = 0 and (j->>'files')::int = 8, 'deleted: ' || j::text;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.admin_audit_logs where action = 'support.status' and after->>'images_removed' = '2'), 'closing audited with picture count';
end $$;

\echo '== P19-T6 reopening keeps old pictures hidden; new picture shows; 30-day expiry; unsent uploads swept after 1 day'
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare me text := 'b1000000-0000-0000-0000-000000000010'; j jsonb; begin
  j := public.support_send_image(me || '/a0000000-0000-4000-8000-000000000003.jpg', 'อีกรูป');
  j := public.get_my_support();
  assert j->>'status' = 'open', 'member message reopens the conversation';
  assert (select count(*) from jsonb_array_elements(j->'messages') e where (e->>'image_removed')::boolean) = 2
     and (select count(*) from jsonb_array_elements(j->'messages') e where e->>'image' like '%000000000003.jpg') = 1, 'old hidden, new shown: ' || (j->'messages')::text;
end $$;
reset role;
update public.support_messages set created_at = now() - interval '31 days' where image_path like '%000000000003.jpg';
update storage.objects set created_at = now() - interval '2 days' where name like '%000000000004.jpg';
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare j jsonb; begin
  j := public.get_my_support();
  assert (select count(*) from jsonb_array_elements(j->'messages') e where e ? 'image') = 0, 'picture older than 30 days is hidden';
end $$;
select public.test_login('b1000000-0000-0000-0000-000000000002');
do $$ declare j jsonb; begin
  j := public.admin_support_image_sweep();
  assert jsonb_array_length(j->'paths') = 2
     and (j->'paths') ? 'b1000000-0000-0000-0000-000000000010/a0000000-0000-4000-8000-000000000003.jpg'
     and (j->'paths') ? 'b1000000-0000-0000-0000-000000000010/a0000000-0000-4000-8000-000000000004.jpg',
    '30-day picture + 2-day-old unsent upload (fresh unsent uploads are left alone): ' || j::text;
end $$;
reset role;

\echo '== P19-T7 uploads stop at 800 MB in the bucket; suspended members cannot upload'
delete from storage.objects where bucket_id = 'support-images';
insert into storage.objects (bucket_id, name, metadata) values ('support-images', 'b1000000-0000-0000-0000-000000000007/a0000000-0000-4000-8000-0000000000aa.webp', '{"size": 838860800}');
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare got text; begin
  got := public.test_upload('b1000000-0000-0000-0000-000000000010/a0000000-0000-4000-8000-0000000000ab.webp');
  assert got like '%row-level security%', 'bucket full: ' || got;
end $$;
reset role;
delete from storage.objects where bucket_id = 'support-images';
update public.profiles set suspended_at = now() where user_id = 'b1000000-0000-0000-0000-000000000010';
select public.test_login('b1000000-0000-0000-0000-000000000010');
do $$ declare got text; begin
  got := public.test_upload('b1000000-0000-0000-0000-000000000010/a0000000-0000-4000-8000-0000000000ac.webp');
  assert got like '%row-level security%', 'suspended: ' || got;
end $$;
reset role;
update public.profiles set suspended_at = null where user_id = 'b1000000-0000-0000-0000-000000000010';

\echo '== P19-T8 security self-check (and it notices a public bucket)'
drop function public.test_upload(text, bigint);
select set_config('request.jwt.claims', '', false);
do $$ begin
  assert (select count(*) from public.kfp_security_report() where severity <> 'INFO') = 0,
    'security report: ' || coalesce((select string_agg(check_name || ' ' || object, '; ') from public.kfp_security_report() where severity <> 'INFO'), '');
  update storage.buckets set public = true where id = 'support-images';
  assert exists (select 1 from public.kfp_security_report() where check_name = 'public_bucket'), 'public bucket flagged';
  update storage.buckets set public = false where id = 'support-images';
end $$;

\echo '== ALL PHASE 19 SQL TESTS PASSED'
