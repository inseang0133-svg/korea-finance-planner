-- =====================================================================
-- PLANNER · Support chat + announcements (19/11/2026) — migration 1900
--
--  • support_threads   one conversation per member (+ read cursors for member / staff / announcements)
--  • support_messages  member ↔ staff messages (1–2000 chars, plain text)
--  • announcements     broadcast from staff to every member (title + body, optional expiry, soft delete)
--  Browser access ONLY through the functions below (no table grants):
--    member : get_my_support_unread() · get_my_support() · support_send(body) · support_mark_read()
--    staff  : admin_support_threads(...) · admin_support_thread(user)            (viewer+, read)
--             admin_support_reply(user, body) · admin_support_set_status(...)    (admin+, audited)
--             admin_announcements() (viewer+) · admin_announce(...) · admin_announce_delete(...) (admin+, audited)
--  Rate limits: member 20 messages / hour · staff 300 replies / hour · 30 announcements / hour.
-- Additive and re-runnable. Rollback: drop the 11 functions + kfp_support_unread, then the 3 tables,
-- and re-apply kfp_security_report from migration 1800.
-- =====================================================================

create table if not exists public.support_threads (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  status          text not null default 'open' check (status in ('open', 'closed')),
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  last_user_at    timestamptz,
  last_admin_at   timestamptz,
  user_read_at    timestamptz,   -- member has read staff messages up to here
  admin_read_at   timestamptz,   -- staff has read member messages up to here
  ann_read_at     timestamptz    -- member has read announcements up to here
);
create index if not exists support_threads_recent_idx on public.support_threads (last_message_at desc) where last_message_at is not null;
alter table public.support_threads enable row level security;
revoke all on public.support_threads from anon, authenticated, public;
grant select, insert, update, delete on public.support_threads to service_role;
comment on table public.support_threads is 'One support conversation per member. Browser access only via get_my_support / support_* / admin_support_* functions.';

create table if not exists public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.support_threads(user_id) on delete cascade,
  sender     text not null check (sender in ('user', 'admin')),
  sender_id  uuid references auth.users(id) on delete set null,
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists support_messages_thread_idx on public.support_messages (user_id, created_at desc);
alter table public.support_messages enable row level security;
revoke all on public.support_messages from anon, authenticated, public;
grant select, insert, update, delete on public.support_messages to service_role;
comment on table public.support_messages is 'Member ↔ staff messages (plain text). Browser access only via functions.';

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  kind       text not null default 'info' check (kind in ('info', 'success', 'warning')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null
);
create index if not exists announcements_live_idx on public.announcements (created_at desc) where deleted_at is null;
alter table public.announcements enable row level security;
revoke all on public.announcements from anon, authenticated, public;
grant select, insert, update, delete on public.announcements to service_role;
comment on table public.announcements is 'Staff broadcasts to every member. Browser access only via functions.';

-- ---------------------------------------------------------------------
-- internal: unread = staff messages after the member''s read cursor + live announcements after
--           max(announcement cursor, sign-up time)
-- ---------------------------------------------------------------------
create or replace function public.kfp_support_unread(p_uid uuid)
returns integer
language sql stable security definer
set search_path = public
as $$
  with t as (select * from public.support_threads where user_id = p_uid),
       since as (select greatest(coalesce((select ann_read_at from t), '-infinity'::timestamptz),
                                 coalesce((select u.created_at from auth.users u where u.id = p_uid), '-infinity'::timestamptz)) as at)
  select (select count(*) from public.support_messages m
          where m.user_id = p_uid and m.sender = 'admin'
            and m.created_at > coalesce((select user_read_at from t), '-infinity'::timestamptz))::int
       + (select count(*) from public.announcements a, since
          where a.deleted_at is null and (a.expires_at is null or a.expires_at > now()) and a.created_at > since.at)::int
$$;
revoke all on function public.kfp_support_unread(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- member
-- ---------------------------------------------------------------------
create or replace function public.get_my_support_unread()
returns integer
language plpgsql stable security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return public.kfp_support_unread(auth.uid());
end;
$$;
revoke all on function public.get_my_support_unread() from public, anon;
grant execute on function public.get_my_support_unread() to authenticated;

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
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'sender', x.sender, 'body', x.body, 'created_at', x.created_at) order by x.created_at)
      from (select * from public.support_messages where user_id = me order by created_at desc limit lim) x), '[]'::jsonb),
    'announcements', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'kind', a.kind, 'created_at', a.created_at, 'expires_at', a.expires_at) order by a.created_at)
      from (select * from public.announcements where deleted_at is null and (expires_at is null or expires_at > now())
            order by created_at desc limit 20) a), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_my_support(integer) from public, anon;
