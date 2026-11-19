-- =====================================================================
-- PLANNER · Pictures in the support chat (19/11/2026) — migration 2000
--
--  Members can attach a picture to a support message. Pictures live in Supabase Storage
--  (private bucket "support-images"), never in the database; the database keeps only the path.
--
--  Keeping the free plan safe (1 GB file storage / 5 GB egress):
--   • the browser shrinks every picture before upload (≤ 1280 px, WebP/JPEG, ~100–300 KB, no EXIF/GPS)
--   • bucket: private, max 1 MB per file, only image/jpeg, image/png, image/webp
--   • a member may upload at most 10 pictures per 24 h, only into their own folder <user id>/<uuid>.<ext>
--   • uploads stop when the bucket holds 800 MB (head-room under the 1 GB quota)
--   • closing a conversation hides its pictures at once; pictures also expire 30 days after sending.
--     Files are then deleted through the Storage API by the Admin Console (Supabase blocks deleting
--     storage rows with SQL), using admin_support_image_sweep() to find what to delete.
--   • the text of the conversation is kept (a few KB) — only pictures are removed
--
--  Browser API:  member  support_send_image(path, caption, w, h)
--                staff   admin_support_image_sweep()  (admin+)
--  Changed (same signatures): get_my_support · admin_support_threads · admin_support_thread ·
--                admin_support_set_status (closing now hides pictures) · kfp_security_report
--  Additive and re-runnable. Rollback: drop the 4 storage policies planner_support_img_*, the bucket
--  (after emptying it in Studio), support_send_image / admin_support_image_sweep / kfp_support_img_ok /
--  kfp_support_msg_json, then re-run migration 1900 (restores the old function bodies).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. message columns: a message is text, a picture, or both
-- ---------------------------------------------------------------------
alter table public.support_messages add column if not exists image_path       text;
alter table public.support_messages add column if not exists image_w          smallint;
alter table public.support_messages add column if not exists image_h          smallint;
alter table public.support_messages add column if not exists image_bytes      integer;
alter table public.support_messages add column if not exists image_removed_at timestamptz;
create unique index if not exists support_messages_image_uidx on public.support_messages (image_path) where image_path is not null;
create index if not exists support_messages_image_live_idx on public.support_messages (created_at) where image_path is not null and image_removed_at is null;

do $$
begin
  -- the text may now be empty when a picture is attached (old rule: 1–2000 characters always)
  if not exists (select 1 from pg_constraint where conrelid = 'public.support_messages'::regclass and conname = 'support_messages_body_or_image') then
    alter table public.support_messages drop constraint if exists support_messages_body_check;
    alter table public.support_messages add constraint support_messages_body_or_image
      check (char_length(btrim(body)) <= 2000 and (char_length(btrim(body)) >= 1 or image_path is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.support_messages'::regclass and conname = 'support_messages_image_path_fmt') then
    alter table public.support_messages add constraint support_messages_image_path_fmt
      check (image_path is null or image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. private bucket (1 MB per file, pictures only)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then raise notice 'storage schema not found — bucket skipped'; return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('support-images', 'support-images', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
end $$;

-- ---------------------------------------------------------------------
-- 3. upload rule (used by the storage INSERT policy): own folder, file name pattern,
--    not suspended, ≤ 10 per 24 h, bucket below 800 MB
-- ---------------------------------------------------------------------
create or replace function public.kfp_support_img_ok(p_name text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null
     and coalesce(p_name, '') ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$')
     and not exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.suspended_at is not null)
     and (select count(*) from storage.objects o
          where o.bucket_id = 'support-images' and o.name like auth.uid()::text || '/%' and o.created_at > now() - interval '24 hours') < 10
     and (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'support-images') < 838860800
$$;
revoke all on function public.kfp_support_img_ok(text) from public, anon;
grant execute on function public.kfp_support_img_ok(text) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is null then raise notice 'storage schema not found — policies skipped'; return; end if;
  -- member: upload only into <own id>/…
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'planner_support_img_insert') then
    create policy planner_support_img_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'support-images' and public.kfp_support_img_ok(name));
  end if;
  -- member reads own pictures; staff (viewer+) reads all
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'planner_support_img_select') then
    create policy planner_support_img_select on storage.objects for select to authenticated
      using (bucket_id = 'support-images' and (name like auth.uid()::text || '/%' or public.is_admin('viewer')));
  end if;
  -- only admin/owner delete (clean-up from the Admin Console); nobody updates/overwrites
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'planner_support_img_delete') then
    create policy planner_support_img_delete on storage.objects for delete to authenticated
      using (bucket_id = 'support-images' and public.is_admin('admin'));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. one message → json (internal). A picture is shown while the conversation is open
