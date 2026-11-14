# Setup Guide (Staging → Production)

ทำบน **Staging** ให้ผ่านก่อนทุกครั้ง แล้วค่อยทำซ้ำบน Production
อัปเดตทุก Phase · ล่าสุด: **Phase 7**

---

> **ทางลัด:** ทุก migration รวมอยู่ใน `supabase/install_all.sql` (ไม่รวม 0200) — วางไฟล์เดียวใน SQL Editor แทนการรันทีละไฟล์ได้ · ลำดับเปิดระบบทั้งหมดดู `docs/GO_LIVE.md`

## Phase 2 · Email Authentication + บัญชีเดิม

### 1. Staging project
1. สร้าง Supabase project ใหม่ (Staging)
2. SQL Editor → รัน `supabase_schema.sql` (schema เดิม เพื่อจำลอง production)
3. รันไฟล์ใน `supabase/migrations/` ตามลำดับชื่อ **ยกเว้น** `…000200_legacy_launch_grant.sql`
   - `20261113000100_saas_core_auth.sql`
   - `20261113000300_rate_limits.sql`
4. (ทดสอบ migration บัญชีเก่า) สร้างผู้ใช้ทดสอบแบบเก่าใน Authentication → Add user: `testold@kfp.example.com` + รหัส, ติ๊ก Auto confirm

### 2. Authentication settings (Dashboard → Authentication)
| ที่ | ค่า | เหตุผล |
|---|---|---|
| Sign In / Providers → Email → **Confirm email** | ON | บังคับยืนยันอีเมลก่อนใช้งาน |
| Sign In / Providers → Email → **Secure email change** | **OFF** | บัญชีเก่า `@kfp.example.com` รับอีเมลที่อยู่เก่าไม่ได้ ถ้าเปิดไว้จะเชื่อมอีเมลจริงไม่สำเร็จ (ต้องยืนยันเฉพาะอีเมลใหม่) |
| Sign In / Providers → Email → Minimum password length | 8 | ตรงกับเงื่อนไขในหน้าเว็บ |
| Attack Protection → Leaked password protection | ON (ถ้าแพ็กเกจรองรับ) | |
| URL Configuration → **Site URL** | `https://inseang0133-svg.github.io/korea-finance-planner/` | |
| URL Configuration → **Redirect URLs** | `https://inseang0133-svg.github.io/korea-finance-planner/auth-callback.html` (+ URL staging/localhost ที่ใช้ทดสอบ) | ลิงก์ยืนยัน/รีเซ็ตรหัส/เปลี่ยนอีเมล |
| Emails → **SMTP Settings** | Custom SMTP (Resend / Brevo / Amazon SES …) + โดเมนผู้ส่งที่ยืนยัน SPF/DKIM แล้ว | SMTP เริ่มต้นของ Supabase ส่งได้เฉพาะอีเมลทีมโปรเจกต์ 2 ฉบับ/ชม. ลูกค้าจริงจะไม่ได้รับอีเมล |
| Emails → Templates | แก้ข้อความเป็นภาษาไทยได้ (Confirm signup / Reset password / Change email address) | ไม่บังคับ |

> ⚠️ เปิด **Confirm email** หลัง deploy เว็บเวอร์ชันใหม่แล้วเท่านั้น — เว็บเวอร์ชันเก่าสมัครด้วยอีเมลปลอมซึ่งยืนยันไม่ได้

### 3. Edge Function `username-login`
```bash
supabase link --project-ref <staging-ref>
supabase secrets set ALLOWED_ORIGINS="https://inseang0133-svg.github.io,http://localhost:8765"
supabase functions deploy username-login --no-verify-jwt
```
- `--no-verify-jwt` จำเป็น เพราะผู้ใช้ยังไม่ได้ login ตอนเรียก
- ถ้ายังไม่ deploy เว็บจะ fallback ไปใช้วิธีเดิม (`username@kfp.example.com`) ให้บัญชีเก่ายังเข้าได้ แต่บัญชีที่เชื่อมอีเมลจริงแล้วจะ login ด้วย username ไม่ได้จนกว่าจะ deploy

