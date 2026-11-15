-- =====================================================================
-- Korea Finance Planner · Smart Credit & Debt (16/11/2026)   — migration 1700
--
-- Premium-only module, readable for ever by its owner:
--   • feature "credit_debt" (Finance Premium; staff get it through their Premium grant)
--   • tables credit_cards · installment_plans · installment_schedules · debt_transfers
--            debt_payments · debt_adjustments · debt_payoff_plans
--       browsers: SELECT own rows only (no plan check → expired members keep read-only access)
--                 NO insert / update / delete grants at all
--   • every write goes through a SECURITY DEFINER RPC that checks
--       signed in → kfp_has_feature(uid, 'credit_debt') → rate limit → ownership of every id
--     idempotent (client_request_id) · optimistic concurrency (version) · one transaction each
--   • get_my_debt_access()  full | read_only | locked  (display only — RPCs enforce)
--   • export_my_debt()      read-only export of the member's own rows
-- Money is bigint minor units (KRW = won, THB = satang).  Additive, re-runnable; nothing existing
-- is dropped (kfp_security_report is re-created with the new RPCs in its allowlist).
-- Rollback: update plans set features = features - 'credit_debt'  (+ hide the entry points).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. feature
-- ---------------------------------------------------------------------
update public.plans set features = features || jsonb_build_object('credit_debt', id = 'premium')
where kind = 'plan';

