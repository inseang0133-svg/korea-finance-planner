-- =====================================================================
-- Korea Finance Planner · migration 3 · rate limiting for Edge Functions
-- Used by username-login (and later checkout/admin) to throttle abuse.
-- Only service_role (Edge Functions) can call it.
-- =====================================================================
create table if not exists public.rate_limits (
  key          text primary key,           -- e.g. 'ulogin:ip:1.2.3.4'
  window_start timestamptz not null default now(),
  hits         int not null default 0
);
alter table public.rate_limits enable row level security;   -- no policies: Data API cannot read it
revoke all on public.rate_limits from anon, authenticated;
grant select, insert, update, delete on public.rate_limits to service_role;

-- Returns true when the call is allowed, false when the limit is hit.
create or replace function public.kfp_rate_hit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_hits int;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;
revoke all on function public.kfp_rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.kfp_rate_hit(text, int, int) to service_role;

-- Server-side lookup for username login. Returns the e-mail ONLY to
-- service_role (Edge Function); never exposed to the browser.
create or replace function public.kfp_login_email_for_username(p_username text)
returns text
language sql stable security definer
set search_path = public
as $$
  select p.email from public.profiles p
  where p.username = public.kfp_normalize_username(p_username)
    and p.suspended_at is null
  limit 1
$$;
revoke all on function public.kfp_login_email_for_username(text) from public, anon, authenticated;
grant execute on function public.kfp_login_email_for_username(text) to service_role;

-- housekeeping: old rows can be purged by a cron (pg_cron) if desired:
-- delete from public.rate_limits where window_start < now() - interval '1 day';