grant execute on function public.get_my_support(integer) to authenticated;

create or replace function public.support_send(p_body text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  b text := btrim(coalesce(p_body, ''));
  m public.support_messages;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if char_length(b) < 1 or char_length(b) > 2000 then raise exception 'invalid_message' using errcode = '22023'; end if;
  if not public.kfp_rate_hit('support:' || me::text, 20, 3600) then raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.support_threads as t (user_id, status, last_message_at, last_user_at, user_read_at)
  values (me, 'open', now(), now(), now())
  on conflict (user_id) do update set status = 'open', last_message_at = now(), last_user_at = now(), user_read_at = now();
  insert into public.support_messages (user_id, sender, sender_id, body) values (me, 'user', me, b) returning * into m;
  return jsonb_build_object('id', m.id, 'sender', m.sender, 'body', m.body, 'created_at', m.created_at);
end;
$$;
revoke all on function public.support_send(text) from public, anon;
grant execute on function public.support_send(text) to authenticated;

create or replace function public.support_mark_read()
returns integer
language plpgsql volatile security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into public.support_threads as t (user_id, user_read_at, ann_read_at) values (me, now(), now())
  on conflict (user_id) do update set user_read_at = now(), ann_read_at = now();
  return 0;
end;
$$;
revoke all on function public.support_mark_read() from public, anon;
grant execute on function public.support_mark_read() to authenticated;

-- ---------------------------------------------------------------------
-- staff (viewer reads, admin/owner writes — every write is audited)
-- ---------------------------------------------------------------------
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
           (select jsonb_build_object('sender', m.sender, 'body', left(m.body, 140), 'created_at', m.created_at)
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
      select jsonb_agg(jsonb_build_object('id', x.id, 'sender', x.sender, 'body', x.body, 'created_at', x.created_at,
                                          'staff', case when x.sender = 'admin' then coalesce(sp.nickname, sp.username, 'admin') end) order by x.created_at)
      from (select * from public.support_messages where user_id = p_user order by created_at desc limit lim) x
      left join public.profiles sp on sp.user_id = x.sender_id), '[]'::jsonb))
  into res;
  if res->'user' is null or res->'user' = 'null'::jsonb then raise exception 'user_not_found' using errcode = '22023'; end if;
  return res;
end;
$$;
revoke all on function public.admin_support_thread(uuid, integer) from public, anon;
grant execute on function public.admin_support_thread(uuid, integer) to authenticated;

