-- =====================================================================
-- Korea Finance Planner · migration 9 · Admin Dashboard (Phase 10)
--
--   Read  (viewer+)  admin_whoami · admin_overview · admin_list_users · admin_user_detail
--                    admin_revenue · admin_audit_list · admin_list_prices
--   Write (admin+)   admin_set_plan · admin_extend_access · admin_revoke_access · admin_set_suspended
--                    (cancel a Stripe subscription → Edge Function admin-actions)
--
--   Every function checks the caller's role in the database (admin_roles,
--   not suspended). Every write needs a reason and writes admin_audit_logs.
--   An admin can never act on their own account, and only an owner can act
--   on another admin/owner. Nothing here deletes member data.
--
--   Scale: one set-based plan resolution for all users (no per-user calls),
--   server-side search/filter/sort/pagination (max 100 rows per page).
-- Additive & re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. indexes used by the dashboard
-- ---------------------------------------------------------------------
create index if not exists profiles_created_idx      on public.profiles (created_at desc);
create index if not exists profiles_last_active_idx  on public.profiles (last_active_at desc nulls last);
create index if not exists profiles_last_login_idx   on public.profiles (last_login_at desc nulls last);
create index if not exists profiles_email_lower_idx  on public.profiles (lower(email));
create index if not exists subscriptions_user_created_idx on public.subscriptions (user_id, created_at desc);
create index if not exists payments_created_idx      on public.payments (created_at desc);
create index if not exists user_entitlements_active_idx on public.user_entitlements (user_id, expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------
-- 1. role helpers
-- ---------------------------------------------------------------------
create or replace function public.kfp_admin_rank_of(p_uid uuid)
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce((
    select public.kfp_role_rank(r.role)
    from public.admin_roles r join public.profiles p on p.user_id = r.user_id
    where r.user_id = p_uid and p.suspended_at is null), 0)
$$;
revoke all on function public.kfp_admin_rank_of(uuid) from public, anon, authenticated;

-- Edge Functions (service_role) ask "what is this caller?" before acting.
create or replace function public.kfp_admin_role(p_uid uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select case public.kfp_admin_rank_of(p_uid) when 3 then 'owner' when 2 then 'admin' when 1 then 'viewer' else null end
$$;
revoke all on function public.kfp_admin_role(uuid) from public, anon, authenticated;
grant execute on function public.kfp_admin_role(uuid) to service_role;

create or replace function public.kfp_require_admin(p_min text)
returns int
language plpgsql stable security definer
set search_path = public
as $$
declare r int;
begin
  r := case when auth.uid() is null then 0 else public.kfp_admin_rank_of(auth.uid()) end;
  if r < public.kfp_role_rank(p_min) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return r;
end;
$$;
revoke all on function public.kfp_require_admin(text) from public, anon, authenticated;

-- self-protection + hierarchy for every write
create or replace function public.kfp_guard_target(p_target uuid, p_caller uuid, p_reason text)
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_target is null or not exists (select 1 from auth.users where id = p_target) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if p_target = p_caller then
    raise exception 'cannot_act_on_self' using errcode = '42501';
  end if;
  if public.kfp_admin_rank_of(p_target) > 0 and public.kfp_admin_rank_of(p_caller) < 3 then
    raise exception 'only_owner_can_change_admins' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 3 or length(p_reason) > 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.kfp_guard_target(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.kfp_activity_bucket(p_last timestamptz)
returns text
language sql stable
as $$
  select case when p_last is null then 'never'
              when p_last > now() - interval '24 hours' then 'active'
              when p_last > now() - interval '7 days'   then 'recent'
              when p_last > now() - interval '30 days'  then 'inactive'
              else 'dormant' end
$$;

-- ---------------------------------------------------------------------
-- 2. effective plan for ALL users in one query
--    Same rules as kfp_effective_plan(uid) (tests compare both for every user).
-- ---------------------------------------------------------------------
create or replace function public.kfp_effective_plans_all()
returns table (user_id uuid, plan_id text, source text, status text, valid_until timestamptz)
language sql stable security definer
set search_path = public
as $$
  with cand as (
    select s.user_id, s.plan_id, ('subscription:' || s.provider)::text as source, s.status,
           case when s.status = 'past_due'
                then s.current_period_start + make_interval(days => coalesce((p.limits->>'grace_days')::int, 0))
                else s.current_period_end end as valid_until
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    where (s.status in ('active','trialing') and (s.current_period_end is null or s.current_period_end > now()))
       or (s.status = 'past_due' and s.current_period_start is not null
           and now() < s.current_period_start + make_interval(days => coalesce((p.limits->>'grace_days')::int, 0)))
    union all
    select e.user_id, e.plan_id, e.reason, 'granted', e.expires_at
    from public.user_entitlements e
    where e.revoked_at is null and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now())
  ),
  ranked as (
    select c.*, row_number() over (partition by c.user_id order by p.sort desc, c.valid_until desc nulls first) as rn
    from cand c join public.plans p on p.id = c.plan_id
    where p.active
  )
  select u.id,
         case when pr.suspended_at is not null or r.user_id is null then 'free' else r.plan_id end,
         case when pr.suspended_at is not null then 'suspended' when r.user_id is null then 'default' else r.source end,
         case when pr.suspended_at is not null or r.user_id is null then 'none' else r.status end,
         case when pr.suspended_at is not null then null else r.valid_until end
  from auth.users u
  left join public.profiles pr on pr.user_id = u.id
  left join ranked r on r.user_id = u.id and r.rn = 1
$$;
revoke all on function public.kfp_effective_plans_all() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. read API (viewer+)
-- ---------------------------------------------------------------------
create or replace function public.admin_whoami()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare r int := public.kfp_require_admin('viewer');
begin
  return jsonb_build_object('user_id', auth.uid(),
    'role', case r when 3 then 'owner' when 2 then 'admin' else 'viewer' end,
    'can_write', r >= 2, 'is_owner', r >= 3);
end;
$$;
revoke all on function public.admin_whoami() from public, anon;
grant execute on function public.admin_whoami() to authenticated;

-- monthly recurring amount of one subscription row, in its currency's minor unit
create or replace function public.kfp_monthly_minor(p_amount bigint, p_interval text)
returns numeric
language sql immutable
as $$ select case when p_amount is null then 0 when p_interval = 'year' then p_amount / 12.0 else p_amount::numeric end $$;

create or replace function public.admin_overview(p_tz text default 'Asia/Seoul')
returns jsonb
language plpgsql stable security definer
set search_path = public
set jit = off                                    -- one-row reports: JIT compile time (seconds) >> run time (ms)
as $$
declare
  tz text := case when exists (select 1 from pg_timezone_names where name = p_tz) then p_tz else 'Asia/Seoul' end;
  today_start timestamptz := date_trunc('day', now() at time zone tz) at time zone tz;
  month_start timestamptz := date_trunc('month', now() at time zone tz) at time zone tz;
  v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  with plans_now as (select * from public.kfp_effective_plans_all()),
  latest as (                                  -- one "current" subscription per user (live first)
    select distinct on (s.user_id) s.*
    from public.subscriptions s
    order by s.user_id, (s.status in ('active','trialing','past_due','unpaid')) desc, s.created_at desc
  ),
  live as (select * from public.subscriptions where status in ('active', 'past_due')),   -- paying (past_due = still billed)
  mrr as (
    select currency, round(sum(public.kfp_monthly_minor(unit_amount_minor, billing_interval)))::bigint as mrr_minor, count(distinct user_id) as payers
    from live group by currency
  ),
  churn as (
    select count(*) filter (where s.ended_at > now() - interval '30 days' or (s.status = 'canceled' and s.canceled_at > now() - interval '30 days')) as churned
    from public.subscriptions s
  ),
  rev as (
    select currency,
           sum(amount_paid_minor) as gross_minor,
           sum(amount_refunded_minor) as refunded_minor,
           sum(amount_paid_minor) filter (where coalesce(paid_at, created_at) > now() - interval '30 days') as gross_30d_minor
    from public.payments where status in ('paid', 'partially_refunded', 'refunded') group by currency
  )
  select jsonb_build_object(
    'tz', tz, 'generated_at', now(),
    'users', jsonb_build_object(
      'total',      (select count(*) from auth.users),
      'new_today',  (select count(*) from auth.users where created_at >= today_start),
      'new_month',  (select count(*) from auth.users where created_at >= month_start),
      'suspended',  (select count(*) from public.profiles where suspended_at is not null),
      'unverified', (select count(*) from auth.users where email_confirmed_at is null)),
    'plans', jsonb_build_object(
      'free',    (select count(*) from plans_now where plan_id = 'free'),
      'plus',    (select count(*) from plans_now where plan_id = 'plus'),
      'premium', (select count(*) from plans_now where plan_id = 'premium'),
      'via_subscription', (select count(*) from plans_now where source like 'subscription:%'),
      'via_grant',        (select count(*) from plans_now where plan_id <> 'free' and source not like 'subscription:%')),
    'subscriptions', jsonb_build_object(
      'active',     (select count(*) from latest where status = 'active' and not cancel_at_period_end),
      'trialing',   (select count(*) from latest where status = 'trialing'),
      'cancelling', (select count(*) from latest where status in ('active','trialing') and cancel_at_period_end),
      'past_due',   (select count(*) from latest where status in ('past_due', 'unpaid')),
      'expired',    (select count(*) from latest where status in ('canceled', 'incomplete_expired') or (status in ('active','trialing') and current_period_end < now()))),
    'activity', (select jsonb_object_agg(b, n) from (
        select public.kfp_activity_bucket(last_active_at) as b, count(*) as n from public.profiles group by 1) a),
    'mrr', coalesce((select jsonb_object_agg(currency, jsonb_build_object(
                'mrr_minor', mrr_minor, 'arr_minor', mrr_minor * 12, 'payers', payers,
                'arpu_minor', case when payers > 0 then round(mrr_minor::numeric / payers)::bigint else 0 end))
              from mrr where currency is not null), '{}'::jsonb),
    'revenue', coalesce((select jsonb_object_agg(currency, jsonb_build_object(
                'gross_minor', gross_minor, 'refunded_minor', refunded_minor, 'net_minor', gross_minor - refunded_minor,
                'gross_30d_minor', coalesce(gross_30d_minor, 0)))
              from rev where currency is not null), '{}'::jsonb),
    'churn_30d', (select jsonb_build_object(
                'churned', churned,
                'base', churned + (select count(*) from public.subscriptions where status in ('active','trialing','past_due')),
                'rate_pct', case when churned + (select count(*) from public.subscriptions where status in ('active','trialing','past_due')) = 0 then 0
                                 else round(100.0 * churned / (churned + (select count(*) from public.subscriptions where status in ('active','trialing','past_due'))), 2) end)
              from churn),
    'failed_payments_30d', (select count(*) from public.payments where status in ('failed','action_required') and created_at > now() - interval '30 days'),
    'webhooks_failed', (select count(*) from public.stripe_webhook_events where status = 'failed')
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.admin_overview(text) from public, anon;
grant execute on function public.admin_overview(text) to authenticated;

-- p: {q, plan, sub_status, activity, country, suspended, sort, dir, page, page_size}
create or replace function public.admin_list_users(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public
set jit = off                                    -- one-row reports: JIT compile time (seconds) >> run time (ms)
as $$
declare
  v_q    text := nullif(trim(coalesce(p->>'q', '')), '');
  v_like text;
  v_plan text := nullif(p->>'plan', '');
  v_st   text := nullif(p->>'sub_status', '');
  v_act  text := nullif(p->>'activity', '');
  v_cty  text := nullif(upper(p->>'country'), '');
  v_susp boolean := case p->>'suspended' when 'true' then true when 'false' then false else null end;
  v_sort text := coalesce(nullif(p->>'sort', ''), 'created_at');
  v_desc boolean := coalesce(p->>'dir', 'desc') <> 'asc';
  v_size int := least(greatest(coalesce((p->>'page_size')::int, 25), 5), 100);
  v_page int := greatest(coalesce((p->>'page')::int, 1), 1);
  v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  if v_sort not in ('created_at', 'last_active_at', 'last_login_at', 'email', 'expires_at', 'plan') then v_sort := 'created_at'; end if;
  if v_q is not null then
    v_q := left(v_q, 100);
    v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with base as (
    select u.id as user_id, coalesce(pr.email, u.email) as email, pr.username, pr.nickname, pr.country,
           u.created_at, pr.last_login_at, pr.last_active_at, pr.last_page, pr.suspended_at, u.email_confirmed_at,
           e.plan_id, e.source as plan_source, e.valid_until,
           ls.status as sub_status, ls.cancel_at_period_end, ls.created_at as sub_started_at, ls.current_period_end,
           ls.currency as sub_currency, ls.billing_interval, ls.provider_subscription_id,
           coalesce(e.valid_until, case when ls.status in ('active','trialing') then ls.current_period_end end) as expires_at,
           public.kfp_activity_bucket(pr.last_active_at) as activity,
           (ar.user_id is not null) as is_admin
    from auth.users u
    left join public.profiles pr on pr.user_id = u.id
    left join public.admin_roles ar on ar.user_id = u.id
    join public.kfp_effective_plans_all() e on e.user_id = u.id
    left join lateral (
      select s.* from public.subscriptions s where s.user_id = u.id
      order by (s.status in ('active','trialing','past_due','unpaid')) desc, s.created_at desc limit 1) ls on true
    where (v_q is null
           or lower(coalesce(pr.email, u.email, '')) like v_like escape '\'
           or lower(coalesce(pr.username, '')) like v_like escape '\'
           or lower(coalesce(pr.nickname, '')) like v_like escape '\'
           or u.id::text = lower(v_q))
  ),
  filtered as (
    select b.*, count(*) over () as total from base b
    where (v_plan is null or b.plan_id = v_plan)
      and (v_act  is null or b.activity = v_act)
      and (v_cty  is null or upper(coalesce(b.country, '')) = v_cty)
      and (v_susp is null or (b.suspended_at is not null) = v_susp)
      and (v_st is null
           or (v_st = 'none'       and b.sub_status is null)
           or (v_st = 'cancelling' and b.sub_status in ('active','trialing') and b.cancel_at_period_end)
           or (v_st = 'active'     and b.sub_status = 'active' and not b.cancel_at_period_end)
           or (v_st = 'past_due'   and b.sub_status in ('past_due','unpaid'))
           or (v_st = 'canceled'   and b.sub_status in ('canceled','incomplete_expired'))
           or (v_st not in ('none','cancelling','active','past_due','canceled') and b.sub_status = v_st))
  ),
  page as (
    select * from filtered
    order by
      case when not v_desc and v_sort = 'created_at'     then created_at end asc,
      case when     v_desc and v_sort = 'created_at'     then created_at end desc,
      case when not v_desc and v_sort = 'last_active_at' then last_active_at end asc nulls last,
      case when     v_desc and v_sort = 'last_active_at' then last_active_at end desc nulls last,
      case when not v_desc and v_sort = 'last_login_at'  then last_login_at end asc nulls last,
      case when     v_desc and v_sort = 'last_login_at'  then last_login_at end desc nulls last,
      case when not v_desc and v_sort = 'email'          then lower(email) end asc,
      case when     v_desc and v_sort = 'email'          then lower(email) end desc,
      case when not v_desc and v_sort = 'expires_at'     then expires_at end asc nulls last,
      case when     v_desc and v_sort = 'expires_at'     then expires_at end desc nulls last,
      case when not v_desc and v_sort = 'plan'           then (select sort from public.plans where id = plan_id) end asc,
      case when     v_desc and v_sort = 'plan'           then (select sort from public.plans where id = plan_id) end desc,
      created_at desc, user_id
    limit v_size offset (v_page - 1) * v_size
  )
  select jsonb_build_object(
    'page', v_page, 'page_size', v_size,
    'total', coalesce((select total from filtered limit 1), 0),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', user_id, 'email', email, 'username', username, 'country', country,
        'plan', plan_id, 'plan_source', plan_source, 'sub_status', sub_status, 'cancel_at_period_end', cancel_at_period_end,
        'registered_at', created_at, 'sub_started_at', sub_started_at, 'expires_at', expires_at,
        'last_login_at', last_login_at, 'last_active_at', last_active_at, 'last_page', last_page,
        'days_since_active', case when last_active_at is null then null else floor(extract(epoch from now() - last_active_at) / 86400)::int end,
        'activity', activity, 'suspended', suspended_at is not null, 'verified', email_confirmed_at is not null,
        'is_admin', is_admin)) from page), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.admin_list_users(jsonb) from public, anon;
grant execute on function public.admin_list_users(jsonb) to authenticated;

create or replace function public.admin_user_detail(p_user uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
set jit = off                                    -- one-row reports: JIT compile time (seconds) >> run time (ms)
as $$
declare v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'user', (select jsonb_build_object(
        'user_id', u.id, 'email', coalesce(pr.email, u.email), 'username', pr.username, 'nickname', pr.nickname,
        'country', pr.country, 'registered_at', u.created_at, 'verified_at', u.email_confirmed_at,
        'legacy_email', coalesce(pr.is_legacy_email, false), 'last_login_at', pr.last_login_at,
        'last_active_at', pr.last_active_at, 'last_page', pr.last_page, 'suspended_at', pr.suspended_at,
        'activity', public.kfp_activity_bucket(pr.last_active_at),
        'admin_role', public.kfp_admin_role(u.id))
      from auth.users u left join public.profiles pr on pr.user_id = u.id where u.id = p_user),
    'effective', (select to_jsonb(e) from public.kfp_effective_plan(p_user) e limit 1),
    'customer', (select jsonb_build_object('provider', b.provider, 'customer_id', b.provider_customer_id, 'email', b.email)
                 from public.billing_customers b where b.user_id = p_user limit 1),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'provider', s.provider, 'provider_subscription_id', s.provider_subscription_id,
        'plan_id', s.plan_id, 'status', s.status, 'billing_interval', s.billing_interval, 'currency', s.currency,
        'unit_amount_minor', s.unit_amount_minor, 'cancel_at_period_end', s.cancel_at_period_end,
        'started_at', s.created_at, 'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
        'canceled_at', s.canceled_at, 'ended_at', s.ended_at) order by s.created_at desc)
      from public.subscriptions s where s.user_id = p_user), '[]'::jsonb),
    'entitlements', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'plan_id', e.plan_id, 'reason', e.reason, 'note', e.note, 'starts_at', e.starts_at, 'expires_at', e.expires_at,
        'revoked_at', e.revoked_at, 'active', e.revoked_at is null and e.starts_at <= now() and (e.expires_at is null or e.expires_at > now()),
        'granted_by', (select email from public.profiles where user_id = e.granted_by)) order by e.created_at desc)
      from public.user_entitlements e where e.user_id = p_user), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object('id', pm.id, 'provider_invoice_id', pm.provider_invoice_id, 'plan_id', pm.plan_id,
          'billing_interval', pm.billing_interval, 'currency', pm.currency, 'amount_due_minor', pm.amount_due_minor,
          'amount_paid_minor', pm.amount_paid_minor, 'amount_refunded_minor', pm.amount_refunded_minor, 'status', pm.status,
          'failure_reason', pm.failure_reason, 'hosted_invoice_url', pm.hosted_invoice_url, 'invoice_pdf_url', pm.invoice_pdf_url,
          'paid_at', pm.paid_at, 'created_at', pm.created_at) as x
        from public.payments pm where pm.user_id = p_user order by pm.created_at desc limit 50) t), '[]'::jsonb),
    'payments_total', (select count(*) from public.payments where user_id = p_user),
    'activity', coalesce((select jsonb_agg(x order by x->>'at' desc) from (
        select jsonb_build_object('kind', a.kind, 'page', a.page, 'at', a.created_at) as x
        from public.user_activity a where a.user_id = p_user order by a.created_at desc limit 50) t), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(x order by (x->>'id')::bigint desc) from (
        select jsonb_build_object('id', l.id, 'action', l.action, 'reason', l.reason, 'at', l.created_at,
          'admin', (select email from public.profiles where user_id = l.admin_id), 'after', l.after) as x
        from public.admin_audit_logs l where l.target_user_id = p_user order by l.id desc limit 30) t), '[]'::jsonb),
    'gold_lots', (select jsonb_array_length(g.lots) from public.user_gold_data g where g.user_id = p_user)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.admin_user_detail(uuid) from public, anon;
