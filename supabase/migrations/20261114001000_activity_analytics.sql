-- =====================================================================
-- Korea Finance Planner · migration 10 · Activity Monitoring & Analytics (Phase 11)
--
--   user_activity_daily   one row per member per day (Asia/Seoul): first/last seen,
--                         samples, pages {page: n}, features {feature: n}
--                         → DAU/WAU/MAU, retention, top pages for 50k+ members
--                           without scanning the raw log
--   touch_activity()      + kind 'feature' (work log / expenses / export / cloud sync …)
--                         still throttled in the database (not every click):
--                           profile last_active ≤ 1×/min · page row ≤ 1×/5 min/page
--                           feature row ≤ 1×/30 min/feature · daily row ≤ 1 write/min
--   admin_activity_analytics(p) · admin_user_activity(uid, days)   (viewer+)
--   kfp_activity_maintenance()  retention: raw 90 days, daily 400 days (pg_cron)
--
-- Stored: page/feature NAMES and times only — no content, no IP, no keystrokes.
-- Additive & re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. raw log accepts 'feature'
-- ---------------------------------------------------------------------
alter table public.user_activity drop constraint if exists user_activity_kind_check;
alter table public.user_activity add constraint user_activity_kind_check
  check (kind in ('login', 'page', 'heartbeat', 'feature'));
create index if not exists user_activity_feature_idx on public.user_activity (user_id, page, created_at desc) where kind = 'feature';

-- ---------------------------------------------------------------------
-- 2. daily rollup
-- ---------------------------------------------------------------------
create table if not exists public.user_activity_daily (
  user_id   uuid not null references auth.users(id) on delete cascade,
  day       date not null,                            -- Asia/Seoul calendar day
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now(),
  events    int not null default 0,                   -- throttled samples (≈ one per 5 min of use)
  pages     jsonb not null default '{}'::jsonb,       -- {"index.html": 3, "gold.html": 1}
  features  jsonb not null default '{}'::jsonb,       -- {"work_records": 1, "export": 1}
  primary key (user_id, day)
);
create index if not exists user_activity_daily_day_idx on public.user_activity_daily (day);
alter table public.user_activity_daily enable row level security;
revoke all on public.user_activity_daily from anon, authenticated;
grant select on public.user_activity_daily to authenticated;
grant select, insert, update, delete on public.user_activity_daily to service_role;
drop policy if exists user_activity_daily_select on public.user_activity_daily;
create policy user_activity_daily_select on public.user_activity_daily for select
  to authenticated using (auth.uid() = user_id or public.is_admin('viewer'));

-- {a:1} + {a:2, b:1} = {a:3, b:1}; never grows past 60 keys (junk page names cannot bloat a row)
create or replace function public.kfp_jsonb_inc(a jsonb, b jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_object_agg(k, coalesce((a->>k)::int, 0) + coalesce((b->>k)::int, 0)), '{}'::jsonb)
  from (select jsonb_object_keys(coalesce(a, '{}')) as k
        union
        select k from jsonb_object_keys(coalesce(b, '{}')) k
        where (select count(*) from jsonb_object_keys(coalesce(a, '{}'))) < 60) s
$$;

create or replace function public.kfp_seoul_day(t timestamptz default now())
returns date language sql stable as $$ select (t at time zone 'Asia/Seoul')::date $$;

