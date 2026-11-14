-- =====================================================================
-- Korea Finance Planner · Remove privileges that Supabase's default ACL
-- hands to anon/authenticated on every new table (production, 14/11/2026)
--
-- The live project's default privileges give anon + authenticated
-- TRUNCATE / REFERENCES / TRIGGER (and MAINTAIN on PG17) on each table that
-- postgres creates. Migrations that used "revoke all" are clean; plans,
-- subscriptions and user_entitlements only revoked insert/update/delete, so
-- kfp_security_report() flagged TRUNCATE. PostgREST cannot issue TRUNCATE,
-- but nothing should hold it. Also stop new tables from getting it.
-- Additive & re-runnable.
-- =====================================================================
revoke truncate, references, trigger on public.plans, public.subscriptions, public.user_entitlements from anon, authenticated;
revoke all on public.subscriptions, public.user_entitlements from anon;

do $$ begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.plans, public.subscriptions, public.user_entitlements from anon, authenticated';
  end if;
end $$;

-- future tables created by postgres in public: no TRUNCATE/REFERENCES/TRIGGER for API roles
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