grant execute on function public.admin_user_detail(uuid) to authenticated;

-- p: {months (1..36, default 12), tz}
create or replace function public.admin_revenue(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public
set jit = off                                    -- one-row reports: JIT compile time (seconds) >> run time (ms)
as $$
declare
  v_months int := least(greatest(coalesce((p->>'months')::int, 12), 1), 36);
  tz text := case when exists (select 1 from pg_timezone_names where name = p->>'tz') then p->>'tz' else 'Asia/Seoul' end;
  v_from timestamptz := date_trunc('month', (now() at time zone tz) - make_interval(months => v_months - 1)) at time zone tz;
  v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  with paid as (
    select * from public.payments where status in ('paid', 'partially_refunded', 'refunded')
  ),
  live as (select * from public.subscriptions where status in ('active', 'past_due'))
  select jsonb_build_object(
    'tz', tz, 'from', v_from,
    'by_currency', coalesce((select jsonb_object_agg(c, x) from (
        select cur.c, jsonb_build_object(
          'gross_minor',    coalesce((select sum(amount_paid_minor) from paid where currency = cur.c), 0),
          'refunded_minor', coalesce((select sum(amount_refunded_minor) from paid where currency = cur.c), 0),
          'net_minor',      coalesce((select sum(amount_paid_minor - amount_refunded_minor) from paid where currency = cur.c), 0),
          'period_gross_minor', coalesce((select sum(amount_paid_minor) from paid where currency = cur.c and coalesce(paid_at, created_at) >= v_from), 0),
          'period_net_minor',   coalesce((select sum(amount_paid_minor - amount_refunded_minor) from paid where currency = cur.c and coalesce(paid_at, created_at) >= v_from), 0),
          'mrr_minor', coalesce((select round(sum(public.kfp_monthly_minor(unit_amount_minor, billing_interval)))::bigint from live where currency = cur.c), 0),
          'arr_minor', coalesce((select round(sum(public.kfp_monthly_minor(unit_amount_minor, billing_interval)) * 12)::bigint from live where currency = cur.c), 0),
          'payers', (select count(distinct user_id) from live where currency = cur.c)) as x
        from (select distinct currency as c from public.payments union select distinct currency from public.subscriptions where currency is not null) cur
        where cur.c is not null) t), '{}'::jsonb),
    'by_plan', coalesce((select jsonb_agg(x order by x->>'currency', x->>'plan_id') from (
        select jsonb_build_object('plan_id', pl.plan_id, 'currency', pl.currency,
          'subscribers', (select count(*) from live l where l.plan_id = pl.plan_id and l.currency = pl.currency),
          'mrr_minor', coalesce((select round(sum(public.kfp_monthly_minor(unit_amount_minor, billing_interval)))::bigint from live l where l.plan_id = pl.plan_id and l.currency = pl.currency), 0),
          'gross_minor', coalesce((select sum(amount_paid_minor) from paid pd where pd.plan_id = pl.plan_id and pd.currency = pl.currency), 0),
          'net_minor', coalesce((select sum(amount_paid_minor - amount_refunded_minor) from paid pd where pd.plan_id = pl.plan_id and pd.currency = pl.currency), 0)) as x
        from (select distinct plan_id, currency from paid where plan_id is not null
              union select distinct plan_id, currency from live where currency is not null) pl) t), '[]'::jsonb),
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'currency', currency, 'gross_minor', g, 'refunded_minor', r,
          'net_minor', g - r, 'payments', n) order by m, currency) from (
        select to_char(coalesce(paid_at, created_at) at time zone tz, 'YYYY-MM') as m, currency,
               sum(amount_paid_minor) as g, sum(amount_refunded_minor) as r, count(*) as n
        from paid where coalesce(paid_at, created_at) >= v_from group by 1, 2) t), '[]'::jsonb),
    'failed', jsonb_build_object(
        'count_30d', (select count(*) from public.payments where status in ('failed','action_required') and created_at > now() - interval '30 days'),
        'latest', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
          select jsonb_build_object('user_id', pm.user_id, 'email', pr.email, 'currency', pm.currency, 'amount_due_minor', pm.amount_due_minor,
            'status', pm.status, 'failure_reason', pm.failure_reason, 'created_at', pm.created_at, 'hosted_invoice_url', pm.hosted_invoice_url) as x
          from public.payments pm left join public.profiles pr on pr.user_id = pm.user_id
          where pm.status in ('failed','action_required','uncollectible') order by pm.created_at desc limit 20) t), '[]'::jsonb)),
    'refunds', jsonb_build_object(
        'count', (select count(*) from public.payment_refunds where status = 'succeeded'),
        'latest', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
          select jsonb_build_object('user_id', pm.user_id, 'email', pr.email, 'currency', r.currency, 'amount_minor', r.amount_minor,
            'status', r.status, 'reason', r.reason, 'created_at', r.created_at, 'invoice', pm.provider_invoice_id) as x
          from public.payment_refunds r join public.payments pm on pm.id = r.payment_id
          left join public.profiles pr on pr.user_id = pm.user_id
          order by r.created_at desc limit 20) t), '[]'::jsonb))
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.admin_revenue(jsonb) from public, anon;
grant execute on function public.admin_revenue(jsonb) to authenticated;