### 4. Frontend
- อัปโหลดไฟล์ที่เปลี่ยน: `auth.js`, `auth-callback.html`, `index.html`, `gold.html`, `sw.js`, `supabase_schema.sql`
- Staging ชี้ `supabase-config.js` ไปที่ project staging (อย่า commit ค่า staging ทับ production)

### 5. Production (วันเปิดระบบ)
1. Backup: Dashboard → Database → Backups (หรือ `pg_dump`) ก่อนรันอะไรทั้งหมด
2. รัน migrations 0100, 0300
3. Deploy เว็บ + Edge Function
4. ตั้ง Auth settings ตามข้อ 2 (Confirm email เปิดเป็นอย่างสุดท้าย)
5. รัน `20261113000200_legacy_launch_grant.sql` **ในวันที่ต้องการเริ่มนับ 90 วัน**

### Rollback
Migration เป็นแบบเพิ่มอย่างเดียว ไม่ต้อง rollback ข้อมูล ถ้าต้องถอยหน้าเว็บ ให้ deploy `auth.js` เดิมกลับ แล้วปิด Confirm email (บัญชีที่สมัครด้วยอีเมลจริงไปแล้วยังใช้งานได้ด้วยอีเมล+รหัสผ่าน)

---

## Phase 3 · Preview Mode
ไม่มีการตั้งค่าฝั่ง Supabase · อัปโหลดไฟล์:
`kfp-storage.js`, `kfp-demo-data.js`, `kfp-access.js`, `kfp-access.css`, `auth.js`, `pwa-persistence.js`, `index.html`, `gold.html`, `auth-callback.html`, `sw.js`

**สิ่งที่จะเกิดกับผู้ใช้เดิมตอนเปิดเว็บเวอร์ชันนี้ครั้งแรก (อัตโนมัติ ไม่มีข้อมูลหาย):**
- เครื่องที่ Login อยู่ → ข้อมูลในเครื่องย้ายเข้าช่องของบัญชีนั้น ใช้งานต่อได้เหมือนเดิม
- เครื่องที่ใช้แบบไม่ Login → ข้อมูลเดิมถูกเก็บเป็น “ข้อมูลเดิมในเครื่อง” หน้าเว็บจะแสดง Demo แทน · เมื่อสมัคร/Login แล้วเปิด 👤 บัญชีของฉัน จะมีปุ่ม **📥 นำเข้าบัญชีนี้**
- ⚠️ ควรประกาศให้ผู้ใช้เดิมที่ไม่เคย Login รู้เรื่องนี้ก่อนอัปเดต

---

## Phase 4 · Login Gate
ไม่มีการตั้งค่าฝั่ง Supabase · อัปโหลด: `kfp-access.js`, `kfp-access.css`, `auth.js`, `index.html`, `gold.html`, `sw.js`
เพิ่มปุ่มใหม่ที่บันทึกข้อมูลในอนาคต: ใส่ `data-requires-auth="ชื่อฟีเจอร์"` ที่ปุ่ม หรือเรียก `if (!requireAuth("ชื่อฟีเจอร์")) return;` ก่อนบันทึก

---

## Phase 5 · Plan-Based Visibility
1. SQL Editor → รัน `supabase/migrations/20261113000400_entitlements.sql` (Staging ก่อน)
2. อัปโหลด: `kfp-access.js`, `kfp-access.css`, `auth.js`, `index.html`, `gold.html`, `pricing.html`, `tools-ui.js`, `tools.css`, `floating-nav.js`, `sw.js`
3. ทดสอบบน Staging: ให้สิทธิ์ทดสอบด้วย SQL (ไม่ต้องมี Stripe)
```sql
-- ให้ user ทดสอบเป็น Plus 30 วัน
insert into public.user_entitlements (user_id, plan_id, expires_at, reason)
select user_id, 'plus', now() + interval '30 days', 'admin_grant' from public.profiles where username = 'ชื่อทดสอบ';
-- ถอน
update public.user_entitlements set revoked_at = now() where reason = 'admin_grant' and user_id = (select user_id from public.profiles where username = 'ชื่อทดสอบ');
```
4. ปรับฟีเจอร์ของแพ็กเกจ (ไม่ต้องแก้โค้ด) เช่น ให้ Free เห็นกราฟ:
```sql
update public.plans set features = features || '{"advanced_statistics": true}' where id = 'free';
```

---

