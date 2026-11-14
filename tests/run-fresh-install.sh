#!/usr/bin/env bash
# Simulates the real install on an EMPTY database, exactly as docs/GO_LIVE.md says:
#   supabase_schema.sql → supabase/install_all.sql (twice) → launch grant → kfp_security_report() must be clean.
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -X -q -v ON_ERROR_STOP=1"
tools/build-install-sql.sh >/dev/null
$P -d postgres -c "drop database if exists kfp_fresh" -c "create database kfp_fresh" >/dev/null
$P -d kfp_fresh -f tests/sql/00_supabase_stub.sql >/dev/null 2>&1
# an existing member from before the SaaS upgrade (old fake e-mail, cloud data with gold)
$P -d kfp_fresh -f supabase_schema.sql >/dev/null 2>&1
$P -d kfp_fresh -f tests/sql/fresh_seed.sql >/dev/null
$P -d kfp_fresh -f supabase/install_all.sql >/dev/null 2>&1 && echo "install_all.sql: OK (1st run)"
$P -d kfp_fresh -f supabase/install_all.sql >/dev/null 2>&1 && echo "install_all.sql: OK (2nd run, re-runnable)"
$P -d kfp_fresh -f supabase/migrations/20261113000200_legacy_launch_grant.sql >/dev/null 2>&1 && echo "launch grant: OK"
$P -d kfp_fresh -At -c "select 'tables: ' || count(*) from pg_tables where schemaname='public'" \
  -c "select 'old member kept: ' || (select data->>'salary' from public.user_data where user_id='e1000000-0000-0000-0000-000000000001') || ' · gold moved: ' || (select jsonb_array_length(lots) from public.user_gold_data where user_id='e1000000-0000-0000-0000-000000000001') || ' lot · plan: ' || (select plan_id from public.kfp_effective_plan('e1000000-0000-0000-0000-000000000001'))" \
  -c "select 'profiles: ' || (select count(*) from public.profiles) || '/' || (select count(*) from auth.users) || ' · no-profile accounts → ' || (select string_agg(username || case when is_legacy_email then ' (legacy)' else '' end, ', ' order by username) from public.profiles where user_id in ('e1000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000003')) || ' · launch grants: ' || (select count(*) from public.user_entitlements where reason='legacy_launch')" \
  -c "select 'security findings: ' || count(*) || coalesce(' → ' || string_agg(check_name || ' ' || object, ', '), '') from public.kfp_security_report() where severity <> 'INFO'"

# Same, on a replica of the REAL production schema (tables + RLS only, no functions/triggers, broad anon grants)
$P -d postgres -c "drop database if exists kfp_prodlike" -c "create database kfp_prodlike" >/dev/null
$P -d kfp_prodlike -f tests/sql/00_supabase_stub.sql >/dev/null 2>&1
$P -d kfp_prodlike -f tests/sql/prod_replica_schema.sql >/dev/null
$P -d kfp_prodlike -f supabase/install_all.sql >/dev/null 2>&1 && echo "prod-like: install_all.sql OK"
$P -d kfp_prodlike -f supabase/install_all.sql >/dev/null 2>&1 && echo "prod-like: install_all.sql OK (2nd run)"
$P -d kfp_prodlike -At \
  -c "select 'prod-like: profiles ' || (select count(*) from public.profiles) || '/' || (select count(*) from auth.users) || ' · gold moved: ' || (select count(*) from public.user_gold_data) || ' · anon grants left: ' || (select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('profiles','user_data') and grantee='anon')" \
  -c "select 'prod-like security findings: ' || count(*) from public.kfp_security_report() where severity <> 'INFO'"