-- p: {action_prefix, target, page, page_size}
create or replace function public.admin_audit_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public
set jit = off                                    -- one-row reports: JIT compile time (seconds) >> run time (ms)
as $$
declare
  v_size int := least(greatest(coalesce((p->>'page_size')::int, 30), 5), 100);
  v_page int := greatest(coalesce((p->>'page')::int, 1), 1);
  v_act text := nullif(p->>'action_prefix', '');
  v_tgt uuid := nullif(p->>'target', '')::uuid;
  v_out jsonb;
begin
  perform public.kfp_require_admin('viewer');
  with f as (
    select l.*, count(*) over () as total from public.admin_audit_logs l
    where (v_act is null or l.action like replace(replace(v_act, '%', ''), '_', '\_') || '%')
      and (v_tgt is null or l.target_user_id = v_tgt)
    order by l.id desc limit v_size offset (v_page - 1) * v_size
  )
  select jsonb_build_object('page', v_page, 'page_size', v_size,
    'total', coalesce((select total from f limit 1), 0),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'action', f.action, 'reason', f.reason, 'at', f.created_at,
        'admin', (select email from public.profiles where user_id = f.admin_id),
        'target_user_id', f.target_user_id, 'target', (select email from public.profiles where user_id = f.target_user_id),
        'before', f.before, 'after', f.after) order by f.id desc) from f), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.admin_audit_list(jsonb) from public, anon;