## Phase 6 · Subscription Database
1. SQL Editor → รัน `supabase/migrations/20261113000500_billing_admin.sql`
2. **ตั้ง owner คนแรก (ทำครั้งเดียว ด้วย SQL เท่านั้น):**
```sql
insert into public.admin_roles (user_id, role, note)
select user_id, 'owner', 'เจ้าของระบบ' from public.profiles where username = 'username-ของคุณ';
```
   เพิ่ม admin/viewer คนอื่นแบบเดียวกัน (role = 'admin' หรือ 'viewer') · ถอนสิทธิ์: `delete from public.admin_roles where user_id = ...`
3. **เปลี่ยน/ตั้งราคา** — รันใน SQL Editor ได้เลย (ในอนาคตทำจากหน้า Admin ใน Phase 10) · ทุกครั้งถูกบันทึกใน `admin_audit_logs`
```sql
-- จำนวนเงินเป็นหน่วยย่อย: THB = สตางค์ (149 บาท = 14900), KRW = วอน (59,000 วอน = 59000)
select public.admin_set_price('plus',    'year', 'KRW', 59000, 'ตั้งราคารายปีสกุลวอน');
select public.admin_set_price('premium', 'year', 'KRW', 89000, 'ตั้งราคารายปีสกุลวอน');
-- ดูราคาที่ใช้อยู่
select plan_id, billing_interval, currency, amount_minor from public.plan_prices where active order by 1,2,3;
```
4. (ไม่บังคับ) ลบ activity เก่ากว่า 180 วันทุกวันด้วย pg_cron: `select cron.schedule('kfp-prune', '17 3 * * *', $$select public.kfp_prune_activity(180)$$);`
5. อัปโหลด: `pricing.html`, `kfp-access.js`, `index.html`, `gold.html`, `sw.js`

---

## Phase 7 · Stripe (Test mode)

> ทำบน **Staging + Stripe Test mode** เท่านั้นจนกว่าจะทดสอบครบ · ⚠️ ดูข้อจำกัดประเทศของบัญชี Stripe ใน `docs/SAAS_PLAN.md` ข้อ 9

### 1. ฐานข้อมูล
SQL Editor → รัน `supabase/migrations/20261113000600_stripe.sql`

### 2. Stripe Dashboard (Test mode)
1. **API keys** → คัดลอก Secret key (`sk_test_…`) — ห้ามใส่ในไฟล์เว็บ
2. **Customer portal** (Settings → Billing → Customer portal) เปิด:
   - Cancel subscriptions → *At end of billing period*
   - Switch plans → เพิ่ม Products `kfp_plus` และ `kfp_premium` พร้อมทุก Price (Product/Price ถูกสร้างอัตโนมัติตอน Checkout ครั้งแรกของแต่ละราคา → ทำ Checkout ทดสอบแต่ละแพ็กเกจก่อน แล้วค่อยกลับมาเลือก)
   - Update payment methods, Invoice history → เปิด
3. **Emails** (Settings → Billing → Subscriptions and emails): เปิด *upcoming renewal reminders* (กฎเกาหลี: แจ้งก่อนตัดเงิน 7 วัน), *failed payment* และ *receipts*
4. (ถ้าต้องการกล่อง "ยอมรับเงื่อนไข" ใน Checkout) Settings → Public details → ใส่ Terms of service URL แล้วตั้ง secret `CHECKOUT_REQUIRE_TOS=1`
5. **Webhooks** → Add endpoint
   - URL: `https://<staging-ref>.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `charge.refunded`
   - คัดลอก Signing secret (`whsec_…`)

### 3. Secrets + Deploy
```bash
supabase link --project-ref <staging-ref>
supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx STRIPE_WEBHOOK_SECRET=whsec_xxx \
  SITE_URL=https://inseang0133-svg.github.io/korea-finance-planner \
  ALLOWED_ORIGINS="https://inseang0133-svg.github.io,http://localhost:8765"