-- ---------------------------------------------------------------------
-- 3. touch_activity v2 (same signature; the browser keeps calling it the same way)
-- ---------------------------------------------------------------------
create or replace function public.touch_activity(p_page text default null, p_kind text default 'page')
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_kind text := case when p_kind in ('login', 'page', 'heartbeat', 'feature') then p_kind else 'page' end;
  v_page text;
  v_prof int := 0;
  v_ins  boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if v_kind = 'feature' then
    v_page := left(regexp_replace(lower(coalesce(p_page, '')), '[^a-z0-9_]', '', 'g'), 40);
    if v_page = '' then return; end if;
    update public.profiles set last_active_at = now()
    where user_id = v_uid and (last_active_at is null or last_active_at < now() - interval '1 minute');
    get diagnostics v_prof = row_count;
    if not exists (select 1 from public.user_activity
                   where user_id = v_uid and kind = 'feature' and page = v_page and created_at > now() - interval '30 minutes') then
      insert into public.user_activity (user_id, kind, page) values (v_uid, 'feature', v_page);
      v_ins := true;
    end if;
  else
    v_page := nullif(left(regexp_replace(coalesce(p_page, ''), '[^A-Za-z0-9._/#-]', '', 'g'), 64), '');
    update public.profiles
    set last_active_at = now(), last_page = v_page
    where user_id = v_uid and (last_active_at is null or last_active_at < now() - interval '1 minute'
                               or last_page is distinct from v_page);
    get diagnostics v_prof = row_count;
    if v_kind = 'login' or not exists (
         select 1 from public.user_activity
         where user_id = v_uid and kind <> 'feature' and page is not distinct from v_page
           and created_at > now() - interval '5 minutes') then
      insert into public.user_activity (user_id, kind, page) values (v_uid, v_kind, v_page);
      v_ins := true;
    end if;
  end if;

  if v_prof > 0 or v_ins then
    insert into public.user_activity_daily as d (user_id, day, first_at, last_at, events, pages, features)
    values (v_uid, public.kfp_seoul_day(), now(), now(), case when v_ins then 1 else 0 end,
            case when v_ins and v_kind <> 'feature' and v_page is not null then jsonb_build_object(v_page, 1) else '{}'::jsonb end,
            case when v_ins and v_kind = 'feature' then jsonb_build_object(v_page, 1) else '{}'::jsonb end)
    on conflict (user_id, day) do update
      set last_at  = now(),
          events   = d.events + excluded.events,
          pages    = case when excluded.pages = '{}'::jsonb then d.pages else public.kfp_jsonb_inc(d.pages, excluded.pages) end,
          features = case when excluded.features = '{}'::jsonb then d.features else public.kfp_jsonb_inc(d.features, excluded.features) end;
  end if;