grant execute on function public.admin_audit_list(jsonb) to authenticated;

create or replace function public.admin_list_prices()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when public.kfp_require_admin('viewer') > 0 then
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'plan_id', plan_id, 'billing_interval', billing_interval, 'currency', currency,
        'amount_minor', amount_minor, 'active', active, 'provider_price_id', provider_price_id, 'created_at', created_at, 'deactivated_at', deactivated_at)
        order by active desc, plan_id, billing_interval, currency, created_at desc)
      from public.plan_prices), '[]'::jsonb) end
$$;
revoke all on function public.admin_list_prices() from public, anon;
grant execute on function public.admin_list_prices() to authenticated;

-- ---------------------------------------------------------------------
-- 4. write API (admin+) — audited, reason required, never on self
-- ---------------------------------------------------------------------
create or replace function public.kfp_access_snapshot(p_user uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'effective', (select to_jsonb(e) from public.kfp_effective_plan(p_user) e limit 1),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'plan_id', plan_id, 'reason', reason, 'expires_at', expires_at))
                        from public.user_entitlements where user_id = p_user and revoked_at is null), '[]'::jsonb),
    'suspended_at', (select suspended_at from public.profiles where user_id = p_user))
$$;
revoke all on function public.kfp_access_snapshot(uuid) from public, anon, authenticated;