# ไม่บังคับ: CHECKOUT_REQUIRE_TOS=1  STRIPE_PORTAL_CONFIGURATION=bpc_xxx
supabase functions deploy create-checkout
supabase functions deploy create-portal
supabase functions deploy stripe-webhook --no-verify-jwt
```
อัปโหลดหน้าเว็บ: `pricing.html`, `kfp-access.js`, `sw.js`

### 4. ทดสอบ (ทำตามลำดับ แล้วดูผลในตาราง `subscriptions`, `payments`, `stripe_webhook_events`)
| # | ทำอะไร | ควรเห็น |
|---|---|---|
| 1 | บัญชี Free → Pricing → สมัคร Plus (บาท/เดือน) → บัตร `4242 4242 4242 4242` วันหมดอายุอนาคต CVC ใดก็ได้ | กลับมาหน้า Pricing "ชำระเงินสำเร็จ" ภายในไม่กี่วินาที · subscriptions = active · payments = paid · ฟีเจอร์ Plus โผล่ |
| 2 | กด "สมัคร" ซ้ำอีกแพ็กเกจ | ขึ้นข้อความให้ใช้หน้าจัดการบิล (ไม่เกิด subscription ซ้อน) |
| 3 | จัดการแพ็กเกจ → เปลี่ยนเป็น Premium | plan = premium, หน้าทองเปิดได้ |
| 4 | จัดการแพ็กเกจ → Cancel | ยังเป็น Premium จนสิ้นรอบ (`cancel_at_period_end = true`) · Renew ในพอร์ตได้ |
| 5 | Stripe → Customers → เปลี่ยนบัตรเป็น `4000 0000 0000 0341` แล้วใช้ **Test clock** เลื่อนเวลาข้ามรอบบิล | payments = failed + เหตุผล · subscriptions = past_due · ยังใช้ได้ 7 วัน |
| 6 | บัตร 3D Secure `4000 0025 0000 3155` | payments = action_required |
| 7 | Stripe → Payments → Refund บางส่วน | payments = partially_refunded + แถวใน payment_refunds |
| 8 | Stripe → Webhooks → endpoint → **Resend** event เดิม | ตอบ 200 `duplicate` · ข้อมูลไม่ซ้ำ |
| 9 | บัญชีเก่า `@kfp.example.com` กดสมัคร | ขึ้นให้เชื่อมอีเมลจริงก่อน |
| 10 | Checkout บาท/วอน รายปี | ราคาตรงกับ `plan_prices` (วอนไม่คูณ 100) |
Stripe CLI (ไม่บังคับ): `stripe listen --forward-to https://<ref>.supabase.co/functions/v1/stripe-webhook` · `stripe trigger invoice.payment_failed`

### 5. ขึ้น Production (Live)
- ใช้ Supabase project production ที่ **ยังไม่เคยมี Stripe test id** (staging กับ production แยกกันอยู่แล้ว) · ถ้าเคยใช้ test key กับฐานข้อมูลนี้ ต้องล้างก่อน:
  `update public.plan_prices set provider_price_id = null; delete from public.billing_customers;` (และลบ subscriptions/payments ที่เป็นข้อมูลทดสอบ)
- ทำข้อ 2–3 ซ้ำใน **Live mode** ด้วย `sk_live_…` และ webhook secret ของ live endpoint

## Phase 8 · หน้า Billing ของสมาชิก

1. SQL Editor → รัน `supabase/migrations/20261114000700_billing_page.sql`
2. Stripe → **Customer portal**: ตรวจว่าเปิด *Switch plans* (ใส่ `kfp_plus`, `kfp_premium` ครบทุก Price ที่ใช้อยู่) และ *Update payment methods* แล้ว (ตั้งไว้ตั้งแต่ Phase 7)
3. Deploy:
```bash
supabase functions deploy create-portal
supabase functions deploy billing-action
```
4. อัปโหลดหน้าเว็บ: `account.html`, `pricing.html`, `auth.js`, `sw.js`, `index.html`, `gold.html`