create or replace function public.admin_support_reply(p_user uuid, p_body text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  b text := btrim(coalesce(p_body, ''));
  m public.support_messages;
begin
  perform public.kfp_require_admin('admin');
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'user_not_found' using errcode = '22023'; end if;
  if char_length(b) < 1 or char_length(b) > 2000 then raise exception 'invalid_message' using errcode = '22023'; end if;
  if not public.kfp_rate_hit('support_admin:' || me::text, 300, 3600) then raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.support_threads as t (user_id, status, last_message_at, last_admin_at, admin_read_at)
  values (p_user, 'open', now(), now(), now())
  on conflict (user_id) do update set last_message_at = now(), last_admin_at = now(), admin_read_at = now();
  insert into public.support_messages (user_id, sender, sender_id, body) values (p_user, 'admin', me, b) returning * into m;
  perform public.kfp_audit('support.reply', p_user, 'support_messages', m.id::text, null,
    jsonb_build_object('length', char_length(b), 'preview', left(b, 80)), 'support reply');
  return jsonb_build_object('id', m.id, 'sender', m.sender, 'body', m.body, 'created_at', m.created_at);
end;
$$;
revoke all on function public.admin_support_reply(uuid, text) from public, anon;
grant execute on function public.admin_support_reply(uuid, text) to authenticated;

create or replace function public.admin_support_set_status(p_user uuid, p_status text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare v_old text;
begin
  perform public.kfp_require_admin('admin');
  if p_status not in ('open', 'closed') then raise exception 'invalid_status' using errcode = '22023'; end if;
  select status into v_old from public.support_threads where user_id = p_user;
  if not found then raise exception 'user_not_found' using errcode = '22023'; end if;
  update public.support_threads set status = p_status where user_id = p_user;
  perform public.kfp_audit('support.status', p_user, 'support_threads', p_user::text,
    jsonb_build_object('status', v_old), jsonb_build_object('status', p_status), 'support status');
  return jsonb_build_object('user_id', p_user, 'status', p_status);
end;
$$;
revoke all on function public.admin_support_set_status(uuid, text) from public, anon;
grant execute on function public.admin_support_set_status(uuid, text) to authenticated;

create or replace function public.admin_announcements(p_limit integer default 50)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  perform public.kfp_require_admin('viewer');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'kind', a.kind, 'created_at', a.created_at,
                                        'expires_at', a.expires_at, 'deleted_at', a.deleted_at,
                                        'author', coalesce(p.nickname, p.username, p.email),
                                        'live', a.deleted_at is null and (a.expires_at is null or a.expires_at > now()),
                                        'reads', (select count(*) from public.support_threads t where t.ann_read_at >= a.created_at))
                     order by a.created_at desc)
    from (select * from public.announcements order by created_at desc limit lim) a
    left join public.profiles p on p.user_id = a.created_by), '[]'::jsonb);
end;
$$;
revoke all on function public.admin_announcements(integer) from public, anon;
grant execute on function public.admin_announcements(integer) to authenticated;

create or replace function public.admin_announce(p_title text, p_body text, p_kind text default 'info', p_expires_at timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  tt text := btrim(coalesce(p_title, ''));
  b text := btrim(coalesce(p_body, ''));
  a public.announcements;
begin
  perform public.kfp_require_admin('admin');
  if char_length(tt) < 1 or char_length(tt) > 120 or char_length(b) < 1 or char_length(b) > 2000 then
    raise exception 'invalid_message' using errcode = '22023';
  end if;
  if coalesce(p_kind, 'info') not in ('info', 'success', 'warning') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '1 year') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  if not public.kfp_rate_hit('announce:' || me::text, 30, 3600) then raise exception 'rate_limited' using errcode = '54000'; end if;
  insert into public.announcements (title, body, kind, created_by, expires_at) values (tt, b, coalesce(p_kind, 'info'), me, p_expires_at)
  returning * into a;
  perform public.kfp_audit('announce.create', null, 'announcements', a.id::text, null,
    jsonb_build_object('title', a.title, 'kind', a.kind, 'expires_at', a.expires_at, 'length', char_length(b)), 'announcement');
  return jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'kind', a.kind, 'created_at', a.created_at, 'expires_at', a.expires_at);
end;
$$;
revoke all on function public.admin_announce(text, text, text, timestamptz) from public, anon;
grant execute on function public.admin_announce(text, text, text, timestamptz) to authenticated;

create or replace function public.admin_announce_delete(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare a public.announcements;
begin
  perform public.kfp_require_admin('admin');
  update public.announcements set deleted_at = now(), deleted_by = auth.uid()
  where id = p_id and deleted_at is null returning * into a;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.kfp_audit('announce.delete', null, 'announcements', a.id::text,
    jsonb_build_object('title', a.title), jsonb_build_object('deleted_at', a.deleted_at), coalesce(nullif(btrim(p_reason), ''), 'announcement removed'));
  return jsonb_build_object('id', a.id, 'deleted_at', a.deleted_at);
end;
$$;
revoke all on function public.admin_announce_delete(uuid, text) from public, anon;
grant execute on function public.admin_announce_delete(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- security self-check: allowlist the new member/admin RPCs
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
                           'admin_announcements', 'admin_announce', 'admin_announce_delete'];
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

  return query
  select 'INFO', 'no_owner', 'admin_roles', 'no owner yet — add one with SQL (docs/SETUP.md Phase 6)'
  where not exists (select 1 from public.admin_roles where role = 'owner');
end;
$$;
revoke all on function public.kfp_security_report() from public, anon, authenticated;
grant execute on function public.kfp_security_report() to service_role;