-- Change plan / Grant Premium:  plan = plus | premium (+ optional expiry)  ·  plan = free → revoke all grants
create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_expires_at timestamptz, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_before jsonb; v_after jsonb; n int;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  if p_plan not in ('free', 'plus', 'premium') then raise exception 'invalid_plan' using errcode = '22023'; end if;
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '10 years') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  v_before := public.kfp_access_snapshot(p_user);
  if p_plan = 'free' then
    update public.user_entitlements set revoked_at = now(), revoked_by = me
    where user_id = p_user and revoked_at is null;
  else
    -- one admin grant at a time (legacy launch grants are left alone)
    update public.user_entitlements set revoked_at = now(), revoked_by = me
    where user_id = p_user and revoked_at is null and reason = 'admin_grant';
    insert into public.user_entitlements (user_id, plan_id, expires_at, reason, note, granted_by)
    values (p_user, p_plan, p_expires_at, 'admin_grant', left(p_reason, 500), me);
  end if;
  v_after := public.kfp_access_snapshot(p_user);
  perform public.kfp_audit(case when p_plan = 'free' then 'plan.revoke_all' else 'plan.grant' end,
    p_user, 'user_entitlements', null, v_before, v_after || jsonb_build_object('requested_plan', p_plan, 'expires_at', p_expires_at), p_reason);
  return v_after;