--    and for 30 days; after that only "picture removed" is returned.
-- ---------------------------------------------------------------------
create or replace function public.kfp_support_msg_json(x public.support_messages)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object('id', x.id, 'sender', x.sender, 'body', x.body, 'created_at', x.created_at)
      || case when x.image_path is null then '{}'::jsonb
              when x.image_removed_at is null and x.created_at > now() - interval '30 days'
                then jsonb_build_object('image', x.image_path, 'image_w', x.image_w, 'image_h', x.image_h)
              else jsonb_build_object('image_removed', true) end
$$;
revoke all on function public.kfp_support_msg_json(public.support_messages) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. member: send a picture (uploaded first through the Storage API) with an optional caption
-- ---------------------------------------------------------------------
create or replace function public.support_send_image(p_path text, p_body text default '', p_w integer default null, p_h integer default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  b text := btrim(coalesce(p_body, ''));
  v_size bigint;
  m public.support_messages;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if char_length(b) > 2000 then raise exception 'invalid_message' using errcode = '22023'; end if;
  if coalesce(p_path, '') !~ ('^' || me::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$') then
    raise exception 'invalid_image' using errcode = '22023';
  end if;
  select coalesce((o.metadata ->> 'size')::bigint, 0) into v_size
  from storage.objects o where o.bucket_id = 'support-images' and o.name = p_path;
  if not found then raise exception 'image_not_found' using errcode = '22023'; end if;
  if exists (select 1 from public.support_messages where image_path = p_path) then raise exception 'invalid_image' using errcode = '22023'; end if;
  if not public.kfp_rate_hit('support:' || me::text, 20, 3600) then raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.support_threads as t (user_id, status, last_message_at, last_user_at, user_read_at)
  values (me, 'open', now(), now(), now())
  on conflict (user_id) do update set status = 'open', last_message_at = now(), last_user_at = now(), user_read_at = now();
  insert into public.support_messages (user_id, sender, sender_id, body, image_path, image_w, image_h, image_bytes)
  values (me, 'user', me, b, p_path,
          case when p_w between 1 and 10000 then p_w end, case when p_h between 1 and 10000 then p_h end, least(v_size, 2147483647))
  returning * into m;
  return public.kfp_support_msg_json(m);
end;
$$;
revoke all on function public.support_send_image(text, text, integer, integer) from public, anon;
grant execute on function public.support_send_image(text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 6. existing feeds now carry pictures (signatures unchanged)
-- ---------------------------------------------------------------------
create or replace function public.get_my_support(p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  lim int := least(greatest(coalesce(p_limit, 100), 1), 300);
  t public.support_threads;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into t from public.support_threads where user_id = me;
  return jsonb_build_object(
    'status', coalesce(t.status, 'open'),
    'user_read_at', t.user_read_at,
    'ann_read_at', t.ann_read_at,
    'unread', public.kfp_support_unread(me),
    -- tells the app that pictures are switched on, and how many are left today
    'images', jsonb_build_object('per_day', 10, 'max_bytes', 1048576, 'keep_days', 30,
      'left_today', greatest(0, 10 - (select count(*) from storage.objects o
                                      where o.bucket_id = 'support-images' and o.name like me::text || '/%'
                                        and o.created_at > now() - interval '24 hours'))::int),
    'messages', coalesce((
      select jsonb_agg(public.kfp_support_msg_json(x) order by x.created_at)
      from public.support_messages x
      where x.id in (select id from public.support_messages where user_id = me order by created_at desc limit lim)), '[]'::jsonb),
    'announcements', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'kind', a.kind, 'created_at', a.created_at, 'expires_at', a.expires_at) order by a.created_at)
      from (select * from public.announcements where deleted_at is null and (expires_at is null or expires_at > now())
            order by created_at desc limit 20) a), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_my_support(integer) from public, anon;
grant execute on function public.get_my_support(integer) to authenticated;

create or replace function public.admin_support_threads(p_filter text default 'all', p_q text default null,
                                                        p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  off int := greatest(coalesce(p_offset, 0), 0);
  q text := nullif(btrim(coalesce(p_q, '')), '');
  f text := coalesce(p_filter, 'all');
  res jsonb;
begin
  perform public.kfp_require_admin('viewer');
  if f not in ('all', 'unread', 'open', 'closed') then f := 'all'; end if;
  with base as (
    select t.user_id, t.status, t.last_message_at, t.last_user_at, t.last_admin_at,
           coalesce(pr.email, u.email) as email, pr.username, pr.nickname,
           (select count(*) from public.support_messages m where m.user_id = t.user_id and m.sender = 'user'
              and m.created_at > coalesce(t.admin_read_at, '-infinity'::timestamptz))::int as unread,
           (select jsonb_build_object('sender', m.sender,
                                      'body', case when btrim(m.body) = '' and m.image_path is not null then '[รูปภาพ]' else left(m.body, 140) end,
                                      'image', m.image_path is not null, 'created_at', m.created_at)
              from public.support_messages m where m.user_id = t.user_id order by m.created_at desc limit 1) as last
    from public.support_threads t
    join auth.users u on u.id = t.user_id
    left join public.profiles pr on pr.user_id = t.user_id
    where t.last_message_at is not null
      and (q is null or coalesce(pr.email, u.email) ilike '%' || q || '%' or pr.username ilike '%' || q || '%'
           or pr.nickname ilike '%' || q || '%' or t.user_id::text = q)
  ), filtered as (
    select * from base
    where f = 'all' or (f = 'unread' and unread > 0) or (f = 'open' and status = 'open') or (f = 'closed' and status = 'closed')
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'unread_total', (select coalesce(sum(unread), 0) from base),
    'unread_threads', (select count(*) from base where unread > 0),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.unread > 0 desc, r.last_message_at desc)
                      from (select * from filtered order by unread > 0 desc, last_message_at desc limit lim offset off) r), '[]'::jsonb))
  into res;
  return res;
