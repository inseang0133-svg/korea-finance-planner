-- =====================================================================
-- Korea Finance Planner · migration 8 · Gold Premium Protection (Phase 9)
--
--   user_gold_data      gold portfolio (lots + settings) in its own table
--                       • NO direct insert/update/delete for browsers
--                       • SELECT only while the caller has "gold_portfolio" (RLS)
--   get_my_gold()       read  — checks Premium on every call
--   save_my_gold(...)   write — checks Premium on every call, validates input,
--                       optimistic concurrency (version) so two devices never
--                       silently overwrite each other
--   user_data           gold keys are moved out (copied first, then removed);
--                       an old cached app that still sends them is routed to
--                       user_gold_data (Premium) or ignored (no Premium)
--
-- Downgrade / expiry never deletes gold data: it stays stored and becomes
-- readable again when the member is Premium again.
-- Additive & re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. table
-- ---------------------------------------------------------------------
create table if not exists public.user_gold_data (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  lots        jsonb not null default '[]'::jsonb,
  settings    jsonb not null default '{}'::jsonb,
  version     bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint user_gold_lots_array     check (jsonb_typeof(lots) = 'array'),
  constraint user_gold_settings_obj   check (jsonb_typeof(settings) = 'object'),
  constraint user_gold_lots_max       check (jsonb_array_length(lots) <= 2000),
  constraint user_gold_size           check (pg_column_size(lots) + pg_column_size(settings) <= 1048576)
);
comment on table public.user_gold_data is
  'Gold portfolio per member. Browser access only through get_my_gold()/save_my_gold() and a Premium-gated SELECT policy.';

alter table public.user_gold_data enable row level security;
revoke all on public.user_gold_data from anon, authenticated;
grant select on public.user_gold_data to authenticated;            -- still filtered by the policy below
grant select, insert, update, delete on public.user_gold_data to service_role;

drop policy if exists user_gold_select_premium on public.user_gold_data;
create policy user_gold_select_premium on public.user_gold_data for select
  to authenticated using (auth.uid() = user_id and public.has_feature('gold_portfolio'));