end;
$$;
revoke all on function public.touch_activity(text, text) from public, anon;
grant execute on function public.touch_activity(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. backfill daily rows from the existing raw log (re-runnable: existing days untouched)
-- ---------------------------------------------------------------------
insert into public.user_activity_daily (user_id, day, first_at, last_at, events, pages, features)
select t.user_id, t.day, min(t.first_at), max(t.last_at), sum(t.n)::int,
       coalesce(jsonb_object_agg(t.page, t.n) filter (where t.page is not null), '{}'::jsonb), '{}'::jsonb
from (
  select a.user_id, (a.created_at at time zone 'Asia/Seoul')::date as day, a.page,
         min(a.created_at) as first_at, max(a.created_at) as last_at, count(*) as n
  from public.user_activity a
  group by 1, 2, 3
) t
group by t.user_id, t.day
on conflict (user_id, day) do nothing;

-- ---------------------------------------------------------------------
-- 5. retention / maintenance (service_role · schedule daily with pg_cron, see SETUP)
-- ---------------------------------------------------------------------
create or replace function public.kfp_prune_activity(p_keep_days int default 90)
returns bigint
language sql security definer
set search_path = public
as $$
  with d as (delete from public.user_activity where created_at < now() - make_interval(days => greatest(p_keep_days, 7)) returning 1)
  select count(*) from d
$$;
revoke all on function public.kfp_prune_activity(int) from public, anon, authenticated;
grant execute on function public.kfp_prune_activity(int) to service_role;

create or replace function public.kfp_activity_maintenance(p_raw_days int default 90, p_daily_days int default 400)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare r bigint; d bigint; rl bigint;
begin
  r := public.kfp_prune_activity(p_raw_days);
  delete from public.user_activity_daily where day < public.kfp_seoul_day() - greatest(p_daily_days, 35);
  get diagnostics d = row_count;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics rl = row_count;
  return jsonb_build_object('raw_deleted', r, 'daily_deleted', d, 'rate_limits_deleted', rl, 'at', now());
end;
$$;
revoke all on function public.kfp_activity_maintenance(int, int) from public, anon, authenticated;
grant execute on function public.kfp_activity_maintenance(int, int) to service_role;

-- ---------------------------------------------------------------------
-- 6. analytics for the Admin Console (viewer+)
-- ---------------------------------------------------------------------
-- computes the report (internal; admin_activity_analytics caches it)
create or replace function public.kfp_compute_activity_analytics(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public
set jit = off
as $$
declare
  v_days  int  := least(greatest(coalesce((p->>'days')::int, 30), 7), 180);
  v_today date := public.kfp_seoul_day();
  v_from  date := public.kfp_seoul_day() - (least(greatest(coalesce((p->>'days')::int, 30), 7), 180) - 1);
  v_out jsonb;
begin
  with plans_now as (select user_id, plan_id from public.kfp_effective_plans_all()),
  prof as (select pr.user_id, public.kfp_activity_bucket(pr.last_active_at) as bucket from public.profiles pr),
  rng as materialized (select user_id, day, events, pages, features from public.user_activity_daily where day between v_from and v_today),
  -- two-stage (hash) aggregation: per (key, member) first, then per key — no big sort for count(distinct)
  pg_user as (select e.key as k, r.user_id, sum(e.value::int) as v from rng r cross join lateral jsonb_each_text(r.pages) e group by 1, 2),
  ft_user as (select e.key as k, r.user_id, sum(e.value::int) as v from rng r cross join lateral jsonb_each_text(r.features) e where r.features <> '{}'::jsonb group by 1, 2),
  act_n as materialized (select count(*) as n from (select user_id from rng group by user_id) x),
  dau as (select day, count(*) as n from public.user_activity_daily where day between least(v_from, v_today - 29) and v_today group by day),
  sign as (select (created_at at time zone 'Asia/Seoul')::date as day, count(*) as n from auth.users
           where created_at >= (v_from::timestamp at time zone 'Asia/Seoul') group by 1),
  series as (
    select g::date as day, coalesce(dau.n, 0) as dau, coalesce(sign.n, 0) as signups
    from generate_series(v_from, v_today, interval '1 day') g
    left join dau on dau.day = g::date left join sign on sign.day = g::date
  ),
  live as (select distinct on (user_id) user_id, plan_id, currency, unit_amount_minor, billing_interval
           from public.subscriptions where status in ('active', 'trialing', 'past_due') order by user_id, created_at desc),
  cohorts as (
    select date_trunc('week', (u.created_at at time zone 'Asia/Seoul'))::date as wk, u.id
    from auth.users u
    where u.created_at >= (date_trunc('week', now() at time zone 'Asia/Seoul') - interval '7 weeks') at time zone 'Asia/Seoul'
  )
  select jsonb_build_object(
    'days', v_days, 'from', v_from, 'to', v_today, 'tz', 'Asia/Seoul', 'generated_at', now(),
    'kpi', jsonb_build_object(
      'dau', (select count(*) from public.user_activity_daily where day = v_today),
      'wau', (select count(*) from (select user_id from public.user_activity_daily where day > v_today - 7 group by user_id) w),
      'mau', (select count(*) from (select user_id from public.user_activity_daily where day > v_today - 30 group by user_id) m),
      'avg_dau_30', (select round(coalesce(sum(n), 0) / 30.0, 1) from dau where day > v_today - 30),
      'active_in_range', (select n from act_n),
      'signups_in_range', (select coalesce(sum(n), 0) from sign),
      'avg_events_per_active_day', (select round(avg(events), 1) from rng)),
    'buckets', (select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb) from (select bucket, count(*) n from prof group by 1) b),
    'buckets_by_plan', (select coalesce(jsonb_agg(jsonb_build_object('plan', plan_id, 'bucket', bucket, 'users', n) order by plan_id, bucket), '[]'::jsonb)
                        from (select pn.plan_id, pf.bucket, count(*) n from plans_now pn join prof pf on pf.user_id = pn.user_id group by 1, 2) x),
    'series', (select jsonb_agg(jsonb_build_object('day', day, 'dau', dau, 'signups', signups) order by day) from series),
    'pages', (select coalesce(jsonb_agg(jsonb_build_object('page', k, 'views', v, 'users', u) order by v desc), '[]'::jsonb) from (
                select k, sum(v) as v, count(*) as u from pg_user group by k order by 2 desc limit 15) t),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('feature', k, 'uses', v, 'users', u,
                   'adoption_pct', case when (select n from act_n) = 0 then 0 else round(100.0 * u / (select n from act_n), 1) end) order by u desc), '[]'::jsonb) from (
                select k, sum(v) as v, count(*) as u from ft_user group by k) t),
    'hours', (select jsonb_agg(coalesce(n, 0) order by h) from generate_series(0, 23) h left join (
                select extract(hour from created_at at time zone 'Asia/Seoul')::int as hh, count(*) as n
                from public.user_activity where created_at >= (v_from::timestamp at time zone 'Asia/Seoul') group by 1) x on x.hh = h),
    'weekdays', (select jsonb_agg(coalesce(n, 0) order by w) from generate_series(1, 7) w left join (
                select extract(isodow from day)::int as dw, count(*) as n from rng group by 1) x on x.dw = w),
    'retention', (select coalesce(jsonb_agg(jsonb_build_object('week', wk, 'size', size, 'w1', w1, 'w2', w2, 'w3', w3, 'w4', w4) order by wk desc), '[]'::jsonb) from (
                select c.wk, count(*) as size,
                  case when c.wk + 7  <= v_today then round(100.0 * count(*) filter (where exists (select 1 from public.user_activity_daily d where d.user_id = c.id and d.day >= c.wk + 7  and d.day < c.wk + 14)) / count(*), 1) end as w1,
                  case when c.wk + 14 <= v_today then round(100.0 * count(*) filter (where exists (select 1 from public.user_activity_daily d where d.user_id = c.id and d.day >= c.wk + 14 and d.day < c.wk + 21)) / count(*), 1) end as w2,
                  case when c.wk + 21 <= v_today then round(100.0 * count(*) filter (where exists (select 1 from public.user_activity_daily d where d.user_id = c.id and d.day >= c.wk + 21 and d.day < c.wk + 28)) / count(*), 1) end as w3,
                  case when c.wk + 28 <= v_today then round(100.0 * count(*) filter (where exists (select 1 from public.user_activity_daily d where d.user_id = c.id and d.day >= c.wk + 28 and d.day < c.wk + 35)) / count(*), 1) end as w4
                from cohorts c group by c.wk) t),
    'at_risk', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                select jsonb_build_object('user_id', l.user_id, 'email', pr.email, 'plan', l.plan_id, 'currency', l.currency,
                  'mrr_minor', round(public.kfp_monthly_minor(l.unit_amount_minor, l.billing_interval)),
                  'last_active_at', pr.last_active_at,
                  'days_inactive', case when pr.last_active_at is null then null else floor(extract(epoch from now() - pr.last_active_at) / 86400)::int end) as x
                from live l join public.profiles pr on pr.user_id = l.user_id
                where pr.last_active_at is null or pr.last_active_at < now() - interval '14 days'
                order by pr.last_active_at asc nulls first limit 25) t),
    'at_risk_total', (select count(*) from live l join public.profiles pr on pr.user_id = l.user_id
                      where pr.last_active_at is null or pr.last_active_at < now() - interval '14 days')
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.kfp_compute_activity_analytics(jsonb) from public, anon, authenticated;