-- ---------------------------------------------------------------------
-- 1. tables
-- ---------------------------------------------------------------------
create table if not exists public.credit_cards (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  client_request_id     uuid,
  name                  text not null check (char_length(name) between 1 and 60),
  bank                  text not null default '' check (char_length(bank) <= 60),
  country               text check (country is null or country in ('TH', 'KR')),
  currency              text not null check (currency in ('THB', 'KRW')),
  last4                 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  credit_limit_minor    bigint not null default 0 check (credit_limit_minor between 0 and 999999999999999),
  opening_balance_minor bigint not null default 0 check (opening_balance_minor between -999999999999999 and 999999999999999),
  opening_date          date not null default current_date,
  statement_day         smallint check (statement_day between 1 and 31),
  due_day               smallint check (due_day between 1 and 31),
  apr_bp                integer not null default 0 check (apr_bp between 0 and 10000),
  installment_mode      text not null default 'per_period' check (installment_mode in ('per_period', 'full_hold')),
  color                 text not null default '#d4af37' check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon                  text not null default '💳' check (char_length(icon) between 1 and 8),
  notes                 text not null default '' check (char_length(notes) <= 500),
  status                text not null default 'active' check (status in ('active', 'archived')),
  version               bigint not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.credit_cards is 'Smart Credit & Debt: member''s credit cards (no full number / CVV / PIN — last 4 digits only). Writes only through debt_* RPCs.';

create table if not exists public.installment_plans (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  client_request_id   uuid,
  card_id             uuid references public.credit_cards(id) on delete restrict,
  transfer_id         uuid,
  currency            text not null check (currency in ('THB', 'KRW')),
  product             text not null check (char_length(product) between 1 and 80),
  category            text not null default '' check (char_length(category) <= 40),
  merchant            text not null default '' check (char_length(merchant) <= 60),
  purchase_date       date not null,
  original_minor      bigint not null check (original_minor between 1 and 999999999999999),
  down_minor          bigint not null default 0 check (down_minor >= 0),
  financed_minor      bigint not null check (financed_minor > 0),
  rate_bp             integer not null default 0 check (rate_bp between 0 and 10000),
  method              text not null check (method in ('zero', 'fixed', 'reducing', 'custom')),
  months              smallint not null check (months between 1 and 120),
  first_due_date      date not null,
  monthly_minor       bigint not null default 0,
  total_payable_minor bigint not null default 0,
  status              text not null default 'active' check (status in ('active', 'paused', 'settled', 'cancelled')),
  status_date         date,
  revision            integer not null default 1,
  notes               text not null default '' check (char_length(notes) <= 500),
  version             bigint not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint installment_financed_ck check (financed_minor = original_minor - down_minor)
);
comment on table public.installment_plans is 'Smart Credit & Debt: installment plans (on a card, or with a shop/finance company when card_id is null).';

create table if not exists public.installment_schedules (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  plan_id             uuid not null references public.installment_plans(id) on delete cascade,
  revision            integer not null,
  seq                 smallint not null check (seq between 1 and 120),
  due_date            date not null,
  principal_minor     bigint not null check (principal_minor >= 0),
  interest_minor      bigint not null default 0 check (interest_minor >= 0),
  fee_minor           bigint not null default 0 check (fee_minor >= 0),
  amount_minor        bigint not null check (amount_minor >= 0),
  actual_amount_minor bigint check (actual_amount_minor >= 0),
  confirmed_at        timestamptz,
  superseded_at       timestamptz,
  created_at          timestamptz not null default now(),
  constraint installment_schedule_once unique (plan_id, revision, seq)
);
comment on table public.installment_schedules is 'Generated installment rows. Editing a plan''s money terms creates a new revision; old rows stay (superseded) as history.';

create table if not exists public.debt_transfers (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  client_request_id   uuid,
  type                text not null check (type in ('balance_transfer', 'card_payment', 'cash_advance', 'restructure')),
  from_card_id        uuid references public.credit_cards(id) on delete restrict,
  to_card_id          uuid references public.credit_cards(id) on delete restrict,
  currency            text not null check (currency in ('THB', 'KRW')),
  amount_minor        bigint not null check (amount_minor between 1 and 999999999999999),
  fee_minor           bigint not null default 0 check (fee_minor >= 0),
  rate_bp             integer not null default 0 check (rate_bp between 0 and 10000),
  installments        smallint not null default 0 check (installments between 0 and 120),
  transfer_date       date not null,
  effective_date      date not null,
  status              text not null default 'draft' check (status in ('draft', 'pending', 'confirmed', 'failed', 'cancelled')),
  fx_rate             numeric(20, 10) check (fx_rate is null or fx_rate > 0),
  fx_source           text check (fx_source is null or char_length(fx_source) <= 40),
  fx_date             date,
  dest_currency       text not null check (dest_currency in ('THB', 'KRW')),
  dest_amount_minor   bigint not null check (dest_amount_minor > 0),
  related_ref         text not null default '' check (char_length(related_ref) <= 60),
  notes               text not null default '' check (char_length(notes) <= 500),
  confirmed_at        timestamptz,
  version             bigint not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint debt_transfer_cards_ck check (to_card_id is not null and (type = 'cash_advance' or from_card_id is not null)),
  constraint debt_transfer_fx_ck check (currency = dest_currency or (fx_rate is not null and fx_date is not null))
);
comment on table public.debt_transfers is 'Smart Credit & Debt: balance transfers, card-to-card payments, cash advances, restructuring. Balances change only once confirmed.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'installment_plans_transfer_fk') then
    alter table public.installment_plans add constraint installment_plans_transfer_fk
      foreign key (transfer_id) references public.debt_transfers(id) on delete set null;
  end if;
end $$;

create table if not exists public.debt_payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  client_request_id   uuid,
  card_id             uuid references public.credit_cards(id) on delete restrict,
  plan_id             uuid references public.installment_plans(id) on delete restrict,
  schedule_id         bigint references public.installment_schedules(id) on delete set null,
  transfer_id         uuid references public.debt_transfers(id) on delete set null,
  kind                text not null check (kind in ('full', 'partial', 'minimum', 'statement', 'early', 'extra_principal', 'settlement')),
  currency            text not null check (currency in ('THB', 'KRW')),
  amount_minor        bigint not null check (amount_minor between 1 and 999999999999999),
  principal_minor     bigint not null default 0 check (principal_minor >= 0),
  interest_minor      bigint not null default 0 check (interest_minor >= 0),
  fee_minor           bigint not null default 0 check (fee_minor >= 0),
  paid_on             date not null,
  method              text not null default 'bank_transfer' check (method in ('bank_transfer', 'cash', 'auto_debit', 'card', 'other')),
  status              text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  notes               text not null default '' check (char_length(notes) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint debt_payment_target_ck check (card_id is not null or plan_id is not null),
  constraint debt_payment_split_ck check (principal_minor + interest_minor + fee_minor <= amount_minor)
);
comment on table public.debt_payments is 'Smart Credit & Debt: payments to a card or a shop installment plan. Never creates expenses (no double counting).';

create table if not exists public.debt_adjustments (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  client_request_id       uuid,
  card_id                 uuid not null references public.credit_cards(id) on delete restrict,
  kind                    text not null check (kind in ('purchase', 'interest', 'fee', 'refund', 'reconcile', 'other')),
  currency                text not null check (currency in ('THB', 'KRW')),
  amount_minor            bigint not null check (amount_minor <> 0 and amount_minor between -999999999999999 and 999999999999999),
  effective_date          date not null,
  statement_balance_minor bigint,
  status                  text not null default 'active' check (status in ('active', 'cancelled')),
  notes                   text not null default '' check (char_length(notes) <= 500),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint debt_adjust_reconcile_ck check (kind <> 'reconcile' or statement_balance_minor is not null)
);
comment on table public.debt_adjustments is 'Smart Credit & Debt: manual card adjustments and statement reconciliation (confirmed amounts).';

create table if not exists public.debt_payoff_plans (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  client_request_id   uuid,
  name                text not null check (char_length(name) between 1 and 60),
  strategy            text not null check (strategy in ('snowball', 'avalanche', 'custom')),
  currency            text not null check (currency in ('THB', 'KRW')),
  budget_minor        bigint not null check (budget_minor between 1 and 999999999999999),
  priorities          jsonb not null default '[]'::jsonb check (jsonb_typeof(priorities) = 'array'),
  assumptions         jsonb not null default '{}'::jsonb check (jsonb_typeof(assumptions) = 'object'),
  result              jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  version             bigint not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint debt_payoff_size_ck check (pg_column_size(priorities) + pg_column_size(assumptions) + pg_column_size(result) <= 262144)
);
comment on table public.debt_payoff_plans is 'Smart Credit & Debt: saved Snowball / Avalanche / Custom payoff plans with their inputs and results.';

-- idempotency + lookups
create unique index if not exists credit_cards_req_uq      on public.credit_cards (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists installment_plans_req_uq on public.installment_plans (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists debt_transfers_req_uq    on public.debt_transfers (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists debt_payments_req_uq     on public.debt_payments (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists debt_adjustments_req_uq  on public.debt_adjustments (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists debt_payoff_req_uq       on public.debt_payoff_plans (user_id, client_request_id) where client_request_id is not null;
create unique index if not exists installment_plans_transfer_uq on public.installment_plans (transfer_id) where transfer_id is not null;
create index if not exists credit_cards_user_idx          on public.credit_cards (user_id, currency);
create index if not exists installment_plans_user_idx     on public.installment_plans (user_id, currency);
create index if not exists installment_plans_card_idx     on public.installment_plans (card_id);
create index if not exists installment_schedules_plan_idx on public.installment_schedules (plan_id, revision);
create index if not exists installment_schedules_due_idx  on public.installment_schedules (user_id, due_date);
create index if not exists debt_transfers_user_idx        on public.debt_transfers (user_id, effective_date);
create index if not exists debt_transfers_from_idx        on public.debt_transfers (from_card_id);
create index if not exists debt_transfers_to_idx          on public.debt_transfers (to_card_id);
create index if not exists debt_payments_user_idx         on public.debt_payments (user_id, paid_on);
create index if not exists debt_payments_card_idx         on public.debt_payments (card_id);
create index if not exists debt_payments_plan_idx         on public.debt_payments (plan_id);
create index if not exists debt_adjustments_card_idx      on public.debt_adjustments (card_id);
create index if not exists debt_payoff_user_idx           on public.debt_payoff_plans (user_id);

-- updated_at
do $$ declare t text; begin
  foreach t in array array['credit_cards', 'installment_plans', 'debt_transfers', 'debt_payments', 'debt_adjustments', 'debt_payoff_plans'] loop
    execute format('drop trigger if exists %1$s_touch_updated_at on public.%1$s', t);
    execute format('create trigger %1$s_touch_updated_at before update on public.%1$s for each row execute procedure public.touch_kfp_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. RLS: read own rows in every plan state · no browser writes at all
-- ---------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['credit_cards', 'installment_plans', 'installment_schedules', 'debt_transfers',
                           'debt_payments', 'debt_adjustments', 'debt_payoff_plans'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_select_own', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------
-- the only door to every write: signed in + Premium (credit_debt) + rate limit
create or replace function public.kfp_debt_write_guard()
returns uuid
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.kfp_has_feature(uid, 'credit_debt') then
    raise exception 'premium_required' using errcode = '42501';
  end if;
  if not public.kfp_rate_hit('debt:' || uid::text, 600, 3600) then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  return uid;
end;
$$;

create or replace function public.kfp_debt_int(p jsonb, k text, def bigint default null, required boolean default false)
returns bigint
language plpgsql immutable
set search_path = public
as $$
declare v jsonb := p -> k; t text;
begin
  if v is null or v = 'null'::jsonb or btrim(coalesce(v #>> '{}', '')) = '' then
    if required then raise exception 'invalid_%', k using errcode = '22023'; end if;
    return def;
  end if;
  t := btrim(v #>> '{}');
  if t !~ '^-?[0-9]{1,15}$' then raise exception 'invalid_%', k using errcode = '22023'; end if;
  return t::bigint;
end;
$$;

create or replace function public.kfp_debt_date(p jsonb, k text, required boolean default false)
returns date
language plpgsql immutable
set search_path = public
as $$
declare t text := btrim(coalesce(p ->> k, '')); d date;
begin
  if t = '' then
    if required then raise exception 'invalid_%', k using errcode = '22023'; end if;
    return null;
  end if;
  if t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid_%', k using errcode = '22023'; end if;
  begin d := t::date; exception when others then raise exception 'invalid_%', k using errcode = '22023'; end;
  if d < date '2000-01-01' or d > date '2100-12-31' then raise exception 'invalid_%', k using errcode = '22023'; end if;
  return d;
end;
$$;

create or replace function public.kfp_debt_txt(p jsonb, k text, maxlen int, def text default '')
returns text
language plpgsql immutable
set search_path = public
as $$
declare t text := btrim(coalesce(p ->> k, def));
begin
  if char_length(t) > maxlen then raise exception 'too_long_%', k using errcode = '22023'; end if;
  return t;
end;
$$;

create or replace function public.kfp_debt_uuid(p jsonb, k text)
returns uuid
language plpgsql immutable
set search_path = public
as $$
declare t text := btrim(coalesce(p ->> k, ''));
begin
  if t = '' then return null; end if;
  if t !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_%', k using errcode = '22023';
  end if;
  return t::uuid;
end;
$$;

-- a card of THIS member (raises card_not_found otherwise — never reveals other members' ids)
create or replace function public.kfp_debt_card(p_uid uuid, p_id uuid)
returns public.credit_cards
language plpgsql stable security definer
set search_path = public
as $$
declare c public.credit_cards;
begin
  select * into c from public.credit_cards where id = p_id and user_id = p_uid;
  if not found then raise exception 'card_not_found' using errcode = 'P0002'; end if;
  return c;
end;
$$;

-- installment rows (pure). Amounts are integer minor units; the last row takes every remainder.
--   zero      principal ÷ n
--   fixed     flat rate: total interest = P × rate/yr ÷ 12 × n, split evenly
--   reducing  amortised: payment = P·r / (1 − (1+r)^−n), r = rate/12; interest = balance × r
--   custom    rows given as [{due_date, amount}, …] (amount = principal, no interest)
-- due date n = first due + (n−1) months (Postgres clamps to the month's last day)
create or replace function public.kfp_debt_build_schedule(p_financed bigint, p_rate_bp int, p_method text, p_months int,
                                                          p_first_due date, p_custom jsonb default null)
returns table (seq int, due_date date, principal bigint, interest bigint)
language plpgsql immutable
set search_path = public
as $$
declare
  i int; base bigint; rem bigint; ti bigint; ib bigint; ir bigint;
  r numeric; pay bigint; bal bigint; it bigint; pr bigint; el jsonb; prev date;
begin
  if p_method = 'custom' then
    if p_custom is null or jsonb_typeof(p_custom) <> 'array' or jsonb_array_length(p_custom) not between 1 and 120 then
      raise exception 'invalid_custom' using errcode = '22023';
    end if;
    i := 0; prev := null;
    for el in select x from jsonb_array_elements(p_custom) x loop
      i := i + 1;
      seq := i;
      due_date := public.kfp_debt_date(el, 'due_date', true);
      principal := public.kfp_debt_int(el, 'amount', null, true);
      if principal <= 0 then raise exception 'invalid_custom' using errcode = '22023'; end if;
      if prev is not null and due_date < prev then raise exception 'invalid_custom' using errcode = '22023'; end if;
      prev := due_date; interest := 0;
      return next;
    end loop;
    return;
  end if;
  if p_months is null or p_months not between 1 and 120 then raise exception 'invalid_months' using errcode = '22023'; end if;

  if p_method = 'zero' or (p_method in ('fixed', 'reducing') and p_rate_bp = 0) then
    base := p_financed / p_months; rem := p_financed - base * p_months;
    for i in 1..p_months loop
      seq := i; due_date := (p_first_due + make_interval(months => i - 1))::date;
      principal := base + case when i = p_months then rem else 0 end; interest := 0;
      return next;
    end loop;
    return;
  end if;

  if p_method = 'fixed' then
    ti := round(p_financed::numeric * p_rate_bp / 10000 / 12 * p_months);
    base := p_financed / p_months; rem := p_financed - base * p_months;
    ib := ti / p_months; ir := ti - ib * p_months;
    for i in 1..p_months loop
      seq := i; due_date := (p_first_due + make_interval(months => i - 1))::date;
      principal := base + case when i = p_months then rem else 0 end;
      interest := ib + case when i = p_months then ir else 0 end;
      return next;
    end loop;
    return;
  end if;

  if p_method = 'reducing' then
    r := p_rate_bp::numeric / 10000 / 12;
    pay := round(p_financed * r / (1 - power(1 + r, -p_months)));
    bal := p_financed;
    for i in 1..p_months loop
      it := round(bal * r);
      if i = p_months then pr := bal; else pr := greatest(least(pay - it, bal), 0); end if;
      bal := bal - pr;
      seq := i; due_date := (p_first_due + make_interval(months => i - 1))::date;
      principal := pr; interest := it;
      return next;
    end loop;
    return;
  end if;
  raise exception 'invalid_method' using errcode = '22023';
end;
$$;

-- writes the rows of one revision and refreshes the plan's totals
create or replace function public.kfp_debt_write_schedule(p_plan uuid, p_custom jsonb default null)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare pl public.installment_plans; n int;
begin
  select * into pl from public.installment_plans where id = p_plan;
  insert into public.installment_schedules (user_id, plan_id, revision, seq, due_date, principal_minor, interest_minor, amount_minor)
  select pl.user_id, pl.id, pl.revision, s.seq, s.due_date, s.principal, s.interest, s.principal + s.interest
  from public.kfp_debt_build_schedule(pl.financed_minor, pl.rate_bp, pl.method, pl.months, pl.first_due_date, p_custom) s;
  get diagnostics n = row_count;
  update public.installment_plans p set
    months = n,
    total_payable_minor = (select coalesce(sum(amount_minor), 0) from public.installment_schedules
                           where plan_id = p.id and revision = p.revision),
    monthly_minor = (select amount_minor from public.installment_schedules
                     where plan_id = p.id and revision = p.revision and seq = 1)
  where p.id = pl.id;
end;
$$;

create or replace function public.kfp_debt_plan_json(p_plan uuid)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select to_jsonb(p) || jsonb_build_object('schedule', coalesce((
    select jsonb_agg(to_jsonb(s) order by s.seq) from public.installment_schedules s
    where s.plan_id = p.id and s.revision = p.revision), '[]'::jsonb))
  from public.installment_plans p where p.id = p_plan
$$;

create or replace function public.kfp_debt_check_version(p jsonb, current_version bigint)
returns void
language plpgsql immutable
set search_path = public
as $$
declare b bigint := public.kfp_debt_int(p, 'base_version');
begin
  if b is null then raise exception 'base_version_required' using errcode = '22023'; end if;
  if b <> current_version then raise exception 'conflict' using errcode = '40001'; end if;
end;
$$;

do $$ declare f text; begin
  foreach f in array array['kfp_debt_write_guard()', 'kfp_debt_int(jsonb, text, bigint, boolean)', 'kfp_debt_date(jsonb, text, boolean)',
                           'kfp_debt_txt(jsonb, text, int, text)', 'kfp_debt_uuid(jsonb, text)', 'kfp_debt_card(uuid, uuid)',
                           'kfp_debt_build_schedule(bigint, int, text, int, date, jsonb)', 'kfp_debt_write_schedule(uuid, jsonb)',
                           'kfp_debt_plan_json(uuid)', 'kfp_debt_check_version(jsonb, bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. access (display only) + export (read-only)
-- ---------------------------------------------------------------------
create or replace function public.get_my_debt_access()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare uid uuid := auth.uid(); e record; full_ boolean; has boolean; sub record;
begin
  if uid is null then return jsonb_build_object('mode', 'guest'); end if;
  full_ := public.kfp_has_feature(uid, 'credit_debt');
  has := exists (select 1 from public.credit_cards where user_id = uid)
      or exists (select 1 from public.installment_plans where user_id = uid)
      or exists (select 1 from public.debt_transfers where user_id = uid)
      or exists (select 1 from public.debt_payments where user_id = uid)
      or exists (select 1 from public.debt_payoff_plans where user_id = uid);
  select * into e from public.kfp_effective_plan(uid) limit 1;
  select s.status, s.cancel_at_period_end, s.canceled_at, s.current_period_end into sub
  from public.subscriptions s join public.plans pl on pl.id = s.plan_id and pl.kind = 'plan'
  where s.user_id = uid order by s.created_at desc limit 1;
  return jsonb_build_object(
    'mode', case when full_ then 'full' when has then 'read_only' else 'locked' end,
    'has_data', has,
    'plan', e.plan_id, 'source', e.source, 'status', e.status, 'valid_until', e.valid_until,
    'subscription_status', sub.status, 'cancel_at_period_end', sub.cancel_at_period_end,
    'canceled_at', sub.canceled_at, 'current_period_end', sub.current_period_end,
    'suspended', exists (select 1 from public.profiles where user_id = uid and suspended_at is not null),
    'checked_at', now());
end;
$$;

create or replace function public.export_my_debt()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'exported_at', now(),
    'credit_cards', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.credit_cards x where x.user_id = auth.uid()), '[]'),
    'installment_plans', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.installment_plans x where x.user_id = auth.uid()), '[]'),
    'installment_schedules', coalesce((select jsonb_agg(to_jsonb(x) order by x.plan_id, x.revision, x.seq) from public.installment_schedules x where x.user_id = auth.uid()), '[]'),
    'debt_transfers', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.debt_transfers x where x.user_id = auth.uid()), '[]'),
    'debt_payments', coalesce((select jsonb_agg(to_jsonb(x) order by x.paid_on, x.created_at) from public.debt_payments x where x.user_id = auth.uid()), '[]'),
    'debt_adjustments', coalesce((select jsonb_agg(to_jsonb(x) order by x.effective_date, x.created_at) from public.debt_adjustments x where x.user_id = auth.uid()), '[]'),
    'debt_payoff_plans', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.debt_payoff_plans x where x.user_id = auth.uid()), '[]')
  ) end
$$;

-- ---------------------------------------------------------------------
-- 5. cards
-- ---------------------------------------------------------------------
create or replace function public.debt_save_card(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := public.kfp_debt_write_guard();
  v_id uuid := public.kfp_debt_uuid(p, 'id');
  crid uuid := public.kfp_debt_uuid(p, 'client_request_id');
  c public.credit_cards; cur text; used boolean;
  l4 text := nullif(public.kfp_debt_txt(p, 'last4', 4), '');
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  cur := upper(coalesce(p ->> 'currency', ''));
  if cur not in ('THB', 'KRW') then raise exception 'invalid_currency' using errcode = '22023'; end if;
  if v_id is null then
    if crid is not null then
      select * into c from public.credit_cards where user_id = uid and client_request_id = crid;
      if found then return to_jsonb(c); end if;
    end if;
    if (select count(*) from public.credit_cards where user_id = uid) >= 50 then raise exception 'too_many_cards' using errcode = '54000'; end if;
    insert into public.credit_cards (user_id, client_request_id, name, bank, country, currency, last4, credit_limit_minor,
      opening_balance_minor, opening_date, statement_day, due_day, apr_bp, installment_mode, color, icon, notes)
    values (uid, crid, public.kfp_debt_txt(p, 'name', 60), public.kfp_debt_txt(p, 'bank', 60),
      nullif(upper(public.kfp_debt_txt(p, 'country', 2)), ''), cur, l4,
      coalesce(public.kfp_debt_int(p, 'credit_limit_minor'), 0), coalesce(public.kfp_debt_int(p, 'opening_balance_minor'), 0),
      coalesce(public.kfp_debt_date(p, 'opening_date'), current_date),
      public.kfp_debt_int(p, 'statement_day'), public.kfp_debt_int(p, 'due_day'), coalesce(public.kfp_debt_int(p, 'apr_bp'), 0),
      coalesce(nullif(p ->> 'installment_mode', ''), 'per_period'), coalesce(nullif(p ->> 'color', ''), '#d4af37'),
      coalesce(nullif(public.kfp_debt_txt(p, 'icon', 8), ''), '💳'), public.kfp_debt_txt(p, 'notes', 500))
    returning * into c;
    return to_jsonb(c);
  end if;

  select * into c from public.credit_cards where id = v_id and user_id = uid for update;
  if not found then raise exception 'card_not_found' using errcode = 'P0002'; end if;
  perform public.kfp_debt_check_version(p, c.version);
  used := exists (select 1 from public.installment_plans where card_id = c.id)
       or exists (select 1 from public.debt_transfers where from_card_id = c.id or to_card_id = c.id)
       or exists (select 1 from public.debt_payments where card_id = c.id)
       or exists (select 1 from public.debt_adjustments where card_id = c.id);
  if used and cur <> c.currency then raise exception 'currency_locked' using errcode = '22023'; end if;
  update public.credit_cards set
    name = public.kfp_debt_txt(p, 'name', 60), bank = public.kfp_debt_txt(p, 'bank', 60),
    country = nullif(upper(public.kfp_debt_txt(p, 'country', 2)), ''), currency = cur, last4 = l4,
    credit_limit_minor = coalesce(public.kfp_debt_int(p, 'credit_limit_minor'), 0),
    opening_balance_minor = coalesce(public.kfp_debt_int(p, 'opening_balance_minor'), 0),
    opening_date = coalesce(public.kfp_debt_date(p, 'opening_date'), c.opening_date),
    statement_day = public.kfp_debt_int(p, 'statement_day'), due_day = public.kfp_debt_int(p, 'due_day'),
    apr_bp = coalesce(public.kfp_debt_int(p, 'apr_bp'), 0),
    installment_mode = coalesce(nullif(p ->> 'installment_mode', ''), c.installment_mode),
    color = coalesce(nullif(p ->> 'color', ''), c.color), icon = coalesce(nullif(public.kfp_debt_txt(p, 'icon', 8), ''), c.icon),
    notes = public.kfp_debt_txt(p, 'notes', 500), version = c.version + 1
  where id = c.id returning * into c;
  return to_jsonb(c);
end;
$$;

create or replace function public.debt_set_card_status(p_id uuid, p_status text, p_base_version bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); c public.credit_cards;
begin
  if p_status not in ('active', 'archived') then raise exception 'invalid_status' using errcode = '22023'; end if;
  select * into c from public.credit_cards where id = p_id and user_id = uid for update;
  if not found then raise exception 'card_not_found' using errcode = 'P0002'; end if;
  if p_base_version is distinct from c.version then raise exception 'conflict' using errcode = '40001'; end if;
  update public.credit_cards set status = p_status, version = version + 1 where id = c.id returning * into c;
  return to_jsonb(c);
end;
$$;

create or replace function public.debt_delete_card(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); c public.credit_cards;
begin
  select * into c from public.credit_cards where id = p_id and user_id = uid for update;
  if not found then raise exception 'card_not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.installment_plans where card_id = c.id)
     or exists (select 1 from public.debt_transfers where from_card_id = c.id or to_card_id = c.id)
     or exists (select 1 from public.debt_payments where card_id = c.id)
     or exists (select 1 from public.debt_adjustments where card_id = c.id) then
    raise exception 'card_has_history' using errcode = '23503';
  end if;
  delete from public.credit_cards where id = c.id;
  return jsonb_build_object('deleted', c.id);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. installments
-- ---------------------------------------------------------------------
create or replace function public.debt_save_installment(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := public.kfp_debt_write_guard();
  v_id uuid := public.kfp_debt_uuid(p, 'id');
  crid uuid := public.kfp_debt_uuid(p, 'client_request_id');
  v_card uuid := public.kfp_debt_uuid(p, 'card_id');
  c public.credit_cards; pl public.installment_plans; old public.installment_plans;
  cur text; meth text := coalesce(p ->> 'method', ''); orig bigint; dn bigint; rate int; mo int; fd date; pd date;
  cust jsonb := case when jsonb_typeof(p -> 'custom') = 'array' then p -> 'custom' else null end;
  fin_changed boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if v_id is null and crid is not null then
    select * into pl from public.installment_plans where user_id = uid and client_request_id = crid;
    if found then return public.kfp_debt_plan_json(pl.id); end if;
  end if;
  if meth not in ('zero', 'fixed', 'reducing', 'custom') then raise exception 'invalid_method' using errcode = '22023'; end if;
  if v_card is not null then
    c := public.kfp_debt_card(uid, v_card); cur := c.currency;
  else
    cur := upper(coalesce(p ->> 'currency', ''));
    if cur not in ('THB', 'KRW') then raise exception 'invalid_currency' using errcode = '22023'; end if;
  end if;
  orig := public.kfp_debt_int(p, 'original_minor', null, true);
  dn := coalesce(public.kfp_debt_int(p, 'down_minor'), 0);
  if orig <= 0 or dn < 0 or dn >= orig then raise exception 'invalid_amount' using errcode = '22023'; end if;
  rate := coalesce(public.kfp_debt_int(p, 'rate_bp'), 0);
  if rate not between 0 and 10000 then raise exception 'invalid_rate_bp' using errcode = '22023'; end if;
  if meth = 'custom' then
    if cust is null then raise exception 'invalid_custom' using errcode = '22023'; end if;
    mo := jsonb_array_length(cust);
    fd := public.kfp_debt_date(cust -> 0, 'due_date', true);
  else
    mo := public.kfp_debt_int(p, 'months', null, true);
    fd := public.kfp_debt_date(p, 'first_due_date', true);
  end if;
  if mo not between 1 and 120 then raise exception 'invalid_months' using errcode = '22023'; end if;
  pd := public.kfp_debt_date(p, 'purchase_date', true);

  if v_id is null then
    if v_card is not null and c.status = 'archived' then raise exception 'card_archived' using errcode = '22023'; end if;
    if (select count(*) from public.installment_plans where user_id = uid) >= 500 then raise exception 'too_many_plans' using errcode = '54000'; end if;
    insert into public.installment_plans (user_id, client_request_id, card_id, currency, product, category, merchant, purchase_date,
      original_minor, down_minor, financed_minor, rate_bp, method, months, first_due_date, notes)
    values (uid, crid, v_card, cur, public.kfp_debt_txt(p, 'product', 80), public.kfp_debt_txt(p, 'category', 40),
      public.kfp_debt_txt(p, 'merchant', 60), pd, orig, dn, orig - dn, rate, meth, mo, fd, public.kfp_debt_txt(p, 'notes', 500))
    returning * into pl;
    perform public.kfp_debt_write_schedule(pl.id, cust);
    return public.kfp_debt_plan_json(pl.id);
  end if;

  select * into old from public.installment_plans where id = v_id and user_id = uid for update;
  if not found then raise exception 'plan_not_found' using errcode = 'P0002'; end if;
  perform public.kfp_debt_check_version(p, old.version);
  fin_changed := old.card_id is distinct from v_card or old.original_minor <> orig or old.down_minor <> dn
              or old.rate_bp <> rate or old.method <> meth or old.months <> mo or old.first_due_date <> fd
              or old.purchase_date <> pd or meth = 'custom';
  if fin_changed and old.status in ('settled', 'cancelled') then raise exception 'plan_closed' using errcode = '22023'; end if;
  if fin_changed and old.transfer_id is not null then raise exception 'plan_from_transfer' using errcode = '22023'; end if;
  if fin_changed and old.card_id is distinct from v_card
     and exists (select 1 from public.debt_payments where plan_id = old.id) then
    raise exception 'plan_has_payments' using errcode = '23503';
  end if;
  update public.installment_plans set
    product = public.kfp_debt_txt(p, 'product', 80), category = public.kfp_debt_txt(p, 'category', 40),
    merchant = public.kfp_debt_txt(p, 'merchant', 60), notes = public.kfp_debt_txt(p, 'notes', 500),
    version = old.version + 1
  where id = old.id;
  if fin_changed then
    update public.installment_schedules set superseded_at = now() where plan_id = old.id and revision = old.revision;
    update public.installment_plans set card_id = v_card, currency = cur, purchase_date = pd, original_minor = orig, down_minor = dn,
      financed_minor = orig - dn, rate_bp = rate, method = meth, months = mo, first_due_date = fd, revision = old.revision + 1
    where id = old.id;
    perform public.kfp_debt_write_schedule(old.id, cust);
  end if;
  return public.kfp_debt_plan_json(old.id);
end;
$$;

create or replace function public.debt_set_installment_status(p_id uuid, p_status text, p_base_version bigint, p_date date default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); pl public.installment_plans;
begin
  select * into pl from public.installment_plans where id = p_id and user_id = uid for update;
  if not found then raise exception 'plan_not_found' using errcode = 'P0002'; end if;
  if p_base_version is distinct from pl.version then raise exception 'conflict' using errcode = '40001'; end if;
  if not ((pl.status = 'active' and p_status in ('paused', 'settled', 'cancelled'))
       or (pl.status = 'paused' and p_status in ('active', 'settled', 'cancelled'))) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  update public.installment_plans set status = p_status,
    status_date = case when p_status = 'active' then null else coalesce(p_date, current_date) end,
    version = version + 1
  where id = pl.id;
  return public.kfp_debt_plan_json(pl.id);
end;
$$;

create or replace function public.debt_delete_installment(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); pl public.installment_plans;
begin
  select * into pl from public.installment_plans where id = p_id and user_id = uid for update;
  if not found then raise exception 'plan_not_found' using errcode = 'P0002'; end if;
  if pl.transfer_id is not null then raise exception 'plan_from_transfer' using errcode = '22023'; end if;
  if exists (select 1 from public.debt_payments where plan_id = pl.id) then raise exception 'plan_has_payments' using errcode = '23503'; end if;
  delete from public.installment_plans where id = pl.id;
  return jsonb_build_object('deleted', pl.id);
end;
$$;

-- confirm one row's real amount from the statement (null = back to the estimate)
create or replace function public.debt_confirm_schedule(p_row bigint, p_amount bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); s public.installment_schedules;
begin
  select * into s from public.installment_schedules where id = p_row and user_id = uid and superseded_at is null for update;
  if not found then raise exception 'row_not_found' using errcode = 'P0002'; end if;
  if p_amount is not null and p_amount not between 0 and 999999999999999 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  update public.installment_schedules set actual_amount_minor = p_amount,
    confirmed_at = case when p_amount is null then null else now() end
  where id = s.id returning * into s;
  return to_jsonb(s);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. payments
-- ---------------------------------------------------------------------
create or replace function public.debt_record_payment(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := public.kfp_debt_write_guard();
  crid uuid := public.kfp_debt_uuid(p, 'client_request_id');
  v_card uuid := public.kfp_debt_uuid(p, 'card_id'); v_plan uuid := public.kfp_debt_uuid(p, 'plan_id');
  v_tr uuid := public.kfp_debt_uuid(p, 'transfer_id'); v_row bigint := public.kfp_debt_int(p, 'schedule_id');
  c public.credit_cards; pl public.installment_plans; pm public.debt_payments;
  cur text; k text := coalesce(p ->> 'kind', ''); amt bigint; pon date;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if crid is not null then
    select * into pm from public.debt_payments where user_id = uid and client_request_id = crid;
    if found then return to_jsonb(pm); end if;
  end if;
  if k not in ('full', 'partial', 'minimum', 'statement', 'early', 'extra_principal', 'settlement') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if v_card is null and v_plan is null then raise exception 'target_required' using errcode = '22023'; end if;
  if v_card is not null then c := public.kfp_debt_card(uid, v_card); cur := c.currency; end if;
  if v_plan is not null then
    select * into pl from public.installment_plans where id = v_plan and user_id = uid for update;
    if not found then raise exception 'plan_not_found' using errcode = 'P0002'; end if;
    -- installments on a card are paid by paying the card (never twice)
    if pl.card_id is not null then raise exception 'plan_on_card' using errcode = '22023'; end if;
    if v_card is not null then raise exception 'plan_on_card' using errcode = '22023'; end if;
    if pl.status = 'cancelled' then raise exception 'plan_closed' using errcode = '22023'; end if;
    cur := pl.currency;
    if v_row is not null and not exists (select 1 from public.installment_schedules where id = v_row and plan_id = pl.id) then
      raise exception 'row_not_found' using errcode = 'P0002';
    end if;
  elsif v_row is not null then
    raise exception 'row_not_found' using errcode = 'P0002';
  end if;
  if v_tr is not null and not exists (select 1 from public.debt_transfers where id = v_tr and user_id = uid) then
    raise exception 'transfer_not_found' using errcode = 'P0002';
  end if;
  amt := public.kfp_debt_int(p, 'amount_minor', null, true);
  if amt <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  pon := public.kfp_debt_date(p, 'paid_on', true);
  if pon > current_date + 366 then raise exception 'invalid_paid_on' using errcode = '22023'; end if;
  if (select count(*) from public.debt_payments where user_id = uid) >= 20000 then raise exception 'too_many_payments' using errcode = '54000'; end if;
  insert into public.debt_payments (user_id, client_request_id, card_id, plan_id, schedule_id, transfer_id, kind, currency, amount_minor,
    principal_minor, interest_minor, fee_minor, paid_on, method, notes)
  values (uid, crid, v_card, v_plan, v_row, v_tr, k, cur, amt,
    coalesce(public.kfp_debt_int(p, 'principal_minor'), 0), coalesce(public.kfp_debt_int(p, 'interest_minor'), 0),
    coalesce(public.kfp_debt_int(p, 'fee_minor'), 0), pon, coalesce(nullif(p ->> 'method', ''), 'bank_transfer'),
    public.kfp_debt_txt(p, 'notes', 500))
  returning * into pm;
  if k = 'settlement' and v_plan is not null and pl.status in ('active', 'paused') then
    update public.installment_plans set status = 'settled', status_date = pon, version = version + 1 where id = pl.id;
  end if;
  return to_jsonb(pm);
end;
$$;

create or replace function public.debt_cancel_payment(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); pm public.debt_payments;
begin
  select * into pm from public.debt_payments where id = p_id and user_id = uid for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0002'; end if;
  if pm.status = 'cancelled' then return to_jsonb(pm); end if;
  update public.debt_payments set status = 'cancelled' where id = pm.id returning * into pm;
  if pm.kind = 'settlement' and pm.plan_id is not null then
    update public.installment_plans set status = 'active', status_date = null, version = version + 1
    where id = pm.plan_id and status = 'settled' and status_date = pm.paid_on;
  end if;
  return to_jsonb(pm);
end;
$$;

-- ---------------------------------------------------------------------
-- 8. transfers (balances change only when confirmed; confirm is atomic)
-- ---------------------------------------------------------------------
create or replace function public.kfp_debt_confirm_transfer(p_id uuid)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare t public.debt_transfers; c public.credit_cards; v_plan uuid;
begin
  select * into t from public.debt_transfers where id = p_id for update;
  update public.debt_transfers set status = 'confirmed', confirmed_at = now(), version = version + 1 where id = t.id;
  if t.installments > 0 then
    select * into c from public.credit_cards where id = t.to_card_id;
    insert into public.installment_plans (user_id, card_id, transfer_id, currency, product, category, merchant, purchase_date,
      original_minor, down_minor, financed_minor, rate_bp, method, months, first_due_date, notes)
    values (t.user_id, t.to_card_id, t.id, t.dest_currency,
      left(case t.type when 'balance_transfer' then 'โอนหนี้ (Balance transfer)' when 'card_payment' then 'ใช้บัตรจ่ายบัตร'
                       when 'cash_advance' then 'กดเงินสด (Cash advance)' else 'ปรับโครงสร้างหนี้' end, 80),
      'โอนหนี้', left(coalesce(nullif(t.related_ref, ''), ''), 60), t.effective_date,
      t.dest_amount_minor, 0, t.dest_amount_minor, t.rate_bp, case when t.rate_bp = 0 then 'zero' else 'fixed' end,
      t.installments, (t.effective_date + interval '1 month')::date, '')
    returning id into v_plan;
    perform public.kfp_debt_write_schedule(v_plan, null);
  end if;
end;
$$;
revoke all on function public.kfp_debt_confirm_transfer(uuid) from public, anon, authenticated;

create or replace function public.debt_save_transfer(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := public.kfp_debt_write_guard();
  v_id uuid := public.kfp_debt_uuid(p, 'id');
  crid uuid := public.kfp_debt_uuid(p, 'client_request_id');
  v_from uuid := public.kfp_debt_uuid(p, 'from_card_id'); v_to uuid := public.kfp_debt_uuid(p, 'to_card_id');
  typ text := coalesce(p ->> 'type', ''); st text := coalesce(nullif(p ->> 'status', ''), 'draft');
  cf public.credit_cards; ct public.credit_cards; t public.debt_transfers; old public.debt_transfers;
  amt bigint; dest bigint; fee bigint; rate int; inst int; td date; ed date; fx numeric; fxd date; cur text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if v_id is null and crid is not null then
    select * into t from public.debt_transfers where user_id = uid and client_request_id = crid;
    if found then return to_jsonb(t); end if;
  end if;
  if typ not in ('balance_transfer', 'card_payment', 'cash_advance', 'restructure') then raise exception 'invalid_type' using errcode = '22023'; end if;
  if st not in ('draft', 'pending', 'confirmed') then raise exception 'invalid_status' using errcode = '22023'; end if;
  if v_to is null then raise exception 'to_card_required' using errcode = '22023'; end if;
  ct := public.kfp_debt_card(uid, v_to);
  if typ = 'cash_advance' then
    v_from := null;
  else
    if v_from is null then raise exception 'from_card_required' using errcode = '22023'; end if;
    cf := public.kfp_debt_card(uid, v_from);
    if v_from = v_to and typ <> 'restructure' then raise exception 'same_card' using errcode = '22023'; end if;
  end if;
  cur := coalesce(cf.currency, ct.currency);
  amt := public.kfp_debt_int(p, 'amount_minor', null, true);
  if amt <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  fee := coalesce(public.kfp_debt_int(p, 'fee_minor'), 0);
  rate := coalesce(public.kfp_debt_int(p, 'rate_bp'), 0);
  inst := coalesce(public.kfp_debt_int(p, 'installments'), 0);
  if fee < 0 or rate not between 0 and 10000 or inst not between 0 and 120 then raise exception 'invalid_request' using errcode = '22023'; end if;
  td := public.kfp_debt_date(p, 'transfer_date', true);
  ed := coalesce(public.kfp_debt_date(p, 'effective_date'), td);
  if cur = ct.currency then
    dest := amt; fx := null; fxd := null;
  else
    -- cross-currency: the member types the rate and the destination amount (snapshot kept on the row)
    dest := public.kfp_debt_int(p, 'dest_amount_minor');
    begin fx := nullif(btrim(coalesce(p ->> 'fx_rate', '')), '')::numeric; exception when others then fx := null; end;
    fxd := public.kfp_debt_date(p, 'fx_date');
    if dest is null or dest <= 0 or fx is null or fx <= 0 or fxd is null then raise exception 'fx_required' using errcode = '22023'; end if;
  end if;

  if v_id is null then
    if (cf.status = 'archived') or ct.status = 'archived' then raise exception 'card_archived' using errcode = '22023'; end if;
    if (select count(*) from public.debt_transfers where user_id = uid) >= 2000 then raise exception 'too_many_transfers' using errcode = '54000'; end if;
    insert into public.debt_transfers (user_id, client_request_id, type, from_card_id, to_card_id, currency, amount_minor, fee_minor, rate_bp,
      installments, transfer_date, effective_date, status, fx_rate, fx_source, fx_date, dest_currency, dest_amount_minor, related_ref, notes)
    values (uid, crid, typ, v_from, v_to, cur, amt, fee, rate, inst, td, ed, case when st = 'confirmed' then 'pending' else st end,
      fx, case when fx is null then null else coalesce(nullif(public.kfp_debt_txt(p, 'fx_source', 40), ''), 'manual') end, fxd,
      ct.currency, dest, public.kfp_debt_txt(p, 'related_ref', 60), public.kfp_debt_txt(p, 'notes', 500))
    returning * into t;
  else
    select * into old from public.debt_transfers where id = v_id and user_id = uid for update;
    if not found then raise exception 'transfer_not_found' using errcode = 'P0002'; end if;
    perform public.kfp_debt_check_version(p, old.version);
    if old.status not in ('draft', 'pending') then raise exception 'transfer_locked' using errcode = '22023'; end if;
    update public.debt_transfers set type = typ, from_card_id = v_from, to_card_id = v_to, currency = cur, amount_minor = amt,
      fee_minor = fee, rate_bp = rate, installments = inst, transfer_date = td, effective_date = ed,
      status = case when st = 'confirmed' then 'pending' else st end, fx_rate = fx,
      fx_source = case when fx is null then null else coalesce(nullif(public.kfp_debt_txt(p, 'fx_source', 40), ''), 'manual') end,
      fx_date = fxd, dest_currency = ct.currency, dest_amount_minor = dest,
      related_ref = public.kfp_debt_txt(p, 'related_ref', 60), notes = public.kfp_debt_txt(p, 'notes', 500), version = old.version + 1
    where id = old.id returning * into t;
  end if;
  if st = 'confirmed' then
    perform public.kfp_debt_confirm_transfer(t.id);
    select * into t from public.debt_transfers where id = t.id;
  end if;
  return to_jsonb(t);
end;
$$;

create or replace function public.debt_set_transfer_status(p_id uuid, p_status text, p_base_version bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); t public.debt_transfers;
begin
  select * into t from public.debt_transfers where id = p_id and user_id = uid for update;
  if not found then raise exception 'transfer_not_found' using errcode = 'P0002'; end if;
  if p_base_version is distinct from t.version then raise exception 'conflict' using errcode = '40001'; end if;
  if not ((t.status = 'draft' and p_status in ('pending', 'confirmed', 'cancelled'))
       or (t.status = 'pending' and p_status in ('draft', 'confirmed', 'failed', 'cancelled'))
       or (t.status = 'confirmed' and p_status = 'cancelled')) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if p_status = 'confirmed' then
    if exists (select 1 from public.credit_cards where id in (t.from_card_id, t.to_card_id) and status = 'archived') then
      raise exception 'card_archived' using errcode = '22023';
    end if;
    perform public.kfp_debt_confirm_transfer(t.id);
  else
    if t.status = 'confirmed' then
      -- reversal: balances recompute without it; a plan created from it is cancelled from its first day
      update public.installment_plans set status = 'cancelled', status_date = purchase_date - 1, version = version + 1
      where transfer_id = t.id and status <> 'cancelled';
    end if;
    update public.debt_transfers set status = p_status, version = version + 1 where id = t.id;
  end if;
  select * into t from public.debt_transfers where id = p_id;
  return to_jsonb(t);
end;
$$;

create or replace function public.debt_delete_transfer(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); t public.debt_transfers;
begin
  select * into t from public.debt_transfers where id = p_id and user_id = uid for update;
  if not found then raise exception 'transfer_not_found' using errcode = 'P0002'; end if;
  if t.status <> 'draft' then raise exception 'transfer_locked' using errcode = '22023'; end if;
  delete from public.debt_transfers where id = t.id;
  return jsonb_build_object('deleted', t.id);
end;
$$;

-- ---------------------------------------------------------------------
-- 9. adjustments / reconciliation
-- ---------------------------------------------------------------------
create or replace function public.debt_add_adjustment(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := public.kfp_debt_write_guard();
  crid uuid := public.kfp_debt_uuid(p, 'client_request_id');
  c public.credit_cards; a public.debt_adjustments; k text := coalesce(p ->> 'kind', ''); amt bigint; sb bigint;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if crid is not null then
    select * into a from public.debt_adjustments where user_id = uid and client_request_id = crid;
    if found then return to_jsonb(a); end if;
  end if;
  if k not in ('purchase', 'interest', 'fee', 'refund', 'reconcile', 'other') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  c := public.kfp_debt_card(uid, public.kfp_debt_uuid(p, 'card_id'));
  amt := public.kfp_debt_int(p, 'amount_minor', null, true);
  if k in ('purchase', 'interest', 'fee') then amt := abs(amt); elsif k = 'refund' then amt := -abs(amt); end if;
  if amt = 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  sb := public.kfp_debt_int(p, 'statement_balance_minor');
  if k = 'reconcile' and sb is null then raise exception 'statement_balance_required' using errcode = '22023'; end if;
  if (select count(*) from public.debt_adjustments where user_id = uid) >= 5000 then raise exception 'too_many_adjustments' using errcode = '54000'; end if;
  insert into public.debt_adjustments (user_id, client_request_id, card_id, kind, currency, amount_minor, effective_date, statement_balance_minor, notes)
  values (uid, crid, c.id, k, c.currency, amt, public.kfp_debt_date(p, 'effective_date', true),
          case when k = 'reconcile' then sb else null end, public.kfp_debt_txt(p, 'notes', 500))
  returning * into a;
  return to_jsonb(a);
end;
$$;

create or replace function public.debt_cancel_adjustment(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard(); a public.debt_adjustments;
begin
  update public.debt_adjustments set status = 'cancelled' where id = p_id and user_id = uid returning * into a;
  if not found then raise exception 'adjustment_not_found' using errcode = 'P0002'; end if;
  return to_jsonb(a);
end;
$$;

-- ---------------------------------------------------------------------
-- 10. payoff plans
-- ---------------------------------------------------------------------
create or replace function public.debt_save_payoff_plan(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  uid uuid := public.kfp_debt_write_guard();
  v_id uuid := public.kfp_debt_uuid(p, 'id');
  crid uuid := public.kfp_debt_uuid(p, 'client_request_id');
  x public.debt_payoff_plans; old public.debt_payoff_plans; cur text := upper(coalesce(p ->> 'currency', ''));
  strat text := coalesce(p ->> 'strategy', ''); bud bigint;
  pri jsonb := coalesce(p -> 'priorities', '[]'::jsonb); asm jsonb := coalesce(p -> 'assumptions', '{}'::jsonb);
  res jsonb := coalesce(p -> 'result', '{}'::jsonb);
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if v_id is null and crid is not null then
    select * into x from public.debt_payoff_plans where user_id = uid and client_request_id = crid;
    if found then return to_jsonb(x); end if;
  end if;
  if cur not in ('THB', 'KRW') then raise exception 'invalid_currency' using errcode = '22023'; end if;
  if strat not in ('snowball', 'avalanche', 'custom') then raise exception 'invalid_strategy' using errcode = '22023'; end if;
  if jsonb_typeof(pri) <> 'array' or jsonb_typeof(asm) <> 'object' or jsonb_typeof(res) <> 'object' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  bud := public.kfp_debt_int(p, 'budget_minor', null, true);
  if bud <= 0 then raise exception 'invalid_budget' using errcode = '22023'; end if;
  if v_id is null then
    if (select count(*) from public.debt_payoff_plans where user_id = uid) >= 50 then raise exception 'too_many_payoff_plans' using errcode = '54000'; end if;
    insert into public.debt_payoff_plans (user_id, client_request_id, name, strategy, currency, budget_minor, priorities, assumptions, result)
    values (uid, crid, public.kfp_debt_txt(p, 'name', 60), strat, cur, bud, pri, asm, res) returning * into x;
  else
    select * into old from public.debt_payoff_plans where id = v_id and user_id = uid for update;
    if not found then raise exception 'payoff_not_found' using errcode = 'P0002'; end if;
    perform public.kfp_debt_check_version(p, old.version);
    update public.debt_payoff_plans set name = public.kfp_debt_txt(p, 'name', 60), strategy = strat, currency = cur, budget_minor = bud,
      priorities = pri, assumptions = asm, result = res, version = old.version + 1
    where id = old.id returning * into x;
  end if;
  return to_jsonb(x);
end;
$$;

create or replace function public.debt_delete_payoff_plan(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare uid uuid := public.kfp_debt_write_guard();
begin
  delete from public.debt_payoff_plans where id = p_id and user_id = uid;
  if not found then raise exception 'payoff_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('deleted', p_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 11. grants for the browser API (signed-in members only)
-- ---------------------------------------------------------------------
revoke all on function public.get_my_debt_access() from public, anon;
grant execute on function public.get_my_debt_access() to authenticated;
revoke all on function public.export_my_debt() from public, anon;
grant execute on function public.export_my_debt() to authenticated;
revoke all on function public.debt_save_card(jsonb) from public, anon;
grant execute on function public.debt_save_card(jsonb) to authenticated;
revoke all on function public.debt_set_card_status(uuid, text, bigint) from public, anon;
grant execute on function public.debt_set_card_status(uuid, text, bigint) to authenticated;
revoke all on function public.debt_delete_card(uuid) from public, anon;
grant execute on function public.debt_delete_card(uuid) to authenticated;
revoke all on function public.debt_save_installment(jsonb) from public, anon;
grant execute on function public.debt_save_installment(jsonb) to authenticated;
revoke all on function public.debt_set_installment_status(uuid, text, bigint, date) from public, anon;
grant execute on function public.debt_set_installment_status(uuid, text, bigint, date) to authenticated;
revoke all on function public.debt_delete_installment(uuid) from public, anon;
grant execute on function public.debt_delete_installment(uuid) to authenticated;
revoke all on function public.debt_confirm_schedule(bigint, bigint) from public, anon;
grant execute on function public.debt_confirm_schedule(bigint, bigint) to authenticated;
revoke all on function public.debt_record_payment(jsonb) from public, anon;
grant execute on function public.debt_record_payment(jsonb) to authenticated;
revoke all on function public.debt_cancel_payment(uuid) from public, anon;
grant execute on function public.debt_cancel_payment(uuid) to authenticated;
revoke all on function public.debt_save_transfer(jsonb) from public, anon;
grant execute on function public.debt_save_transfer(jsonb) to authenticated;
revoke all on function public.debt_set_transfer_status(uuid, text, bigint) from public, anon;
grant execute on function public.debt_set_transfer_status(uuid, text, bigint) to authenticated;
revoke all on function public.debt_delete_transfer(uuid) from public, anon;
grant execute on function public.debt_delete_transfer(uuid) to authenticated;
revoke all on function public.debt_add_adjustment(jsonb) from public, anon;
grant execute on function public.debt_add_adjustment(jsonb) to authenticated;
revoke all on function public.debt_cancel_adjustment(uuid) from public, anon;
grant execute on function public.debt_cancel_adjustment(uuid) to authenticated;
revoke all on function public.debt_save_payoff_plan(jsonb) from public, anon;
grant execute on function public.debt_save_payoff_plan(jsonb) to authenticated;
revoke all on function public.debt_delete_payoff_plan(uuid) from public, anon;
grant execute on function public.debt_delete_payoff_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 12. security self-check: allowlist the new RPCs
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
                           'debt_save_payoff_plan', 'debt_delete_payoff_plan'];
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