-- ---------------------------------------------------------------------
-- 2. helpers
-- ---------------------------------------------------------------------
-- user_data stores raw localStorage strings: '"[{...}]"' → '[{...}]'. Bad JSON → null.
create or replace function public.kfp_parse_ls_json(v jsonb)
returns jsonb
language plpgsql immutable
set search_path = public
as $$
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'string' then return (v #>> '{}')::jsonb; end if;
  return v;
exception when others then
  return null;
end;
$$;
revoke all on function public.kfp_parse_ls_json(jsonb) from public, anon, authenticated;

-- Shape check for what a browser sends. Raises 22023 (invalid_parameter_value).
create or replace function public.kfp_validate_gold(p_lots jsonb, p_settings jsonb)
returns void
language plpgsql immutable
set search_path = public
as $$
declare
  l jsonb;
begin
  if p_lots is null or jsonb_typeof(p_lots) <> 'array' then
    raise exception 'gold: lots must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lots) > 2000 then
    raise exception 'gold: too many lots (max 2000)' using errcode = '22023';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'gold: settings must be an object' using errcode = '22023';
  end if;
  if octet_length(p_settings::text) > 16384 or octet_length(p_lots::text) > 1000000 then
    raise exception 'gold: payload too large' using errcode = '22023';
  end if;
  for l in select value from jsonb_array_elements(p_lots) loop
    -- nested IFs: SQL "or" does not short-circuit, so never cast before the type is known
    if jsonb_typeof(l) <> 'object' then
      raise exception 'gold: invalid lot' using errcode = '22023';
    end if;
    if jsonb_typeof(l->'id') is distinct from 'string' or length(l->>'id') not between 1 and 100 or octet_length(l::text) > 4096 then
      raise exception 'gold: invalid lot' using errcode = '22023';
    end if;
    if l ? 'grams' and jsonb_typeof(l->'grams') <> 'null' then
      if jsonb_typeof(l->'grams') <> 'number' then raise exception 'gold: invalid lot' using errcode = '22023'; end if;
      if (l->>'grams')::numeric < 0 then raise exception 'gold: invalid lot' using errcode = '22023'; end if;
    end if;
    if l ? 'costThb' and jsonb_typeof(l->'costThb') <> 'null' then
      if jsonb_typeof(l->'costThb') <> 'number' then raise exception 'gold: invalid lot' using errcode = '22023'; end if;
      if (l->>'costThb')::numeric < 0 then raise exception 'gold: invalid lot' using errcode = '22023'; end if;
    end if;
  end loop;
end;
$$;
revoke all on function public.kfp_validate_gold(jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. browser API (both check Premium on EVERY call)
-- ---------------------------------------------------------------------
create or replace function public.get_my_gold()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  g   public.user_gold_data;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into g from public.user_gold_data where user_id = uid;
  if not public.kfp_has_feature(uid, 'gold_portfolio') then
    -- No content without Premium — only whether something is kept for later.
    return jsonb_build_object('allowed', false, 'stored_lots', coalesce(jsonb_array_length(g.lots), 0));
  end if;
  return jsonb_build_object(
    'allowed',    true,
    'exists',     g.user_id is not null,
    'lots',       coalesce(g.lots, '[]'::jsonb),
    'settings',   coalesce(g.settings, '{}'::jsonb),
    'version',    coalesce(g.version, 0),
    'updated_at', g.updated_at);
end;
$$;
revoke all on function public.get_my_gold() from public, anon;
grant execute on function public.get_my_gold() to authenticated;

-- p_base_version = the version this device last saw (0 = "nothing on the server yet").
--                  null = overwrite whatever is there (member chose "keep this device").
-- Returns {ok:true, version, updated_at} or {ok:false, error:'conflict', ...server copy}.
create or replace function public.save_my_gold(p_lots jsonb, p_settings jsonb, p_base_version bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur public.user_gold_data;
  out_row public.user_gold_data;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.kfp_has_feature(uid, 'gold_portfolio') then
    raise exception 'premium_required' using errcode = '42501',
      hint = 'The gold portfolio needs Finance Premium.';
  end if;
  if not public.kfp_rate_hit('gold:' || uid::text, 120, 60) then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  perform public.kfp_validate_gold(p_lots, p_settings);

  select * into cur from public.user_gold_data where user_id = uid for update;
  if p_base_version is not null and coalesce(cur.version, 0) <> p_base_version then
    return jsonb_build_object('ok', false, 'error', 'conflict',
      'version', coalesce(cur.version, 0), 'updated_at', cur.updated_at,
      'lots', coalesce(cur.lots, '[]'::jsonb), 'settings', coalesce(cur.settings, '{}'::jsonb));
  end if;
  if cur.user_id is not null and cur.lots = p_lots and cur.settings = p_settings then
    return jsonb_build_object('ok', true, 'version', cur.version, 'updated_at', cur.updated_at, 'unchanged', true);
  end if;

  insert into public.user_gold_data as g (user_id, lots, settings, version, updated_at)
  values (uid, p_lots, p_settings, 1, now())
  on conflict (user_id) do update
    set lots = excluded.lots, settings = excluded.settings, version = g.version + 1, updated_at = now()
  returning * into out_row;
  return jsonb_build_object('ok', true, 'version', out_row.version, 'updated_at', out_row.updated_at);
end;
$$;
revoke all on function public.save_my_gold(jsonb, jsonb, bigint) from public, anon;
grant execute on function public.save_my_gold(jsonb, jsonb, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 4. move existing gold out of user_data (copy first, remove only what was copied)
-- ---------------------------------------------------------------------
insert into public.user_gold_data (user_id, lots, settings, updated_at)
select d.user_id,
       case when jsonb_typeof(public.kfp_parse_ls_json(d.data->'kfp_gold_lots_v1')) = 'array'
            then public.kfp_parse_ls_json(d.data->'kfp_gold_lots_v1') else '[]'::jsonb end,
       case when jsonb_typeof(public.kfp_parse_ls_json(d.data->'kfp_gold_settings_v1')) = 'object'
            then public.kfp_parse_ls_json(d.data->'kfp_gold_settings_v1') else '{}'::jsonb end,
       coalesce(d.updated_at, now())
from public.user_data d
join auth.users u on u.id = d.user_id
where d.data ?| array['kfp_gold_lots_v1', 'kfp_gold_settings_v1']
on conflict (user_id) do nothing;

-- Only rows whose gold value could NOT be parsed keep a raw copy (nothing is ever thrown away).
create table if not exists public.user_gold_legacy_raw (
  user_id uuid primary key references auth.users(id) on delete cascade,
  raw     jsonb not null,
  saved_at timestamptz not null default now()
);
alter table public.user_gold_legacy_raw enable row level security;
revoke all on public.user_gold_legacy_raw from anon, authenticated;
grant select, insert, update, delete on public.user_gold_legacy_raw to service_role;
insert into public.user_gold_legacy_raw (user_id, raw)
select d.user_id, jsonb_build_object('kfp_gold_lots_v1', d.data->'kfp_gold_lots_v1', 'kfp_gold_settings_v1', d.data->'kfp_gold_settings_v1')
from public.user_data d
where (d.data ? 'kfp_gold_lots_v1' and jsonb_typeof(public.kfp_parse_ls_json(d.data->'kfp_gold_lots_v1')) is distinct from 'array')
   or (d.data ? 'kfp_gold_settings_v1' and jsonb_typeof(public.kfp_parse_ls_json(d.data->'kfp_gold_settings_v1')) is distinct from 'object')
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- 5. user_data never stores gold again
--    (replaces the Phase 5 trigger kfp_protect_gold_keys)
-- ---------------------------------------------------------------------
create or replace function public.kfp_route_gold_keys()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  gold_keys text[] := array['kfp_gold_lots_v1', 'kfp_gold_settings_v1'];
  v_lots jsonb; v_settings jsonb;
  -- security definer → current_user is the owner here, so trust is decided from the JWT:
  -- service_role, or no JWT at all (SQL Editor / migrations). Browsers always carry a user JWT.
  trusted boolean := coalesce(auth.role(), '') = 'service_role' or auth.uid() is null;
begin
  if new.data is null or not (new.data ?| gold_keys) then
    return new;
  end if;
  -- An app version from before Phase 9 still sends gold inside user_data.
  -- Keep it (Premium only), in the protected table — never in user_data.
  if trusted or public.kfp_has_feature(new.user_id, 'gold_portfolio') then
    v_lots := public.kfp_parse_ls_json(new.data->'kfp_gold_lots_v1');
    v_settings := public.kfp_parse_ls_json(new.data->'kfp_gold_settings_v1');
    if jsonb_typeof(v_lots) = 'array' and jsonb_array_length(v_lots) <= 2000 then
      insert into public.user_gold_data as g (user_id, lots, settings)
      values (new.user_id, v_lots, case when jsonb_typeof(v_settings) = 'object' then v_settings else '{}'::jsonb end)
      on conflict (user_id) do update
        set lots = excluded.lots,
            settings = case when jsonb_typeof(v_settings) = 'object' then excluded.settings else g.settings end,
            version = g.version + 1, updated_at = now()
        where g.lots is distinct from excluded.lots
           or (jsonb_typeof(v_settings) = 'object' and g.settings is distinct from excluded.settings);
    end if;
  end if;
  new.data := new.data - gold_keys;
  return new;
end;
$$;
revoke all on function public.kfp_route_gold_keys() from public, anon, authenticated;

drop trigger if exists user_data_protect_gold on public.user_data;
drop trigger if exists user_data_route_gold on public.user_data;
create trigger user_data_route_gold
before insert or update on public.user_data
for each row execute procedure public.kfp_route_gold_keys();

-- strip the keys that were copied above (fires the trigger: values already identical → no new version)
update public.user_data d
set data = d.data - array['kfp_gold_lots_v1', 'kfp_gold_settings_v1']
where d.data ?| array['kfp_gold_lots_v1', 'kfp_gold_settings_v1']
  and (exists (select 1 from public.user_gold_data g where g.user_id = d.user_id)
       or exists (select 1 from public.user_gold_legacy_raw r where r.user_id = d.user_id));