### ทดสอบบน Test mode (ต่อจาก checklist Phase 7)
| # | ทำอะไร | ควรเห็น |
|---|---|---|
| 11 | สมาชิก Plus → หน้าต่างบัญชี → "แพ็กเกจและใบเสร็จ" | แพ็กเกจ, วันตัดเงินถัดไป = `current_period_end`, ต่ออายุอัตโนมัติ เปิด, ใบเสร็จรายการแรกเปิดได้ |
| 12 | กด "อัปเกรดเป็น Finance Premium · รายเดือน" | หน้า Stripe แสดงยอดตามสัดส่วน → ยืนยัน → กลับมา "เปลี่ยนแพ็กเกจเรียบร้อย" และเป็น Premium ภายในไม่กี่วินาที |
| 13 | "ยกเลิกการต่ออายุ" → ยืนยัน | สถานะ "ยกเลิกแล้ว · ใช้ได้ถึง …" ทันที · Stripe แสดง *Cancels on …* · ยังใช้ Premium ได้ |
| 14 | "ต่ออายุอัตโนมัติอีกครั้ง" | กลับเป็นใช้งานอยู่ · Stripe ไม่มี *Cancels on* |
| 15 | "เปลี่ยนบัตร" | เปิดหน้ากรอกบัตรใหม่ของ Stripe โดยตรง แล้วกลับมาที่ account.html |

## Phase 9 · Gold Premium Protection

> ⚠️ ลำดับสำคัญ: **รัน migration ก่อน** แล้วจึงอัปโหลดหน้าเว็บ

1. (แนะนำ) Dashboard → Database → Backups: ตรวจว่ามี backup ล่าสุด
2. SQL Editor → รัน `supabase/migrations/20261114000800_gold_premium.sql`
3. ตรวจผล:
```sql
select count(*) from public.user_gold_data;                                         -- จำนวนสมาชิกที่มีข้อมูลทอง
select count(*) from public.user_data where data ?| array['kfp_gold_lots_v1','kfp_gold_settings_v1'];   -- ต้องเป็น 0
select * from public.user_gold_legacy_raw;                                           -- ค่าที่ parse ไม่ได้ (ปกติว่าง)
```
4. อัปโหลดหน้าเว็บ: `kfp-gold-sync.js`, `gold.js`, `gold.html`, `auth.js`, `kfp-config.js`, `kfp-access.css`, `sw.js`, `index.html`, `pricing.html`, `account.html`

### ทดสอบบน staging
| # | ทำอะไร | ควรเห็น |
|---|---|---|
| 1 | Premium เปิด gold.html | ป้าย "☁️ ซิงก์กับ Cloud แล้ว" · ตาราง `user_gold_data` มีแถวของบัญชี |
| 2 | เพิ่มรอบซื้อ | ป้ายขึ้น "กำลังบันทึก" แล้ว "ซิงก์แล้ว" · `version` เพิ่ม 1 |
| 3 | เปิดอีกเครื่อง/อีก browser ด้วยบัญชีเดียวกัน | เห็นรอบซื้อเดียวกัน |
| 4 | แก้ทั้ง 2 เครื่องตอนออฟไลน์ แล้วต่อเน็ต | เครื่องที่ส่งทีหลังขึ้นกล่อง "ข้อมูลไม่ตรงกัน" ให้เลือก |
| 5 | บัญชี Plus เปิด gold.html | หน้าอัปเกรด + "พอร์ตทองของคุณ N รอบยังเก็บไว้" (ถ้ามี) |
| 6 | บัญชี Plus ลองเรียกตรงใน Console: `kfpAuth.client().rpc('save_my_gold',{p_lots:[],p_settings:{},p_base_version:null})` | error `premium_required` |
| 7 | บัญชี Plus: `kfpAuth.client().from('user_gold_data').select('*')` | ได้ `[]` |

## Phase 10 · Admin Dashboard

1. SQL Editor → รัน `supabase/migrations/20261114000900_admin_dashboard.sql`
2. ผู้ดูแลคนแรก (ถ้ายังไม่ได้ทำใน Phase 6): ดู Phase 6 ข้อ 2 — `role = 'owner'` สำหรับเจ้าของ, `'admin'` จัดการได้, `'viewer'` ดูอย่างเดียว
3. Deploy: `supabase functions deploy admin-actions`
4. อัปโหลด: `admin.html`, `admin.js`, `admin.css`, `auth.js`, `sw.js`, `index.html`, `gold.html`, `pricing.html`, `account.html`
5. เปิด `https://<เว็บ>/admin.html` (หรือหน้าต่างบัญชี → "🛡️ Admin")