end;
$$;
revoke all on function public.admin_set_plan(uuid, text, timestamptz, text) from public, anon;
grant execute on function public.admin_set_plan(uuid, text, timestamptz, text) to authenticated;

-- Extend access by N days (does NOT touch Stripe billing): extends the active
-- grant, or bridges a subscription with a grant that starts when it ends.
create or replace function public.admin_extend_access(p_user uuid, p_days int, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  eff record; g public.user_entitlements;
  v_before jsonb; v_after jsonb; v_until timestamptz;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  if p_days is null or p_days < 1 or p_days > 3650 then raise exception 'invalid_days' using errcode = '22023'; end if;
  select * into eff from public.kfp_effective_plan(p_user) limit 1;
  if eff.plan_id = 'free' then raise exception 'nothing_to_extend' using errcode = '22023'; end if;
  if eff.valid_until is null then raise exception 'no_expiry' using errcode = '22023'; end if;
  v_before := public.kfp_access_snapshot(p_user);
  v_until := eff.valid_until + make_interval(days => p_days);
  select * into g from public.user_entitlements
  where user_id = p_user and revoked_at is null and plan_id = eff.plan_id and expires_at = eff.valid_until
    and eff.source not like 'subscription:%'
  order by created_at desc limit 1 for update;
  if found then
    update public.user_entitlements set expires_at = v_until where id = g.id;
  else
    insert into public.user_entitlements (user_id, plan_id, starts_at, expires_at, reason, note, granted_by)
    values (p_user, eff.plan_id, now(), v_until, 'admin_grant', left('extend: ' || p_reason, 500), me);
  end if;
  v_after := public.kfp_access_snapshot(p_user);
  perform public.kfp_audit('plan.extend', p_user, 'user_entitlements', g.id::text, v_before,
    v_after || jsonb_build_object('days', p_days, 'until', v_until), p_reason);
  return v_after;
end;
$$;
revoke all on function public.admin_extend_access(uuid, int, text) from public, anon;
grant execute on function public.admin_extend_access(uuid, int, text) to authenticated;

-- Revoke granted access (admin grants + legacy launch). A paid Stripe
-- subscription is NOT changed here — cancel it with admin-actions.
create or replace function public.admin_revoke_access(p_user uuid, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare me uuid := auth.uid(); v_before jsonb; v_after jsonb; n int;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  v_before := public.kfp_access_snapshot(p_user);
  update public.user_entitlements set revoked_at = now(), revoked_by = me
  where user_id = p_user and revoked_at is null;
  get diagnostics n = row_count;
  v_after := public.kfp_access_snapshot(p_user);
  perform public.kfp_audit('plan.revoke', p_user, 'user_entitlements', null, v_before, v_after || jsonb_build_object('revoked', n), p_reason);
  return v_after || jsonb_build_object('revoked', n);
end;
$$;
revoke all on function public.admin_revoke_access(uuid, text) from public, anon;
grant execute on function public.admin_revoke_access(uuid, text) to authenticated;

create or replace function public.admin_set_suspended(p_user uuid, p_suspended boolean, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare me uuid := auth.uid(); v_before jsonb; v_after jsonb;
begin
  perform public.kfp_require_admin('admin');
  perform public.kfp_guard_target(p_user, me, p_reason);
  if p_suspended is null then raise exception 'invalid_request' using errcode = '22023'; end if;
  v_before := public.kfp_access_snapshot(p_user);
  update public.profiles set suspended_at = case when p_suspended then coalesce(suspended_at, now()) else null end
  where user_id = p_user;
  v_after := public.kfp_access_snapshot(p_user);
  perform public.kfp_audit(case when p_suspended then 'user.suspend' else 'user.reactivate' end,
    p_user, 'profiles', p_user::text, v_before, v_after, p_reason);
  return v_after;
end;
$$;
revoke all on function public.admin_set_suspended(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_suspended(uuid, boolean, text) to authenticated;

-- Edge Function admin-actions writes its audit row through this (service_role only).
create or replace function public.kfp_admin_audit(p jsonb)
returns bigint
language sql volatile security definer
set search_path = public
as $$
  select public.kfp_audit(p->>'action', nullif(p->>'target_user_id', '')::uuid, p->>'target_table', p->>'target_id',
                          p->'before', p->'after', p->>'reason', (p->>'admin_id')::uuid)
$$;
revoke all on function public.kfp_admin_audit(jsonb) from public, anon, authenticated;
grant execute on function public.kfp_admin_audit(jsonb) to service_role;
