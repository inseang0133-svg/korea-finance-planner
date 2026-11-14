-- =====================================================================
-- Korea Finance Planner · Legacy launch grant (Decision 7.1)
-- Every account that exists when this runs gets Finance Premium for 90
-- days (via user_entitlements), then falls back to its real plan (Free
-- unless it subscribes). No data is touched.
--
-- Run this ON LAUNCH DAY in production (the 90 days start when it runs).
-- Re-running is safe: one legacy grant per user (unique index).
-- =====================================================================
insert into public.user_entitlements (user_id, plan_id, starts_at, expires_at, reason, note)
select p.user_id, 'premium', now(), now() + interval '90 days', 'legacy_launch',
       'สมาชิกเดิมก่อนเปิดระบบสมาชิก: Premium ฟรี 90 วัน'
from public.profiles p
where p.created_at < now()
on conflict do nothing;