### ตรวจบน staging
| # | ทำอะไร | ควรเห็น |
|---|---|---|
| 1 | บัญชีที่ไม่ใช่ผู้ดูแลเปิด admin.html | "ไม่มีสิทธิ์เข้าหน้านี้" |
| 2 | Console ของบัญชีนั้น: `kfpAuth.client().rpc('admin_list_users',{p:{}})` | error `forbidden` |
| 3 | Owner → สมาชิก → เลือกบัญชีทดสอบ → ให้ Premium 30 วัน | สมาชิกเห็นหน้าทองได้ · Audit log มีรายการ `plan.grant` |
| 4 | ยกเลิก subscription (สิ้นรอบ) ของบัญชีทดสอบใน Test mode | Stripe แสดง *Cancels on …* · สถานะ "ตั้งยกเลิก" |
| 5 | ราคา → ตั้ง Plus รายปี KRW | การ์ด Pricing แสดงราคาวอนรายปี · Checkout ใช้ราคาใหม่ |
| 6 | ตัวเลข MRR ในภาพรวม เทียบกับ Stripe → Billing → Subscriptions | ตรงกัน (แยกสกุลเงิน) |

> ⚠️ ห้ามใส่ admin.html ลงในเมนูสาธารณะ · การป้องกันจริงอยู่ที่ฐานข้อมูล แต่ไม่จำเป็นต้องโฆษณาหน้า

## Phase 11 · Activity Monitoring & Analytics

1. SQL Editor → รัน `supabase/migrations/20261114001000_activity_analytics.sql` (สร้างสรุปรายวันจาก log เดิมให้อัตโนมัติ)
2. (แนะนำ) Dashboard → Database → Extensions → เปิด **pg_cron** แล้วรัน:
```sql
select cron.schedule('kfp-activity-maintenance', '15 4 * * *', $$ select public.kfp_activity_maintenance(90, 400) $$);
-- ตรวจ: select * from cron.job;   ยกเลิก: select cron.unschedule('kfp-activity-maintenance');
```
   (เก็บ log ดิบ 90 วัน, สรุปรายวัน 400 วัน, ล้าง rate_limits เก่า · 04:15 UTC = 13:15 เวลาเกาหลี)
3. อัปโหลด: `kfp-access.js`, `admin.html`, `admin.js`, `admin.css`, `sw.js`, `index.html`, `gold.html`, `pricing.html`, `account.html`
4. ตรวจ: ใช้งานเว็บด้วยบัญชีทดสอบสัก 2–3 นาที (เปิดรายจ่าย/บันทึกงาน) → Admin → 📈 การใช้งาน → กด "คำนวณใหม่" → DAU ≥ 1 และฟีเจอร์ขึ้นในตาราง
5. นโยบายความเป็นส่วนตัว: แจ้งว่าเก็บ "ชื่อหน้า/ฟีเจอร์ที่ใช้และเวลา" (ไม่เก็บเนื้อหาหรือ IP) เพื่อปรับปรุงบริการ

## Phase 12 · Security hardening

1. SQL Editor → รัน `supabase/migrations/20261114001100_security_hardening.sql`
2. `select * from public.kfp_security_report();` → ต้องว่าง (หรือเหลือ `INFO no_owner` ถ้ายังไม่ได้ตั้ง owner) · **รันซ้ำทุกครั้งหลังเพิ่ม migration**
3. Deploy Edge Functions ใหม่ทุกตัว (ล็อกเวอร์ชัน supabase-js):
```bash
for f in username-login stripe-webhook; do supabase functions deploy $f --no-verify-jwt; done
for f in create-checkout create-portal billing-action admin-actions; do supabase functions deploy $f; done
```
4. อัปโหลดเว็บ: `auth.js`, `kfp-storage.js`, `pricing.html`, `account.html`, `admin.html`, `admin.js`, `index.html`, `gold.html`, `auth-callback.html`, `sw.js`
5. ตรวจ: หน้าต่างบัญชี → แก้ชื่อเล่น → "บันทึกชื่อ" ต้องสำเร็จ (ก่อน Phase 12 ล้มเหลวบน Supabase จริง) · ปุ่ม "🧹 ออกจากระบบและลบข้อมูลบัญชีนี้ออกจากเครื่องนี้" ทำงาน
6. ก่อนเปิดขาย: ทำ `docs/GO_LIVE.md` ทุกข้อ (รวม SRI)