-- 10-minute cache: the report scans every daily row of the period (≈2 s at 50k members
-- with 10k daily actives); admins reloading the tab should not repeat that work.
create table if not exists public.admin_analytics_cache (
  key         text primary key,
  data        jsonb not null,
  computed_at timestamptz not null default now()
);
alter table public.admin_analytics_cache enable row level security;
revoke all on public.admin_analytics_cache from anon, authenticated;
grant select, insert, update, delete on public.admin_analytics_cache to service_role;

-- p: {days 7..180 (default 30), refresh: true → recompute now}
create or replace function public.admin_activity_analytics(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_days int := least(greatest(coalesce((p->>'days')::int, 30), 7), 180);
  v_key text;
  c public.admin_analytics_cache;
  v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  v_key := 'activity:' || v_days;
  if coalesce((p->>'refresh')::boolean, false) is false then
    select * into c from public.admin_analytics_cache where key = v_key and computed_at > now() - interval '10 minutes';
    if found then return c.data || jsonb_build_object('cached', true, 'computed_at', c.computed_at); end if;
  end if;
  v_out := public.kfp_compute_activity_analytics(jsonb_build_object('days', v_days));
  insert into public.admin_analytics_cache as x (key, data, computed_at) values (v_key, v_out, now())
  on conflict (key) do update set data = excluded.data, computed_at = excluded.computed_at;
  return v_out || jsonb_build_object('cached', false, 'computed_at', now());
end;
$$;
revoke all on function public.admin_activity_analytics(jsonb) from public, anon;
grant execute on function public.admin_activity_analytics(jsonb) to authenticated;

-- one member's last N days (drawer heat strip)
create or replace function public.admin_user_activity(p_user uuid, p_days int default 30)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 7), 180);
  v_from date := public.kfp_seoul_day() - (least(greatest(coalesce(p_days, 30), 7), 180) - 1);
  v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  select jsonb_build_object(
    'days', v_days, 'from', v_from,
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', g::date, 'events', coalesce(d.events, 0),
                 'first_at', d.first_at, 'last_at', d.last_at) order by g)
               from generate_series(v_from, public.kfp_seoul_day(), interval '1 day') g
               left join public.user_activity_daily d on d.user_id = p_user and d.day = g::date), '[]'::jsonb),
    'active_days', (select count(*) from public.user_activity_daily where user_id = p_user and day >= v_from),
    'pages', coalesce((select jsonb_object_agg(k, v) from (select e.key k, sum(e.value::int) v from public.user_activity_daily d
               cross join lateral jsonb_each_text(d.pages) e where d.user_id = p_user and d.day >= v_from group by 1 order by 2 desc limit 10) t), '{}'::jsonb),
    'features', coalesce((select jsonb_object_agg(k, v) from (select e.key k, sum(e.value::int) v from public.user_activity_daily d
               cross join lateral jsonb_each_text(d.features) e where d.user_id = p_user and d.day >= v_from group by 1) t), '{}'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.admin_user_activity(uuid, int) from public, anon;
grant execute on function public.admin_user_activity(uuid, int) to authenticated;