end;
$$;
revoke all on function public.admin_support_threads(text, text, integer, integer) from public, anon;
grant execute on function public.admin_support_threads(text, text, integer, integer) to authenticated;

create or replace function public.admin_support_thread(p_user uuid, p_limit integer default 200)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  r int := public.kfp_require_admin('viewer');
  lim int := least(greatest(coalesce(p_limit, 200), 1), 500);
  t public.support_threads;
  res jsonb;
begin
  select * into t from public.support_threads where user_id = p_user;
  -- reading clears the staff "unread" counter — only for staff who can answer (viewer stays read-only)
  if found and r >= public.kfp_role_rank('admin') then
    update public.support_threads set admin_read_at = now() where user_id = p_user;
  end if;
  select jsonb_build_object(
    'user', (select jsonb_build_object('user_id', u.id, 'email', coalesce(pr.email, u.email), 'username', pr.username, 'nickname', pr.nickname,
                                       'country', pr.country, 'registered_at', u.created_at, 'suspended', pr.suspended_at is not null)
             from auth.users u left join public.profiles pr on pr.user_id = u.id where u.id = p_user),
    'status', coalesce(t.status, 'open'),
    'user_read_at', t.user_read_at,
    'messages', coalesce((
      select jsonb_agg(public.kfp_support_msg_json(x)
                       || jsonb_build_object('staff', case when x.sender = 'admin' then coalesce(sp.nickname, sp.username, 'admin') end)
                       order by x.created_at)
      from public.support_messages x
      left join public.profiles sp on sp.user_id = x.sender_id
      where x.id in (select id from public.support_messages where user_id = p_user order by created_at desc limit lim)), '[]'::jsonb))
  into res;
  if res->'user' is null or res->'user' = 'null'::jsonb then raise exception 'user_not_found' using errcode = '22023'; end if;
  return res;
end;
$$;
revoke all on function public.admin_support_thread(uuid, integer) from public, anon;
grant execute on function public.admin_support_thread(uuid, integer) to authenticated;

-- closing a conversation hides its pictures at once (the files are deleted by the sweep below)
create or replace function public.admin_support_set_status(p_user uuid, p_status text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare v_old text; v_img int := 0;
begin
  perform public.kfp_require_admin('admin');
  if p_status not in ('open', 'closed') then raise exception 'invalid_status' using errcode = '22023'; end if;
  select status into v_old from public.support_threads where user_id = p_user;
  if not found then raise exception 'user_not_found' using errcode = '22023'; end if;
  update public.support_threads set status = p_status where user_id = p_user;
  if p_status = 'closed' then
    update public.support_messages set image_removed_at = now()
    where user_id = p_user and image_path is not null and image_removed_at is null;
    get diagnostics v_img = row_count;
  end if;
  perform public.kfp_audit('support.status', p_user, 'support_threads', p_user::text,
    jsonb_build_object('status', v_old), jsonb_build_object('status', p_status, 'images_removed', v_img), 'support status');
  return jsonb_build_object('user_id', p_user, 'status', p_status, 'images_removed', v_img);
end;
$$;
revoke all on function public.admin_support_set_status(uuid, text) from public, anon;
grant execute on function public.admin_support_set_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. staff: which files should be deleted now (the Admin Console deletes them through the
--    Storage API, then they disappear from this list). Also reports bucket usage.
--      • pictures of closed conversations / older than 30 days
--      • uploads never attached to a message (older than 1 day)
-- ---------------------------------------------------------------------
create or replace function public.admin_support_image_sweep(p_limit integer default 200)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare lim int := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  perform public.kfp_require_admin('admin');
  return jsonb_build_object(
    'paths', coalesce((
      select jsonb_agg(z.name order by z.created_at) from (
        select o.name, o.created_at
        from storage.objects o
        left join public.support_messages m on m.image_path = o.name
        where o.bucket_id = 'support-images'
          and ((m.id is null and o.created_at < now() - interval '1 day')
               or m.image_removed_at is not null
               or m.created_at <= now() - interval '30 days')
        order by o.created_at limit lim) z), '[]'::jsonb),
    'files', (select count(*) from storage.objects o where o.bucket_id = 'support-images'),
    'bytes', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'support-images'),
    'quota_bytes', 1073741824,
    'upload_stop_bytes', 838860800
  );
end;
$$;
revoke all on function public.admin_support_image_sweep(integer) from public, anon;
grant execute on function public.admin_support_image_sweep(integer) to authenticated;

-- ---------------------------------------------------------------------
-- 8. security self-check: allowlist the new RPCs + keep the bucket private
-- ---------------------------------------------------------------------
create or replace function public.kfp_security_report()
returns table (severity text, check_name text, object text, detail text)
language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare
  -- the complete browser API (anything else that is SECURITY DEFINER must not be callable)
  api_anon text[] := array['is_username_available'];
  api_auth text[] := array['is_username_available', 'has_feature', 'is_admin', 'get_my_entitlements', 'get_my_billing',
                           'get_my_gold', 'save_my_gold', 'touch_activity',
                           'admin_whoami', 'admin_overview', 'admin_list_users', 'admin_user_detail', 'admin_revenue',
                           'admin_audit_list', 'admin_list_prices', 'admin_set_price', 'admin_deactivate_price',
                           'admin_set_plan', 'admin_extend_access', 'admin_revoke_access', 'admin_set_suspended',
                           'admin_activity_analytics', 'admin_user_activity', 'export_my_gold', 'admin_set_role',
                           -- Smart Credit & Debt (migration 1700)
                           'get_my_debt_access', 'export_my_debt', 'debt_save_card', 'debt_set_card_status', 'debt_delete_card',
                           'debt_save_installment', 'debt_set_installment_status', 'debt_delete_installment', 'debt_confirm_schedule',
                           'debt_record_payment', 'debt_cancel_payment', 'debt_save_transfer', 'debt_set_transfer_status',
                           'debt_delete_transfer', 'debt_add_adjustment', 'debt_cancel_adjustment',
                           'debt_save_payoff_plan', 'debt_delete_payoff_plan',
                           'admin_set_addons', 'get_my_notices', 'ack_my_notices',
                           -- support chat + announcements (migration 1900)
                           'get_my_support_unread', 'get_my_support', 'support_send', 'support_mark_read',
                           'admin_support_threads', 'admin_support_thread', 'admin_support_reply', 'admin_support_set_status',
                           'admin_announcements', 'admin_announce', 'admin_announce_delete',
                           -- pictures in the support chat (migration 2000; kfp_support_img_ok is the storage upload rule)
                           'support_send_image', 'admin_support_image_sweep', 'kfp_support_img_ok'];
  anon_read text[] := array['plans', 'plan_prices'];
begin
  -- service_role (Edge/CI) or the SQL Editor (database owner session, no API token)
  if not (coalesce(auth.role(), '') = 'service_role' or public.kfp_is_db_owner_session()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select 'HIGH', 'rls_disabled', c.relname::text, 'table without row level security'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

  return query
  select 'HIGH', 'definer_without_search_path', p.oid::regprocedure::text, 'SECURITY DEFINER without SET search_path'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

  return query
  select 'HIGH', 'definer_callable_by_anon', p.oid::regprocedure::text, 'not part of the public API'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
    and not (p.proname = any (api_anon));

  return query
  select 'HIGH', 'definer_callable_by_authenticated', p.oid::regprocedure::text, 'not part of the member/admin API'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
    and not (p.proname = any (api_auth));

  return query
  select 'HIGH', 'anon_write_grant', g.table_name::text, string_agg(g.privilege_type, ',')
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.grantee in ('anon', 'PUBLIC') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  group by g.table_name;

  return query
  select 'HIGH', 'authenticated_write_grant', g.table_name::text, string_agg(g.privilege_type, ',')
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.grantee = 'authenticated' and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.table_name = 'user_data' and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
  group by g.table_name;

  return query
  select 'HIGH', 'authenticated_column_update', (c.table_name || '.' || c.column_name)::text, 'browser can change this column'
  from information_schema.column_privileges c
  where c.table_schema = 'public' and c.grantee = 'authenticated' and c.privilege_type = 'UPDATE'
    and not ((c.table_name = 'profiles' and c.column_name in ('nickname', 'country'))
          or (c.table_name = 'user_data' and c.column_name in ('user_id', 'data', 'updated_at')));

  return query
  select 'MEDIUM', 'anon_readable_table', g.table_name::text, 'readable without login'
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.grantee in ('anon', 'PUBLIC') and g.privilege_type = 'SELECT'
    and not (g.table_name = any (anon_read));

  return query
  select 'MEDIUM', 'open_policy', (pl.tablename || '.' || pl.policyname)::text, coalesce(pl.qual, '(no USING)')
  from pg_policies pl
  where pl.schemaname = 'public' and pl.cmd in ('SELECT', 'ALL')
    and (pl.qual is null or pl.qual in ('true', '(true)'))
    and not (pl.tablename = any (anon_read));

  -- support pictures must stay in a private bucket
  if to_regclass('storage.buckets') is not null then
    return query
    select 'HIGH', 'public_bucket', b.id::text, 'support pictures must not be public'
    from storage.buckets b where b.id = 'support-images' and b.public;
  end if;

  return query
  select 'INFO', 'no_owner', 'admin_roles', 'no owner yet — add one with SQL (docs/SETUP.md Phase 6)'
  where not exists (select 1 from public.admin_roles where role = 'owner');
end;
$$;
revoke all on function public.kfp_security_report() from public, anon, authenticated;
grant execute on function public.kfp_security_report() to service_role;
